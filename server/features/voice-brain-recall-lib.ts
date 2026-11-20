// Pure helpers for Alef's always-on retrieval (voice-brain-recall.ts does the IO):
//   - which paths are NEVER read (secrets), as a JS matcher and as the claude CLI deny rules;
//   - speech-to-text tolerant name matching (a phonetic key + Jaro-Winkler): "Mayra" → "Mayara";
//   - memory-note chunking and best-passage extraction;
//   - session-history and folder intents;
//   - the bounded, fenced block of snippets that goes into the prompt (≤ 8 hits, ≤ 2,500 chars).
// Everything retrieved is UNTRUSTED (the vault holds scraped RSS, transcripts, emails): it is
// redacted, flattened, defanged and fenced here, and the prompt says it is data, not instructions.

import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { agentTitle } from "../../shared/display.js";
import { redactSecrets } from "../heuristics.js";
import { cardNumbers, foldText, looseSecretValues, PRIVATE_KEY, scanText, spokenToDigits, TOKEN_SHAPES } from "./credential-scan-lib.js";
import { fenceSafe } from "./resident-lib.js";
import { isSecretPath } from "./safe-path.js";

// ── secrets: never read, never listed, never retrieved ────────────────────

/** Home-relative directories whose whole subtree is refused (~/.config holds token stores such as
 *  gh's hosts.yml and brain-server/.env; ~/Library holds Keychains, browser profiles and cookies). */
export const DENY_HOME_DIRS: readonly string[] = [".ssh", ".aws", ".gnupg", ".config", "Library", ".docker", ".kube", ".password-store", ".passwordmanager", ".mozilla"];
/** Directory names refused at any depth. */
export const DENY_ANY_DIRS: readonly string[] = [".ssh", ".aws", ".gnupg", ".git", ".git.nosync", ".password-store", "Keychains"];
/** Basename globs (`*` = any run of characters; case-insensitive in JS) refused at any depth. */
export const DENY_BASENAMES: readonly string[] = [
  ".env*",
  "*.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*.keychain*",
  "id_*",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  "credentials*",
  ".credentials*",
  "Cookies",
  "Cookies-journal",
  "cookies.txt",
  "cookies.sqlite*",
  "*cookie*.json",
  "*.cookies",
  "*.binarycookies",
  "*token*.json",
  "*token*.txt",
  "*token*.db",
  "*.token",
  ".*token*",
  "*secret*.json",
  "*secrets*",
  ".secrets*",
  ".dev.vars*",
  ".mcp.json",
  "settings.local.json",
  "auth.json",
  ".auth.json",
  "*.p8",
  "*.gpg",
  "*.tfvars",
  "*.tfstate*",
  "*service-account*.json",
  "*serviceaccount*.json",
  "*adminsdk*.json",
  ".htpasswd",
];

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

const DENY_BASENAME_RES = DENY_BASENAMES.map(globToRegExp);
const DENY_ANY_DIR_SET = new Set(DENY_ANY_DIRS.map((d) => d.toLowerCase()));

/** True for a path Alef must never read or list: every secret rule above plus the server-wide
 *  isSecretPath list. Relative paths are refused outright (callers pass absolute paths). The
 *  compare is case-insensitive because the Mac's filesystem is. */
export function isDeniedPath(p: string, home: string): boolean {
  if (!p || p.includes("\0") || !isAbsolute(p)) return true;
  const abs = normalize(p);
  const parts = abs.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (DENY_BASENAME_RES.some((re) => re.test(name))) return true;
  if (parts.some((seg) => DENY_ANY_DIR_SET.has(seg.toLowerCase()))) return true;
  const lower = abs.toLowerCase();
  const h = normalize(home).replace(/\/+$/, "").toLowerCase();
  for (const d of DENY_HOME_DIRS) {
    const root = `${h}/${d.toLowerCase()}`;
    if (lower === root || lower.startsWith(root + sep)) return true;
  }
  return isSecretPath(abs);
}

/** "*cookie*" → also "*Cookie*": the CLI's globs are case-sensitive, the Mac's disk is not. */
function caseVariants(glob: string): string[] {
  const i = glob.search(/[a-z]/);
  if (i < 0) return [glob];
  return [glob, glob.slice(0, i) + glob.charAt(i).toUpperCase() + glob.slice(i + 1), glob.toUpperCase()];
}

/** The same rules as `permissions.deny` for the claude CLI (Read rules also bind Grep and Glob:
 *  verified 2026-09-28 on 2.1.283 with canary files, a denied .env/.pem/.ssh file never showed in
 *  a Grep content search, and did without the rules). `//` = an absolute path. */
