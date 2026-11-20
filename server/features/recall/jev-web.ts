// Jev's web trips, kept. Every search Ask Jev runs ("Search the web", websearch.ts) appends one line
// to data/jev-web.jsonl: when, the question, and the top 5 results as {title, url}. This module
// writes that line and reads the file back as a small BM25 index, so recall (Ask Jev's panel), the
// voice brain and the president can cite what Jev found before instead of forgetting it.
//
// Web titles and URLs are UNTRUSTED third-party text. On the way in and again on the way out:
// http(s) URLs only, one line, capped, token shapes redacted, and anything the credential rules
// (credential-scan-lib.ts's scanText, the rules the voice brain vets notes with) flag is dropped
// (a hit) or withheld (the question). Callers that put a find in a prompt also check it against
// the value taint (their scanner) and fence it. Nothing here ever makes a web call.

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSecrets } from "../../heuristics.js";
import { isRecord } from "../../http.js";
import { scanText } from "../credential-scan-lib.js";
import { TIER_SPOKEN, type TaintSet } from "../credential-taint-lib.js";
import { bm25Scores, buildIndex, rankedChunkIndices, tokenize, type BM25Index } from "./bm25.js";

export const JEV_WEB_FILE = "jev-web.jsonl";
/** Results kept per search (websearch.ts's MAX_HITS). */
export const JEV_WEB_HITS = 5;
const TITLE_MAX = 200;
const URL_MAX = 2048;
const QUESTION_MAX = 300;
/** What a kept question says when the credential rules flagged it. */
export const WITHHELD_QUESTION = "(withheld: it looked like it held a credential)";

export interface JevWebHit {
  title: string;
  url: string;
}

export interface JevWebEntry {
  /** ISO time of the search. */
  at: string;
  question: string;
  hits: JevWebHit[];
}

/** One kept result, as recall serves it. */
export interface JevWebFind {
  title: string;
  url: string;
  host: string;
  question: string;
  at: string;
  score: number;
  /** Distinct words of the query found in its title, question or host. */
  matched: number;
}

export interface JevWebStats {
  trips: number;
  since: string | null;
  last: string | null;
}

export function jevWebPath(dataDir: string): string {
  return join(dataDir, JEV_WEB_FILE);
}

/** True when the credential rules flag the text (a key shape, a password line, a card number…). */
export function holdsCredential(text: string): boolean {
  return scanText(text, "jev-web.md").reasons.length > 0;
}

/** One line of untrusted text: control characters out, whitespace collapsed, token shapes redacted, capped. */
function cleanLine(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return redactSecrets(s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()).slice(0, max);
}

/** An http(s) URL of sane length with no whitespace or control characters, else null. */
export function httpUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > URL_MAX || /[\s\u0000-\u001f\u007f]/.test(u)) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") return null;
    return p.hostname ? u : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** A hit as it may be kept or served: http(s) only, clean title (the URL when it has none), and
 *  nothing the credential rules flag. */
function keepHit(raw: unknown): JevWebHit | null {
  if (!isRecord(raw)) return null;
  const url = httpUrl(raw.url);
  if (!url) return null;
  // The rules read the text as it came (before the redactor rewrites a token shape they would catch).
  if (holdsCredential(`${typeof raw.title === "string" ? raw.title : ""}\n${url}`)) return null;
  const title = cleanLine(raw.title, TITLE_MAX) || cleanLine(url, TITLE_MAX);
  return { title, url };
}

function keepQuestion(raw: unknown): string {
  if (typeof raw === "string" && holdsCredential(raw)) return WITHHELD_QUESTION;
  return cleanLine(raw, QUESTION_MAX);
}

/** The line websearch.ts appends for one search (newline included). */
export function jevWebLine(at: Date, question: string, hits: readonly JevWebHit[]): string {
  const kept: JevWebHit[] = [];
  for (const h of hits) {
    const k = keepHit(h);
    if (k) kept.push(k);
    if (kept.length >= JEV_WEB_HITS) break;
  }
  const entry: JevWebEntry = { at: at.toISOString(), question: keepQuestion(question), hits: kept };
  return `${JSON.stringify(entry)}\n`;
}

/** Appends one search to the log (the data dir is made when missing). */
export async function appendJevWeb(path: string, at: Date, question: string, hits: readonly JevWebHit[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, jevWebLine(at, question, hits), "utf8");
}

/** The log's entries, oldest first. Every line is re-validated as it is read (the file is ours, but
 *  plain text on disk): a torn or hand-edited line is skipped, a bad hit dropped. */