export function deepDenyRules(home: string): string[] {
  const h = normalize(home).replace(/\/+$/, "");
  const rules: string[] = [];
  for (const d of DENY_HOME_DIRS) rules.push(`Read(/${h}/${d}/**)`, `Read(/${h}/${d})`);
  for (const d of DENY_ANY_DIRS) rules.push(`Read(//**/${d}/**)`);
  for (const g of DENY_BASENAMES) for (const v of caseVariants(g)) rules.push(`Read(//**/${v})`);
  return [...new Set(rules)];
}

// ── query words ───────────────────────────────────────────────────────────

const STOP = new Set(
  (
    "a an and are as at be but by for from has have he her his i if in into is it its of on or our she that the their them then there these they this to too us was we were what when where which who will with you your " +
    "me my mine myself whats what's who's whos did do does done tell about know check checking look looking search searching find finding dig digging please alef aleph hey hi sir can could would should how why just now any some all here get got go going want need like am been being not no yes ok okay so also very really much many more most one ones thing things something anything give show list remind again else ever own let lets let's " +
    "s t re ve ll d m im i'm dont don't"
  ).split(/\s+/),
);

/** Intent words: they steer which sources run, but make poor search terms. */
const GENERIC = new Set(
  (
    "brain notes note memory memories vault folder folders directory directories dir repo repos file files session sessions work worked working " +
    "yesterday today tonight morning afternoon evening night week weekend last this day days ago project projects status update updates latest recent recently " +
    "touched touch touching learn learned learnt computer disk mac name called"
  ).split(/\s+/),
);

/** Words that are about the live world (answered by the world summary), not about his notes. */
const WORLD_WORDS = new Set(
  (
    "agent agents live waiting approval approvals pending city cities district districts busy busiest token tokens open fly dispatch view board room orbit canvas " +
    "volume mute pause play screenshot lock approve deny quit hide focus spotify music"
  ).split(/\s+/),
);

export interface QueryWords {
  /** Content words, lowercased, deduped, in order (possessive 's stripped). */
  terms: string[];
  /** Same words with their original case. */
  original: string[];
  /** Per word: capitalised mid-sentence, the "looks like a name" signal (speech-to-text
   *  capitalises names, and every sentence's first word, which says nothing). */
  midCap: boolean[];
}

/** The text before a word leaves it at the start of a sentence, a line, a list item or a table
 *  cell, where a capital letter says nothing about it being a name. */
export function atSentenceStart(before: string): boolean {
  return /(?:^|[.!?]["'”’)\]*_]*\s|\|)[\s"'“‘(\[*_>#•–—\-\d.)]*$/u.test(before);
}

export function queryWords(text: string): QueryWords {
  const terms: string[] = [];
  const original: string[] = [];
  const midCap: boolean[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)) {
    const raw = m[0].replace(/['’]s$/i, "").replace(/['’]/g, "");
    const t = raw.toLowerCase();
    if (t.length < 2 || STOP.has(t) || GENERIC.has(t) || terms.includes(t)) continue;
    terms.push(t);
    original.push(raw);
    midCap.push(/^\p{Lu}/u.test(raw) && !atSentenceStart(text.slice(0, m.index)));
  }
  return { terms, original, midCap };
}

/** Every content word is a live-world word ("how many agents are live?"): notes can't help. */
export function isWorldOnly(terms: readonly string[]): boolean {
  return terms.length === 0 || terms.every((t) => WORLD_WORDS.has(t));
}

// ── speech-to-text tolerant names ─────────────────────────────────────────

/** A small Metaphone-style key: similar-sounding spellings collapse to one key
 *  ("Mayra"/"Mayara" → "m", "Jev"/"Jeff" → "jf", "ACME"/"Ackme" → "akm", "Viktor"/"Victor" → "fktr"). */
export function phoneticKey(word: string): string {
  let w = word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/^kn|^gn|^pn/, "n")
    .replace(/^wr/, "r")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/q+u?/g, "k")
    .replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/dg(?=[eiy])/g, "j")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/v/g, "f")
    .replace(/([^aeiou])h/g, "$1")
    .replace(/(?!^)w/g, "");
  const first = /[aeiou]/.test(w.charAt(0)) ? "a" : w.charAt(0);
  const rest = w.slice(1).replace(/[aeiouy]/g, "");
  return (first + rest).replace(/(.)\1+/g, "$1");
}

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aM = new Array<boolean>(a.length).fill(false);
  const bM = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = true;
      bM[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface LexName {
  name: string;
  lower: string;
  key: string;
  count: number;
}

export interface NameLexicon {
  names: LexName[];
  lower: Set<string>;
}

/** Proper-noun-looking words ("Mayara", "ACME", "Victor") counted across `texts`, plus `extra`
 *  names (folder and district names) that always count. A word counts only where it is
 *  capitalised mid-sentence: "Password: …" or "Action items" opening a line is not a name. */
export function buildNameLexicon(texts: Iterable<string>, extra: Iterable<string> = []): NameLexicon {
  const counts = new Map<string, { name: string; count: number }>();
  const add = (name: string, n = 1): void => {
    const lower = name.toLowerCase();
    if (lower.length < 3 || STOP.has(lower) || GENERIC.has(lower) || /\d/.test(lower)) return;
    const cur = counts.get(lower);
    if (cur) cur.count += n;
    else counts.set(lower, { name, count: n });
  };
  for (const t of texts)
    for (const line of t.split("\n"))
      for (const m of line.matchAll(/\b[A-Z][\p{L}]{2,}\b/gu)) if (!atSentenceStart(line.slice(0, m.index))) add(m[0]);
  for (const e of extra) for (const part of e.split(/[^\p{L}\p{N}]+/u)) if (part) add(part, 3);
  const names = [...counts.entries()].map(([lower, v]) => ({ name: v.name, lower, key: phoneticKey(lower), count: v.count }));
  return { names, lower: new Set(names.map((n) => n.lower)) };
}

export interface Correction {
  heard: string;
  meant: string;
}

/** The common (lowercase) words of a word list such as /usr/share/dict/words; its capitalised
 *  entries are proper names ("Mayra"), which are exactly what may be misheard. */
export function parseDictionary(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.split("\n")) if (/^[a-z]/.test(w)) out.add(w.trim());
  return out;
}

/** True when `t` or its plain stem is a common word (the macOS list has no plurals, tenses or
 *  modern compounds: "flights" → "flight", "taxes" → "tax", "daycare" → "day" + "care"). Without
 *  `compounds`, two words run together are not one: "purplewalrus" is not a word to the reply
 *  guard, which is what a password made of two words looks like. */
export function inDictionary(t: string, dict: ReadonlySet<string>, compounds = true): boolean {
  const stemIn = (w: string): boolean => [w, w.replace(/s$/, ""), w.replace(/es$/, ""), w.replace(/ies$/, "y"), w.replace(/e?d$/, ""), w.replace(/ing$/, ""), w.replace(/ing$/, "e")].some((s) => s.length >= 2 && dict.has(s));
  if (stemIn(t)) return true;
  if (!compounds) return false;
  for (let i = 3; i <= t.length - 3; i++) if (dict.has(t.slice(0, i)) && stemIn(t.slice(i))) return true;
  return false;
}

/** Replaces content words speech-to-text probably misheard with the closest name the user's
 *  notes know. Only a word that looks like a name is a candidate: capitalised mid-sentence, or
 *  not a common word (`isCommonWord`), so "passport" never becomes "Password". It must also be
 *  unknown to the notes (`isKnown`), and a lexicon name must sound the same (same phonetic key)
 *  and be spelled close to it. `terms` carries the correction; `searchTerms` keeps the heard word
 *  next to it, so a wrong guess never drops what he said from the search. */
export function correctTerms(
  q: QueryWords,
  lex: NameLexicon,
  isKnown: (t: string) => boolean,
  isCommonWord: (t: string) => boolean,
): { terms: string[]; searchTerms: string[]; corrections: Correction[] } {
  const terms: string[] = [];
  const searchTerms: string[] = [];
  const corrections: Correction[] = [];
  q.terms.forEach((t, i) => {
    const orig = q.original[i] ?? t;
    const nameLike = q.midCap[i] === true || !isCommonWord(t);
    const key = phoneticKey(t);
    if (!nameLike || t.length < 3 || /\d/.test(t) || key.length < 2 || lex.lower.has(t) || isKnown(t)) {
      terms.push(t);
      searchTerms.push(t);
      return;
    }
    let best: { n: LexName; score: number } | null = null;
    for (const n of lex.names) {
      if (n.key !== key || Math.abs(n.lower.length - t.length) > 3) continue;
      const jw = jaroWinkler(t, n.lower);
      if (jw < 0.7) continue;
      const score = jw + Math.min(0.05, Math.log10(1 + n.count) / 100);
      if (!best || score > best.score) best = { n, score };
    }
    if (best && !terms.includes(best.n.lower)) {
      terms.push(best.n.lower);
      searchTerms.push(best.n.lower, t);
      corrections.push({ heard: orig, meant: best.n.name });
    } else {
      terms.push(t);
      searchTerms.push(t);
    }
  });
  return { terms, searchTerms: [...new Set(searchTerms)], corrections };
}

// ── memory notes: chunks and passages ─────────────────────────────────────