export function parseJevWeb(text: string): JevWebEntry[] {
  const out: JevWebEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(o) || typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at)) || !Array.isArray(o.hits)) continue;
    const hits: JevWebHit[] = [];
    for (const h of o.hits) {
      const k = keepHit(h);
      if (k) hits.push(k);
      if (hits.length >= JEV_WEB_HITS) break;
    }
    out.push({ at: new Date(o.at).toISOString(), question: keepQuestion(o.question), hits });
  }
  return out;
}

interface Doc {
  entry: JevWebEntry;
  hit: JevWebHit;
  host: string;
  words: Set<string>;
}

/** The log read back, reloaded when the file changes (size or mtime). */
export class JevWebLog {
  private sig = "";
  private entries: JevWebEntry[] = [];
  private docs: Doc[] = [];
  private index: BM25Index | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;

  constructor(readonly path: string) {}

  /** Re-reads the file when it changed since the last read (joins a read in flight). */
  refresh(): Promise<void> {
    this.loading ??= this.reload().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async reload(): Promise<void> {
    let sig: string;
    try {
      const st = await stat(this.path);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      sig = "missing";
    }
    if (this.loaded && sig === this.sig) return;
    let text = "";
    if (sig !== "missing") {
      try {
        text = await readFile(this.path, "utf8");
      } catch {
        return; // unreadable right now: keep what was read before, try again next time
      }
    }
    this.entries = parseJevWeb(text);
    this.docs = this.entries.flatMap((entry) =>
      entry.hits.map((hit) => {
        const host = hostOf(hit.url);
        return { entry, hit, host, words: new Set(tokenize(`${hit.title} ${entry.question} ${host}`)) };
      }),
    );
    this.index = buildIndex(this.docs.map((d, i) => ({ path: String(i), title: d.hit.title, snippet: `${d.entry.question} ${d.host}` })));
    this.sig = sig;
    this.loaded = true;
  }

  /** A read has completed (a missing file reads as none kept); an unreadable file never counts. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Jev's trips as of the last read: every kept search, and the first and last one's time. */
  stats(): JevWebStats {
    return { trips: this.entries.length, since: this.entries[0]?.at ?? null, last: this.entries[this.entries.length - 1]?.at ?? null };
  }

  /** The best kept results for `query` (as of the last read), one per URL (its latest search),
   *  at most `k`, each within `floor` of the best score. */
  search(query: string, k: number, floor = 0.35): JevWebFind[] {
    const idx = this.index;
    if (!idx || idx.n === 0) return [];
    const scores = bm25Scores(idx, query);
    if (!scores.size) return [];
    const q = new Set(tokenize(query));
    const ranked = rankedChunkIndices(idx, scores);
    const top = scores.get(ranked[0] ?? -1) ?? 0;
    const byUrl = new Map<string, JevWebFind>();
    for (const ci of ranked) {
      const score = scores.get(ci) ?? 0;
      if (score < top * floor) break;
      const d = this.docs[Number(idx.chunks[ci]?.path ?? -1)];
      if (!d) continue;
      const prev = byUrl.get(d.hit.url);
      if (prev && prev.at >= d.entry.at) continue;
      let matched = 0;
      for (const w of q) if (d.words.has(w)) matched++;
      byUrl.set(d.hit.url, { title: d.hit.title, url: d.hit.url, host: d.host, question: d.entry.question, at: d.entry.at, score: Math.round(score * 1000) / 1000, matched });
    }
    return [...byUrl.values()].sort((a, b) => b.score - a.score || b.at.localeCompare(a.at)).slice(0, k);
  }
}

/** The finds that may go into a model's prompt (Alef's voice, Jev's ranking): at least `need` of
 *  the query's words in them, and none that repeats a value of a file the credential scanner
 *  closed (the taint; without a taint nothing is cited: fail closed), best first, at most `k`. */
export function citableFinds(finds: readonly JevWebFind[], taint: TaintSet | null, need: number, k: number): JevWebFind[] {
  if (!taint) return [];
  const out: JevWebFind[] = [];
  for (const f of finds) {
    if (out.length >= k) break;
    if (f.matched < need || taint.textHit(`${f.title} ${f.question} ${f.url}`, TIER_SPOKEN)) continue;
    out.push(f);
  }
  return out;
}

/** "today", "yesterday", "5 days ago": an age with no 4-digit year for the number blackout to catch. */
export function findAge(at: string, nowMs: number): string {
  const days = Math.max(0, Math.round((nowMs - Date.parse(at)) / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

const logs = new Map<string, JevWebLog>();

/** The one reader of the log beside `dbPath` (world.db's folder is the data dir); null for an
 *  in-memory db (no data dir). */
export function jevWebLogFor(dbPath: string): JevWebLog | null {
  if (dbPath === ":memory:") return null;
  const p = jevWebPath(dirname(dbPath));
  let log = logs.get(p);
  if (!log) {
    log = new JevWebLog(p);
    logs.set(p, log);
  }
  return log;
}