export interface MemoryChunk {
  path: string;
  /** Frontmatter `name` (or the file name). */
  name: string;
  description: string;
  text: string;
}

/** `name:` / `description:` from a leading frontmatter block, and the body after it. */
export function splitFrontmatter(raw: string): { name: string; description: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { name: "", description: "", body: raw };
  const fm = m[1] ?? "";
  const field = (k: string): string => {
    const f = fm.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, "im"));
    return (f?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  };
  return { name: field("name"), description: field("description"), body: raw.slice(m[0].length) };
}

/** Drops the auto-generated footer, dataview blocks and code fences; keeps the prose. */
export function cleanBody(body: string): string {
  return body
    .replace(/\n---\s*\n## Smart Connections[\s\S]*$/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\r\n?/g, "\n");
}

function flat(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f`]+/g, " ")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Paragraph-sized chunks (≤ maxChars) of one memory note; tiny paragraphs merge into the next. */
export function chunkNote(path: string, raw: string, maxChars = 600): MemoryChunk[] {
  const { name, description, body } = splitFrontmatter(raw);
  const fileName = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
  const paras = cleanBody(body)
    .split(/\n\s*\n/)
    .map(flat)
    .filter((p) => p.length > 0 && p !== "---");
  const chunks: string[] = [];
  let buf = "";
  const push = (s: string): void => {
    if (s) chunks.push(s);
  };
  for (const p of paras) {
    if (p.length > maxChars) {
      push(buf);
      buf = "";
      let cur = "";
      for (const sentence of p.split(/(?<=[.!?])\s+/)) {
        if (cur && cur.length + sentence.length + 1 > maxChars) {
          push(cur);
          cur = "";
        }
        cur = cur ? `${cur} ${sentence}` : sentence.slice(0, maxChars);
      }
      push(cur);
      continue;
    }
    if (buf && buf.length + p.length + 1 > maxChars) {
      push(buf);
      buf = "";
    }
    buf = buf ? `${buf} ${p}` : p;
    if (buf.length >= 120) {
      push(buf);
      buf = "";
    }
  }
  push(buf);
  const nm = name || fileName;
  if (!chunks.length && description) chunks.push(flat(description));
  return chunks.map((text) => ({ path, name: flat(nm), description: flat(description), text }));
}

function termRe(term: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");
}

/** The window of `text` (≤ maxChars) around the sentence that mentions the most distinct terms. */
export function bestPassage(text: string, terms: readonly string[], maxChars: number): string {
  const clean = flat(text);
  if (clean.length <= maxChars) return clean;
  const parts = clean.split(/(?<=[.!?;:])\s+/);
  const res = terms.map(termRe);
  let bestI = -1;
  let bestScore = 0;
  parts.forEach((p, i) => {
    const s = res.reduce((n, re) => n + (re.test(p) ? 1 : 0), 0);
    if (s > bestScore) {
      bestScore = s;
      bestI = i;
    }
  });
  if (bestI < 0) return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
  let out = parts[bestI] ?? "";
  let lo = bestI;
  let hi = bestI;
  while (out.length < maxChars) {
    const next = parts[hi + 1];
    const prev = parts[lo - 1];
    if (next !== undefined && out.length + next.length + 1 <= maxChars) {
      out = `${out} ${next}`;
      hi++;
    } else if (prev !== undefined && out.length + prev.length + 1 <= maxChars) {
      out = `${prev} ${out}`;
      lo--;
    } else break;
  }
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return `${lo > 0 ? "…" : ""}${out}${hi < parts.length - 1 && !out.endsWith("…") ? "…" : ""}`;
}

/** True when `text` mentions any of the terms as a word start. */
export function mentionsAny(text: string, terms: readonly string[]): boolean {
  return terms.some((t) => termRe(t).test(text));
}

// ── session history ───────────────────────────────────────────────────────

export interface DayRange {
  label: string;
  startMs: number;
  endMs: number;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dayStart(d: Date, offsetDays = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays);
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function range(label: string, start: Date, end: Date): DayRange {
  return { label, startMs: start.getTime(), endMs: end.getTime() };
}

/** The local day (or week) a question is about, or null. DST-safe: calendar arithmetic, not 24h steps. */
export function parseDayRange(text: string, now: Date): DayRange | null {
  const t = text.toLowerCase();
  const today = dayStart(now);
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (!Number.isNaN(d.getTime())) return range(dayLabel(d), d, dayStart(d, 1));
  }
  if (/\bday before yesterday\b/.test(t)) {
    const d = dayStart(now, -2);
    return range(dayLabel(d), d, dayStart(now, -1));
  }
  if (/\byesterday\b|\blast night\b/.test(t)) return range(`yesterday, ${dayLabel(dayStart(now, -1))}`, dayStart(now, -1), today);
  const ago = t.match(/\b(\d{1,2}|two|three|four|five|six) days ago\b/);
  if (ago?.[1]) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = words[ago[1]] ?? Number(ago[1]);
    const d = dayStart(now, -n);
    return range(dayLabel(d), d, dayStart(now, -n + 1));
  }
  if (/\blast week\b/.test(t)) {
    const monday = dayStart(now, -((now.getDay() + 6) % 7));
    return range("last week", dayStart(monday, -7), monday);
  }
  if (/\bthis week\b/.test(t)) {
    const monday = dayStart(now, -((now.getDay() + 6) % 7));
    return range("this week", monday, dayStart(now, 1));
  }
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (wd >= 0) {
    const back = (now.getDay() - wd + 7) % 7;
    const d = dayStart(now, -back);
    return range(dayLabel(d), d, dayStart(d, 1));
  }
  if (/\btoday\b|\bthis (?:morning|afternoon|evening)\b|\btonight\b/.test(t)) return range(`today, ${dayLabel(today)}`, today, dayStart(now, 1));
  return null;
}

/** "what did I work on", "which sessions…", "search my sessions", "what was I doing". */
export function wantsSessionHistory(text: string): boolean {
  return /\b(?:work(?:ed|ing)? on|did i (?:do|build|ship|fix)|sessions?|what was i doing|busy with|touched|shipped|agents? (?:ran|worked))\b/i.test(text);
}

export interface SessionRef {
  id: string;
  name: string;
  city: string;
  startMs: number;
  endMs: number;
  source: "live" | "archive";
  /** Files the session touched (absolute paths), when known. */
  files: readonly string[];
}

/** Sessions whose [start, last active] overlaps the range, most recent first. */
export function sessionsInRange(refs: readonly SessionRef[], r: DayRange): SessionRef[] {
  return refs.filter((s) => s.startMs < r.endMs && s.endMs >= r.startMs).sort((a, b) => b.endMs - a.endMs);
}

function clipText(s: string, max: number): string {
  const t = flat(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** One line per range: counts, then the districts busiest first with a few session names each. */
export function renderDaySessions(r: DayRange, sessions: readonly SessionRef[], maxChars: number): string {
  if (!sessions.length) return `No sessions recorded ${r.label}.`;
  const byCity = new Map<string, SessionRef[]>();
  for (const s of sessions) byCity.set(s.city, [...(byCity.get(s.city) ?? []), s]);
  const cities = [...byCity.entries()].sort((a, b) => b[1].length - a[1].length);
  let out = `${sessions.length} session${sessions.length === 1 ? "" : "s"} ${r.label}, in ${cities.length} district${cities.length === 1 ? "" : "s"}:`;
  for (const [city, list] of cities) {
    const names = [...new Set(list.map((s) => clipText(s.name, 60)))];
    const piece = ` ${city} (${list.length}): ${names.slice(0, 4).map((n) => `"${n}"`).join(", ")}${names.length > 4 ? ", …" : ""};`;
    if (out.length + piece.length > maxChars) {
      out += " …";
      break;
    }
    out += piece;
  }
  return out;
}

/** Words that describe the kind of thing, not which thing ("the pricing PAGE"). */
const SOFT = new Set(["page", "pages", "component", "components", "screen", "doc", "docs", "site", "website", "app", "thing", "stuff", "code"]);

export interface TopicMatch {
  ref: SessionRef;
  score: number;
  /** "title" | "file:<basename>". */
  why: string;
}

/** Sessions whose name mentions the topic, or that touched a file whose path does. */
export function matchSessionsByTopic(refs: readonly SessionRef[], terms: readonly string[]): TopicMatch[] {
  const hard = terms.filter((t) => !SOFT.has(t));
  const need = hard.length ? hard : [...terms];
  if (!need.length) return [];
  const out: TopicMatch[] = [];
  for (const ref of refs) {
    const name = ref.name.toLowerCase();
    const inName = terms.filter((t) => name.includes(t)).length;
    const nameHit = need.every((t) => name.includes(t));
    const file = ref.files.find((f) => {
      const lf = f.toLowerCase();
      return need.every((t) => lf.includes(t));
    });
    if (!nameHit && !file) continue;
    out.push({ ref, score: (nameHit ? 2 + inName : 0) + (file ? 1 : 0), why: file && !nameHit ? `file:${file.split("/").pop() ?? file}` : "title" });
  }
  return out.sort((a, b) => b.score - a.score || b.ref.endMs - a.ref.endMs);
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function renderTopicSessions(terms: readonly string[], matches: readonly TopicMatch[], maxChars: number): string {
  if (!matches.length) return `No session name or touched file mentions "${terms.join(" ")}".`;
  let out = `${matches.length} session${matches.length === 1 ? "" : "s"} about "${terms.join(" ")}" (by name or a touched file), newest first:`;
  for (const m of [...matches].sort((a, b) => b.ref.endMs - a.ref.endMs)) {
    const piece = ` ${isoDay(m.ref.endMs)} "${clipText(m.ref.name, 60)}" in ${m.ref.city}${m.why.startsWith("file:") ? ` (touched ${m.why.slice(5)})` : ""};`;
    if (out.length + piece.length > maxChars) {
      out += " …";
      break;
    }
    out += piece;
  }
  return out;
}

/** A live-table agent as a SessionRef (name = what the UI shows). */
export function agentRef(a: { id: string; title: string; displayName?: string | null; startedAt: string; lastActive: string }, city: string, files: readonly string[]): SessionRef {
  const start = Date.parse(a.startedAt);
  const end = Date.parse(a.lastActive);
  return { id: a.id, name: agentTitle(a), city, startMs: Number.isNaN(start) ? end : start, endMs: Number.isNaN(end) ? start : end, source: "live", files };
}

/** An archived fossil (a vault session note) as a SessionRef spanning its whole day. */
export function fossilRef(f: { id: string; title: string; date: string; project: string }): SessionRef | null {
  const m = f.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { id: f.id, name: f.title, city: f.project || "archive", startMs: start.getTime(), endMs: dayStart(start, 1).getTime() - 1, source: "archive", files: [] };
}

// ── folders ───────────────────────────────────────────────────────────────

export interface FolderCandidate {
  name: string;
  path: string;
}

/** "what's in my X folder", "list the files in X", "the X repo". */
export function wantsFolderListing(text: string): boolean {
  return /\b(?:folders?|director(?:y|ies)|repo(?:sitory)?|what'?s in(?:side)?|files in|contents? of|inside)\b/i.test(text);
}

function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The folder the utterance names: every token of the folder's name must be heard (exactly, or
 *  sounding the same), longest name first. Single-token names need an exact word. */
export function matchFolder(text: string, candidates: readonly FolderCandidate[]): FolderCandidate | null {
  const heard = nameTokens(text.replace(/['’]s\b/gi, ""));
  const heardKeys = new Set(heard.filter((t) => t.length >= 3 && !/\d/.test(t)).map(phoneticKey));
  const heardJoined = heard.join("");
  let best: { c: FolderCandidate; n: number } | null = null;
  for (const c of candidates) {
    const toks = nameTokens(c.name);
    if (!toks.length || (toks.length === 1 && (STOP.has(toks[0] ?? "") || GENERIC.has(toks[0] ?? "")))) continue;
    const ok =
      toks.length === 1
        ? heard.includes(toks[0] ?? "") || (heardJoined.includes(toks[0] ?? "") && (toks[0]?.length ?? 0) >= 6)
        : toks.every((t) => heard.includes(t) || (t.length >= 3 && !/\d/.test(t) && heardKeys.has(phoneticKey(t))));
    if (!ok) continue;
    if (!best || toks.length > best.n) best = { c, n: toks.length };
  }
  return best?.c ?? null;
}

export interface DirEntryLite {
  name: string;
  dir: boolean;
}

/** Names only: folders first, dotfiles and secret-looking names left out, capped. */
export function renderListing(label: string, absDir: string, entries: readonly DirEntryLite[], home: string, maxChars: number): string {
  const shown = entries
    .filter((e) => !e.name.startsWith(".") && !isDeniedPath(join(absDir, e.name), home))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  let out = `${label} has ${shown.length} visible entr${shown.length === 1 ? "y" : "ies"}:`;
  for (const e of shown) {
    const piece = ` ${e.name}${e.dir ? "/" : ""},`;
    if (out.length + piece.length > maxChars) {
      out += " …";
      return out;
    }
    out += piece;
  }
  return out.replace(/,$/, ".");
}

// ── the block that goes into the prompt ──────────────────────────────────

/** "web": a page Jev found on the web for an earlier question (data/jev-web.jsonl), third-party text. */
export type RecallSource = "memory" | "vault" | "sessions" | "folder" | "resident" | "web";

export interface RecallHit {
  source: RecallSource;
  /** Where it came from: a path (memory/…, vault/…, ~/Documents/Code/…) or a label. */
  ref: string;
  text: string;
}

export const RECALL_MAX_HITS = 8;
export const RECALL_MAX_CHARS = 2500;

// ── what Alef says ────────────────────────────────────────────────────────
// Credentials are kept out at the SOURCE first: a file the credential scanner flags is never
// retrieved, listed or readable (credential-scan*.ts). What Alef says is then filtered by token and
// key shapes (sk-ant-…, ghp_…, AKIA…, JWTs, PEM blocks), card numbers that pass Luhn, and the exact
// VALUES the reply guard collected this turn (a closed file a lookup saw, and the guard's own net
// over the retrieved notes and what a lookup read: retrievedSecretValues, looseSecretValues). A
// sentence is withheld only when it repeats one of those values, never for merely mentioning a
// secret scan next to a port number.

/** What replaces a sentence that repeats a value from a closed note. */
export const CLOSED_SPOKEN = "That part comes from a note that holds credentials, so I keep it closed.";
/** A sentence (or a clause after "; ") ends at . ! ? ; followed by a space, or at a line break:
 *  never at a dot inside a value ("hunter2.xyz99"). */
const SENTENCE_SPLIT = /(?<=[.!?;])(?=\s)|(?<=\n)/;

/** Token and key shapes, private key blocks and card numbers → "[redacted]". */
export function redactTokens(text: string): string {
  let t = redactSecrets(text);
  for (const re of TOKEN_SHAPES) t = t.replace(re, "[redacted]");
  t = t.replace(PRIVATE_KEY, "[redacted]");
  if (/\d{4}/.test(t)) for (const c of cardNumbers(t)) t = t.replace(new RegExp(c.split("").join("[ -]?")), "[redacted]");
  return t;
}

interface CompiledValues {
  digits: Set<string>;
  /** Letters-and-digits only, lowercased ("Xy7!Canary" → "xy7canary"). */
  tokens: string[];
  phrases: string[][];
}

function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function compileValues(values: Iterable<string>): CompiledValues {
  const c: CompiledValues = { digits: new Set(), tokens: [], phrases: [] };
  for (const raw of values) {
    const v = foldText(raw);
    const d = v.replace(/[\s-]/g, "");
    if (/^\d{3,}$/.test(d)) c.digits.add(d);
    else if (/\s/.test(v.trim())) c.phrases.push(wordsOf(v));
    else {
      const t = v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      if (t.length >= 4) c.tokens.push(t);
    }
  }
  return c;
}

/** What may sit between the digit groups of one value as it is said: spaces, dashes, commas,
 *  "and", "then" ("33 and 44", "4, then 8"). */
const GROUP_JOIN = /^(?:[\s.,\-–—]|and|then|et|puis|و)*$/i;

/** True when `piece` repeats a value: its digits (spaced, hyphenated, joined by "and"/"then", in any
 *  script or spelled out: "48 21", "33 and 44", "٣٣٤٤", "four eight two one", "trente-trois
 *  quarante-quatre"), a token (case and punctuation aside), or 3 consecutive words of a phrase. */
function holdsValue(piece: string, c: CompiledValues): boolean {
  if (!c.digits.size && !c.tokens.length && !c.phrases.length) return false;
  const norm = spokenToDigits(foldText(piece));
  if (c.digits.size) {
    const groups = [...norm.matchAll(/\d+/g)];
    for (let i = 0; i < groups.length; i++) {
      let acc = "";
      for (let j = i; j < groups.length && acc.length <= 24; j++) {
        const prev = groups[j - 1];
        const cur = groups[j];
        if (!cur) break;
        const gap = prev ? norm.slice(prev.index + prev[0].length, cur.index) : "";
        if (j > i && (gap.length > 12 || !GROUP_JOIN.test(gap.replace(/\s+/g, " ")))) break;
        acc += cur[0];
        if (c.digits.has(acc)) return true;
      }
    }
  }
  const words = wordsOf(norm);
  const joined = words.join("");
  if (c.tokens.some((t) => (t.length >= 5 ? joined.includes(t) : words.includes(t)))) return true;
  return c.phrases.some((p) => {
    const k = Math.min(3, p.length);
    for (let i = 0; i + k <= p.length; i++)
      for (let j = 0; j + k <= words.length; j++) if (p.slice(i, i + k).every((w, n) => words[j + n] === w)) return true;
    return false;
  });
}

/** What Alef may say aloud or keep in the conversation: token shapes, key blocks and card numbers
 *  redacted, and any sentence that repeats one of `values` (the values of a closed note a lookup
 *  saw, in digits or in words: "4821.", "Four eight two one.") replaced by CLOSED_SPOKEN. Nothing
 *  else is touched: an answer about secret scans or port numbers is said in full. */
export function redactSpoken(text: string, values: Iterable<string> = []): string {
  const clean = redactTokens(text);
  const c = compileValues(values);
  if (!c.digits.size && !c.tokens.length && !c.phrases.length) return clean;
  const pieces = clean.split(SENTENCE_SPLIT);
  const hit = pieces.map((p) => p.trim() !== "" && holdsValue(p, c));
  if (!hit.some(Boolean)) return clean;
  // One CLOSED_SPOKEN per run of withheld sentences.
  const out: string[] = [];
  let inRun = false;
  pieces.forEach((p, i) => {
    if (!p.trim()) out.push(p);
    else if (!hit[i]) {
      out.push(p);
      inRun = false;
    } else if (!inRun) {
      out.push(`${/^\s*/.exec(p)?.[0] ?? ""}${CLOSED_SPOKEN}${p.endsWith("\n") ? "\n" : ""}`);
      inRun = true;
    }
  });
  return out.join("").trim();
}

/** The reply guard: the values in the retrieved notes, found two independent ways (in memory
 *  only): the credential rules (a note the scanner left open should hold none), and the guard's own
 *  looser net, with its own trigger words and `isWord` (the dictionary) to tell a password from a
 *  word (looseSecretValues). A sentence that repeats one is withheld whatever the model makes of
 *  the prompt. Only the snippets are read, not the "[source] ref:" before each. */
export function retrievedSecretValues(block: string, isWord?: (w: string) => boolean): string[] {
  if (!block) return [];
  const snippets = blockSnippets(block);
  return [...new Set([...scanText(snippets, "retrieved-notes.md", { collectValues: true }).values, ...looseSecretValues(snippets, isWord)])];
}

/** The snippets of a rendered recall block, one per line, without the "[source] ref:" before each. */
export function blockSnippets(block: string): string {
  return block
    .split("\n")
    .map((l) => l.replace(/^\[[a-z]+\][^\S\n]+.*?:[^\S\n]/, ""))
    .join("\n");
}

/** Untrusted text for inside the fence: token shapes redacted, one line, no fence tokens, and no
 *  line an action parser could mistake for Alef's own ACTION syntax. (Files that hold credentials
 *  never get here: the scanner closes them before retrieval reads a word.) */
export function sanitizeSnippet(s: string): string {
  return fenceSafe(redactTokens(s.replace(/[\u0000-\u001f\u007f`]+/g, " ")))
    .replace(/\bACTION\b/g, "action")
    .replace(/\s+/g, " ")
    .trim();
}

function hitLine(h: RecallHit): string {
  return `[${h.source}] ${sanitizeSnippet(h.ref)}: ${sanitizeSnippet(h.text)}`;
}

/** Keeps hits in order until either cap: at most `maxHits`, and the rendered lines within
 *  `maxChars` (the last one is trimmed to fit when at least 120 chars are left). */
export function packHits(hits: readonly RecallHit[], maxHits = RECALL_MAX_HITS, maxChars = RECALL_MAX_CHARS): RecallHit[] {
  const out: RecallHit[] = [];
  let used = 0;
  for (const h of hits) {
    if (out.length >= maxHits) break;
    const gap = out.length ? 1 : 0; // the newline between lines
    const room = maxChars - used - gap;
    const line = hitLine(h);
    if (line.length <= room) {
      out.push(h);
      used += gap + line.length;
      continue;
    }
    const text = sanitizeSnippet(h.text);
    const overhead = line.length - text.length;
    if (room - overhead >= 120) {
      const cut = { ...h, text: `${text.slice(0, room - overhead - 1).trimEnd()}…` };
      out.push(cut);
      used += gap + hitLine(cut).length;
    }
    break;
  }
  return out;
}

/** The fenced block for the prompt ("" when there is nothing to say). */
export function renderRecallBlock(hits: readonly RecallHit[], corrections: readonly Correction[], notice?: string): string {
  if (!hits.length && !corrections.length && !notice) return "";
  const lines = [
    ...(notice ? [notice] : []),
    ...corrections.map((c) => `(did you mean) Speech-to-text heard "${sanitizeSnippet(c.heard)}"; the closest name in his notes is "${sanitizeSnippet(c.meant)}".`),
    ...hits.map(hitLine),
  ];
  return ["<<<UNTRUSTED_DATA", ...lines.map(fenceSafe), "UNTRUSTED_DATA>>>"].join("\n");
}

/** The note path as the prompt shows it: relative to its root, never the whole home path. */
export function displayRef(abs: string, roots: ReadonlyArray<{ root: string; label: string }>, home: string): string {
  const a = resolve(abs);
  for (const r of roots) {
    const root = resolve(r.root);
    if (a === root) return r.label;
    if (a.startsWith(root + sep)) return `${r.label}/${a.slice(root.length + 1)}`;
  }
  const h = resolve(home);
  return a.startsWith(h + sep) ? `~/${a.slice(h.length + 1)}` : a;
}
