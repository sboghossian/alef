// Alef's always-on retrieval (voice-brain.ts calls it before every turn): the few snippets of his
// own notes, sessions and folders that bear on what he just said, bounded and fenced for the
// prompt. No tool loop, no model call: BM25 over the memory files (built here, paragraph chunks),
// the brain feature's vault index, the world's session table plus the archive's fossils, and one
// readdir for a named folder. Pure logic lives in voice-brain-recall-lib.ts.
//
// READ-ONLY. Every file path goes through isDeniedPath (secret paths are never read or listed) and
// the credential scanner (credential-scan.ts): a file that holds a credential is CLOSED, never
// quoted, listed or searched, and when it is the best match Alef says so instead of guessing.
// Every snippet goes through the token-shape redactor and the fence. Logs carry counts and
// timings only, never text.

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { displayIslandName } from "../../shared/display.js";
import type { ArchivedSession } from "../../shared/features/archive.js";
import type { BrainSearchHit } from "../../shared/features/brain.js";
import type { Island, WorldAgent } from "../../shared/types.js";
import { createCredentialScanner, type CredentialScanner } from "./credential-scan.js";
import { scanText } from "./credential-scan-lib.js";
import { citableFinds, findAge, jevWebLogFor, type JevWebLog } from "./recall/jev-web.js";
import { bm25Scores, buildIndex, type BM25Index, type RecallDoc } from "./recall/bm25.js";
import { realOrResolved } from "./fork-lib.js";
import type { FeatureContext } from "./registry.js";
import { readTextCapped, resolveInside } from "./safe-path.js";
import {
  agentRef,
  bestPassage,
  buildNameLexicon,
  chunkNote,
  cleanBody,
  correctTerms,
  displayRef,
  fossilRef,
  inDictionary,
  isDeniedPath,
  isWorldOnly,
  matchFolder,
  matchSessionsByTopic,
  mentionsAny,
  packHits,
  parseDayRange,
  parseDictionary,
  queryWords,
  renderDaySessions,
  renderListing,
  renderRecallBlock,
  renderTopicSessions,
  sessionsInRange,
  splitFrontmatter,
  wantsFolderListing,
  wantsSessionHistory,
  type Correction,
  type FolderCandidate,
  type MemoryChunk,
  type NameLexicon,
  type RecallHit,
  type RecallSource,
  type SessionRef,
} from "./voice-brain-recall-lib.js";
import { vaultRoot } from "../config.js";

const MEMORY_TTL_MS = 10 * 60_000;
const DIRS_TTL_MS = 60_000;
const MEMORY_MAX_FILE_BYTES = 200 * 1024;
const VAULT_NOTE_MAX_BYTES = 64 * 1024;
const RESIDENT_MAX_BYTES = 32 * 1024;
/** The resident journal hit's length in the prompt. */
const RESIDENT_HIT_CHARS = 1100;
const MEMORY_HITS = 3;
const VAULT_HITS = 3;
/** Jev's earlier web finds per turn (after his own notes, so the caps drop them first). */
const WEB_HITS = 2;
/** He asked about the web or Jev's searches: one matching word is enough to show a find. */
const WEB_WANTED = /\b(?:web|online|internet|jev|searched|search(?:es)?|looked up|found)\b/i;
/** Vault folders of scraped or bulk-imported text: kept, but ranked below his own notes. */
/** What a closed note shows instead of its text (the prompts tell Alef what it means). */
export const CLOSED_NOTE = "(closed: this note holds credentials, so its text is kept out)";
/** What the notes block says while his notes are still being vetted (no taint yet). */
export const VETTING_NOTE = "(vetting: his notes are still being checked for credentials, so none could be read for this message)";
/** A session name that holds a credential is never shown. */
const CLOSED_SESSION = "(a session whose name holds credentials)";
/** How often the scanner re-sweeps in the background (incremental: only changed files are read,
 *  but every file is stat'ed, ~13 s here). Between sweeps, deep mode's tripwire scans what a
 *  lookup reads, so a credential written since the last sweep still ends the lookup. */
const SCAN_MAX_AGE_MS = 15 * 60_000;
/** Memory files that are directories of people (by their own name/description). */
const PEOPLE_FILE = /\b(?:who is|org (?:chart|map)|network|family|circle|team|people|contacts?)\b/i;
const NOISY_VAULT = /^(?:30-Knowledge\/(?:rss-feeds|notion-orb|notion-wiki|morning-briefs|_briefs)|Clippings|40-Resources)\//;

export interface VoiceRecallDeps {
  home: string;
  /** ~/.claude/projects/<home>/memory (a symlink into the vault on this Mac: resolved here). */
  memoryDir: string;
  vaultRoot: string;
  codeRoot: string;
  residentDir: string;
  /** BM25 over every vault note (the brain feature's index); ready=false while it builds. */
  vaultSearch(ctx: FeatureContext, q: string, limit: number): { ready: boolean; hits: readonly BrainSearchHit[] };
  /** Archived sessions (the archive feature's fossils), [] until its first scan. */
  archivedSessions(ctx: FeatureContext): readonly ArchivedSession[];
  /** A word list of common words (default /usr/share/dict/words): a heard word on it is never
   *  "corrected" to a name unless speech-to-text capitalised it mid-sentence. */
  dictionaryPath?: string;
  /** The credential scanner (default: one over deepRoots()). */
  credentials?: CredentialScanner;
  /** Jev's kept web trips (default: data/jev-web.jsonl beside world.db). */
  jevWeb?: (ctx: FeatureContext) => JevWebLog | null;
}

export interface RecallInput {
  text: string;
  agents: readonly WorldAgent[];
  islands: readonly Island[];
  now: Date;
}

export interface RecallResult {
  hits: RecallHit[];
  corrections: Correction[];
  /** The fenced prompt block, "" when nothing was found. */
  block: string;
  /** Best matches that were closed (they hold credentials): shown as CLOSED_NOTE, never quoted. */
  closed: number;
  /** Their paths (the turn reads their values, in memory only, so a reply never repeats one). */
  closedPaths?: string[];
  /** His notes are still being vetted (no taint yet after a fresh install, a rules change or a new
   *  root): none was read, and the block says so. */
  vetting?: boolean;
  ms: number;
  counts: Partial<Record<RecallSource, number>>;
  vaultReady: boolean;
  /** A plain dictionary word, compounds aside (the reply guard's test for "not a password");
   *  absent when there is no word list, and the guard then treats every word as unknown. */
  isWord?: (w: string) => boolean;
}

export interface VoiceRecall {
  retrieve(ctx: FeatureContext, input: RecallInput): Promise<RecallResult>;
  /** Starts building the memory index (and the vault index) without waiting; keeps the
   *  credential scan fresh. */
  warm(ctx: FeatureContext): void;
  /** The folders deep mode may read (real paths, deduped, existing). */
  deepRoots(): Promise<string[]>;
  /** Which files under deepRoots() hold credentials (closed to retrieval and to deep mode). */
  readonly credentials: CredentialScanner;
  /** Keeps the credential scan persisted and fresh (the feature's tick calls it). */
  maintain(ctx: FeatureContext): void;
  readonly home: string;
  readonly memoryDir: string;
  readonly vaultRoot: string;
  readonly codeRoot: string;
  readonly residentDir: string;
}

interface MemoryIndex {
  builtAt: number;
  /** The memory dir's real path (chunk paths are under it). */
  root: string;
  chunks: MemoryChunk[];
  /** Notes (abs paths) that hold credentials: ranked like the others, never quoted. */
  closed: Set<string>;
  bm25: BM25Index;
  lexicon: NameLexicon;
  /** A common word (the dictionary). Without a word list every word counts as common, so only a
   *  word capitalised mid-sentence may be corrected. */
  isCommonWord: (t: string) => boolean;
  /** A dictionary word as the reply guard reads one (no compounds); undefined without a word list. */
  isPlainWord: ((t: string) => boolean) | undefined;
  files: number;
  /** Built with the taint in place: an index built while notes were still being vetted has every
   *  note closed, and is rebuilt as soon as the taint lands. */
  vetted: boolean;
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isoDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A journal day's lesson records, oldest first, one per lesson: "- 05:41 · Tripwire: a subagent of
 *  a session in Home repeated a known lesson (slug): text" → "05:41 text" (the ~90-character
 *  preamble says nothing; a slug seen before is dropped), "Learned: text" as it is, and a "+N more
 *  (slug, slug)" line as the slugs it names. Reflections that merely mention lessons are not records. */
export function journalLessons(journal: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of journal.split("\n")) {
    const l = raw.replace(/^\s*[-*]\s*/, "").replace(/\s+/g, " ").trim();
    const rec = /^(?:(\d\d:\d\d)\s*·\s*)?(Tripwire|Learned)\s*:\s*(.*)$/i.exec(l);
    if (!rec) continue;
    const at = rec[1] ? `${rec[1]} ` : "";
    const body = rec[3] ?? "";
    const more = /^\+\d+ more \(([^)]*)\)$/.exec(body);
    if (more) {
      const slugs = (more[1] ?? "").split(/,\s*/).filter((x) => x && !seen.has(x));
      for (const x of slugs) seen.add(x);
      if (slugs.length) out.push(`${at}also ${slugs.join(", ")}`);
      continue;
    }
    const tw = /^.*?repeated a known lesson \(([^)]*)\):\s*(.*)$/.exec(body);
    if (tw) {
      const slug = tw[1] ?? "";
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(`${at}${tw[2] ?? ""}`);
    } else out.push(`${at}${body}`);
  }
  return out;
}

/** The lessons within `max` characters, each one at least begun: whole when they fit, else every
 *  lesson cut to an equal share (a lesson that is shorter gives its room to the others). */
export function fitLessons(lessons: readonly string[], max: number): string {
  const whole = lessons.join(" · ");
  if (whole.length <= max) return whole;
  const sep = 3 * (lessons.length - 1);
  let share = Math.floor((max - sep) / lessons.length);
  // Short lessons keep their text; their spare room goes to the long ones.
  for (let pass = 0; pass < 3; pass++) {
    const short = lessons.filter((l) => l.length <= share);
    const long = lessons.length - short.length;
    if (!long) break;
    share = Math.floor((max - sep - short.reduce((n, l) => n + l.length, 0)) / long);
  }
  return lessons.map((l) => (l.length <= share ? l : `${l.slice(0, Math.max(1, share - 1)).trimEnd()}…`)).join(" · ");
}

export function createVoiceRecall(deps: VoiceRecallDeps): VoiceRecall {
  const home = deps.home;
  async function deepRoots(): Promise<string[]> {
    const roots = await Promise.all([deps.codeRoot, deps.vaultRoot, deps.memoryDir, deps.residentDir].map(realOrResolved));
    const out: string[] = [];
    for (const r of roots) {
      if (isDeniedPath(r, home) || out.some((o) => r === o || r.startsWith(`${o}/`))) continue;
      try {
        if (!(await stat(r)).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push(r);
    }
    return out;
  }
  const credentials = deps.credentials ?? createCredentialScanner({ home, roots: deepRoots });
  /** The scan persists next to the world db, and is refreshed in the background. */
  function keepScanFresh(ctx: FeatureContext): void {
    if (ctx.config.dbPath !== ":memory:") credentials.persistTo(join(dirname(ctx.config.dbPath), "credential-scan.json"));
    credentials.maintain(SCAN_MAX_AGE_MS);
  }
  /** A session name is shown only when it holds no credential. */
  const safeName = (name: string): string => (scanText(name, "session-name.md").reasons.length ? CLOSED_SESSION : name);
  let memory: MemoryIndex | null = null;
  let building: Promise<MemoryIndex> | null = null;
  let dirs: { at: number; code: FolderCandidate[]; vault: FolderCandidate[] } | null = null;

  async function folderCandidates(now: number): Promise<{ code: FolderCandidate[]; vault: FolderCandidate[] }> {
    if (dirs && now - dirs.at < DIRS_TTL_MS) return dirs;
    const onlyDirs = (base: string, list: Dirent[]): FolderCandidate[] =>
      list.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: join(base, e.name) })).filter((c) => !isDeniedPath(c.path, home));
    const projects = join(deps.vaultRoot, "20-Projects");
    const [code, vaultTop, vaultProjects] = await Promise.all([listDir(deps.codeRoot), listDir(deps.vaultRoot), listDir(projects)]);
    dirs = { at: now, code: onlyDirs(deps.codeRoot, code), vault: [...onlyDirs(projects, vaultProjects), ...onlyDirs(deps.vaultRoot, vaultTop)] };
    return dirs;
  }

  let dict: Promise<Set<string> | null> | null = null;
  /** The common-word list, read once (~235k words); null when it is missing or empty. */
  function dictionary(): Promise<Set<string> | null> {
    dict ??= readFile(deps.dictionaryPath ?? "/usr/share/dict/words", "utf8").then(
      (t) => {
        const words = parseDictionary(t);
        return words.size ? words : null;
      },
      () => null,
    );
    return dict;
  }

  async function buildMemory(): Promise<MemoryIndex> {
    const vetted = credentials.vetted();
    const root = await realOrResolved(deps.memoryDir);
    const files: string[] = [];
    for (const sub of ["", "_L2"]) {
      for (const e of await listDir(join(root, sub))) {
        const abs = join(root, sub, e.name);
        if (e.isFile() && e.name.endsWith(".md") && !isDeniedPath(abs, home)) files.push(abs);
      }
    }
    const chunks: MemoryChunk[] = [];
    const texts: string[] = [];
    const closed = new Set<string>();
    for (const abs of files) {
      try {
        const st = await stat(abs);
        if (st.size === 0 || st.size > MEMORY_MAX_FILE_BYTES || (st.size > 0 && st.blocks === 0)) continue; // dataless iCloud file: never block on a download
        const full = await readFile(abs, "utf8");
        // A note that holds a credential is still ranked (so "my gym password" finds it and Alef
        // can say it is closed), but its text never reaches a passage or the name lexicon.
        if ((await credentials.verdict(abs)).excluded) closed.add(abs);
        else texts.push(full);
        chunks.push(...chunkNote(abs, full));
      } catch {
        /* raced delete / unreadable: skip */
      }
    }
    const docs: RecallDoc[] = chunks.map((c, i) => ({ path: String(i), title: `${c.name} ${c.description}`, snippet: c.text }));
    const { code, vault } = await folderCandidates(Date.now());
    const dict = await dictionary();
    return {
      builtAt: Date.now(),
      root,
      chunks,
      closed,
      bm25: buildIndex(docs),
      lexicon: buildNameLexicon(texts, [...code, ...vault].map((c) => c.name)),
      isCommonWord: dict ? (t) => inDictionary(t, dict) : () => true,
      isPlainWord: dict ? (t) => inDictionary(t, dict, false) : undefined,
      files: files.length,
      vetted,
    };
  }

  function ensureMemory(ctx: FeatureContext | null): Promise<MemoryIndex> {
    if (memory && Date.now() - memory.builtAt < MEMORY_TTL_MS && (memory.vetted || !credentials.vetted())) return Promise.resolve(memory);
    if (!building) {
      const t0 = Date.now();
      const b = buildMemory()
        .then((m) => {
          memory = m;
          ctx?.log.info("voice-brain", `memory index: ${m.files} files, ${m.chunks.length} chunks in ${Date.now() - t0} ms`);
          return m;
        })
        .finally(() => {
          building = null;
        });
      // A background rebuild (stale index still answering) has no awaiting caller: observe its
      // failure here so it can never become an unhandled rejection; the old index keeps serving.
      b.catch((err: unknown) => ctx?.log.warn("voice-brain", "memory index rebuild failed", String(err)));
      building = b;
    }
    // Stale-while-revalidate: an old index answers now; the fresh one lands for the next turn.
    return memory ? Promise.resolve(memory) : building;
  }

  /** The best notes for the terms. A closed note (it holds credentials) shows as CLOSED_NOTE when
   *  it is the best match, and is dropped otherwise. */
  async function memoryHits(m: MemoryIndex, terms: readonly string[], who: boolean, closedPaths: string[]): Promise<{ hits: RecallHit[]; closed: number }> {
    const scores = bm25Scores(m.bm25, terms.join(" "));
    const best = new Map<string, { chunk: MemoryChunk; score: number }>();
    for (const [ci, raw] of scores) {
      const doc = m.bm25.chunks[ci];
      const chunk = doc ? m.chunks[Number(doc.path)] : undefined;
      if (!chunk) continue;
      const base = chunk.path.split("/").pop() ?? "";
      // His identity, family and circle files answer most "who/what is X for me" questions, and a
      // paragraph that opens on the name ("Daughter: Maya — born…") usually defines it.
      const prior = base.startsWith("user_") ? 1.25 : base === "MEMORY.md" ? 0.6 : chunk.path.includes("/_L2/") ? 0.8 : 1;
      const opensOnIt = mentionsAny(chunk.text.slice(0, 60), terms) ? 1.6 : 1;
      // "Who is X?": his people directories (family, circle, org chart, network) define people.
      const directory = who && PEOPLE_FILE.test(`${chunk.name} ${chunk.description}`) ? 2 : 1;
      const score = raw * prior * opensOnIt * directory;
      const cur = best.get(chunk.path);
      if (!cur || score > cur.score) best.set(chunk.path, { chunk, score });
    }
    const ranked = [...best.values()].sort((a, b) => b.score - a.score);
    const top = ranked[0]?.score ?? 0;
    const ref = (path: string): string => displayRef(path, [{ root: m.root, label: "memory" }], home);
    const hits: RecallHit[] = [];
    let closed = 0;
    for (const [i, { chunk }] of ranked.filter((r) => r.score >= top * 0.35).entries()) {
      if (hits.length >= MEMORY_HITS) break;
      // The index lives 10 minutes: a note that gained a credential since is closed now (the
      // verdict is cached by mtime, so this costs one stat when nothing changed).
      if (m.closed.has(chunk.path) || (await credentials.verdict(chunk.path)).excluded) {
        if (i === 0) {
          hits.push({ source: "memory", ref: ref(chunk.path), text: CLOSED_NOTE });
          closedPaths.push(chunk.path);
          closed++;
        }
        continue;
      }
      const desc = chunk.description ? ` (${chunk.description.slice(0, 160)})` : "";
      hits.push({ source: "memory", ref: ref(chunk.path), text: `${chunk.name}${desc}: ${bestPassage(chunk.text, terms, 300)}` });
    }
    return { hits, closed };
  }

  async function vaultHits(ctx: FeatureContext, terms: readonly string[], memoryRel: string, closedPaths: string[]): Promise<{ hits: RecallHit[]; ready: boolean; closed: number }> {
    const r = deps.vaultSearch(ctx, terms.join(" "), 15);
    if (!r.ready) return { hits: [], ready: false, closed: 0 };
    const ranked = r.hits
      .filter((h) => !(memoryRel && h.path.startsWith(`${memoryRel}/`)) && !isDeniedPath(join(deps.vaultRoot, h.path), home))
      .map((h) => ({ h, score: h.score * (NOISY_VAULT.test(h.path) ? 0.4 : 1) }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0]?.score ?? 0;
    const out: RecallHit[] = [];
    let closed = 0;
    /** A relevant note was already seen: a closed one after it is not the best match. */
    let sawRelevant = false;
    for (const { h, score } of ranked) {
      if (out.length >= VAULT_HITS || score < top * 0.3) break;
      const target = await resolveInside(deps.vaultRoot, h.path);
      if (!target.ok || isDeniedPath(target.abs, home)) continue;
      if ((await credentials.verdict(target.abs)).excluded) {
        // The best relevant vault match holds credentials: say so, never what it says. (Its title
        // and the index's snippet only decide relevance here; neither is shown.)
        if (!sawRelevant && mentionsAny(`${h.title} ${h.snippet}`, terms)) {
          out.push({ source: "vault", ref: `vault/${target.rel}`, text: CLOSED_NOTE });
          closedPaths.push(target.abs);
          closed++;
          sawRelevant = true;
        }
        continue;
      }
      const read = await readTextCapped(target.abs, VAULT_NOTE_MAX_BYTES);
      const body = read.ok ? cleanBody(splitFrontmatter(read.text).body) : h.snippet;
      const passage = bestPassage(body, terms, 320);
      if (!mentionsAny(`${h.title} ${passage}`, terms)) continue;
      sawRelevant = true;
      out.push({ source: "vault", ref: `vault/${target.rel}`, text: `${h.title}: ${passage}` });
    }
    return { hits: out, ready: true, closed };
  }

  function sessionRefs(ctx: FeatureContext, agents: readonly WorldAgent[], islands: readonly Island[]): SessionRef[] {
    const byIsland = new Map(islands.map((i) => [i.id, displayIslandName(i)]));
    const touched = new Map<string, string[]>();
    for (const e of ctx.db.listEdges()) {
      if (e.kind !== "touched" || !e.to.startsWith("file:")) continue;
      const list = touched.get(e.from) ?? [];
      list.push(e.to.slice(5));
      touched.set(e.from, list);
    }
    const live = agents.map((a) => {
      const r = agentRef(a, byIsland.get(a.islandId) ?? a.islandId, touched.get(a.id) ?? []);
      return { ...r, name: safeName(r.name) };
    });
    const known = new Set(live.map((s) => s.id.toLowerCase()));
    const fossils = deps
      .archivedSessions(ctx)
      .filter((f) => !known.has(f.id.toLowerCase()))
      .flatMap((f) => {
        const r = fossilRef(f);
        return r ? [{ ...r, name: safeName(r.name) }] : [];
      });
    return [...live, ...fossils];
  }

  async function residentHit(day: Date, closedPaths: string[]): Promise<RecallHit | null> {
    const abs = join(deps.residentDir, "journal", `${isoDay(day)}.md`);
    if (isDeniedPath(abs, home)) return null;
    const ref = `resident journal ${isoDay(day)}`;
    if ((await credentials.verdict(abs)).excluded) {
      closedPaths.push(abs);
      return { source: "resident", ref, text: CLOSED_NOTE };
    }
    const read = await readTextCapped(abs, RESIDENT_MAX_BYTES);
    if (!read.ok) return { source: "resident", ref, text: "No journal entries that day." };
    const text = read.text
      .replace(/^# .*$/m, "")
      .replace(/^## (\d\d:\d\d) · (\w+)$/gm, "[$1 $2]")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= RESIDENT_HIT_CHARS) return { source: "resident", ref, text };
    // A long day: every lesson first (what it learnt is the usual question), then the latest
    // entries with whatever room is left.
    const lessons = journalLessons(read.text);
    if (!lessons.length) return { source: "resident", ref, text: `…${text.slice(-(RESIDENT_HIT_CHARS - 1))}` };
    const head = `Lessons: ${fitLessons(lessons, RESIDENT_HIT_CHARS - 9)}`;
    const room = RESIDENT_HIT_CHARS - head.length - 12;
    return { source: "resident", ref, text: room >= 80 ? `${head} … latest: ${text.slice(-room)}` : head };
  }

  /** Jev's earlier web finds for the terms, as notes. Third-party text: only while his notes are
   *  vetted (the caller returned earlier otherwise), never one the credential rules flag (the log
   *  drops those on read) or that repeats a closed file's value (the taint; no taint, no finds).
   *  What goes in the block then passes the turn's copy guard, number blackout and redactor like
   *  every other note. */
  async function webHits(ctx: FeatureContext, text: string, terms: readonly string[], now: Date): Promise<RecallHit[]> {
    const log = (deps.jevWeb ?? ((c: FeatureContext) => jevWebLogFor(c.config.dbPath)))(ctx);
    const taint = credentials.taint();
    if (!log || !terms.length) return [];
    await log.refresh();
    const need = WEB_WANTED.test(text) ? 1 : Math.min(2, terms.length);
    return citableFinds(log.search(terms.join(" "), WEB_HITS * 3), taint, need, WEB_HITS).map((f) => ({
      source: "web",
      ref: `web/${f.host}`,
      text: `Jev searched the web ${findAge(f.at, now.getTime())} for "${f.question}" and found: ${f.title}`,
    }));
  }

  async function folderHit(text: string): Promise<RecallHit | null> {
    const { code, vault } = await folderCandidates(Date.now());
    const c = matchFolder(text, [...code, ...vault]);
    if (!c || isDeniedPath(c.path, home)) return null;
    const all = (await listDir(c.path)).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    // Files that hold credentials are never listed, not even by name: only counted.
    const closedNames = new Set<string>();
    const files = all.filter((e) => !e.dir && !e.name.startsWith(".")).slice(0, 400);
    for (let i = 0; i < files.length; i += 16)
      await Promise.all(
        files.slice(i, i + 16).map(async (e) => {
          if ((await credentials.verdict(join(c.path, e.name))).excluded) closedNames.add(e.name);
        }),
      );
    const entries = all.filter((e) => !closedNames.has(e.name));
    const label = displayRef(c.path, [{ root: deps.vaultRoot, label: "vault" }], home);
    const n = closedNames.size;
    const note = n ? ` (${n} more file${n === 1 ? " holds" : "s hold"} credentials and stay${n === 1 ? "s" : ""} closed.)` : "";
    return { source: "folder", ref: label, text: `${renderListing(`The folder ${label}`, c.path, entries, home, 650 - note.length)}${note}` };
  }

  const recall: VoiceRecall = {
    home,
    memoryDir: deps.memoryDir,
    vaultRoot: deps.vaultRoot,
    codeRoot: deps.codeRoot,
    residentDir: deps.residentDir,
    credentials,

    warm(ctx) {
      keepScanFresh(ctx);
      void ensureMemory(ctx).catch((err: unknown) => ctx.log.warn("voice-brain", "memory index failed", String(err)));
      deps.vaultSearch(ctx, "warm", 1);
    },

    deepRoots,

    maintain: keepScanFresh,

    async retrieve(ctx, input) {
      const t0 = Date.now();
      const text = input.text;
      const words = queryWords(text);
      const range = parseDayRange(text, input.now);
      const folderWanted = wantsFolderListing(text);
      const residentWanted = /\bresident\b/i.test(text);
      // A day alone ("what happened yesterday") means sessions, unless it is about the resident.
      const sessionsWanted = wantsSessionHistory(text) || (range !== null && !residentWanted);
      const empty: RecallResult = { hits: [], corrections: [], block: "", closed: 0, ms: 0, counts: {}, vaultReady: true };
      keepScanFresh(ctx);
      if (isWorldOnly(words.terms) && !sessionsWanted && !folderWanted && !residentWanted) return { ...empty, ms: Date.now() - t0 };

      // Not vetted yet (the first sweep after a fresh install, a rules change or a new root): a note
      // the rules find clean may still repeat a closed note's value, so none is read. The session
      // list (names from the world database, checked by the rules) still answers.
      if (!credentials.vetted()) {
        const hits: RecallHit[] = [];
        if (sessionsWanted && range) hits.push({ source: "sessions", ref: `sessions ${range.label}`, text: renderDaySessions(range, sessionsInRange(sessionRefs(ctx, input.agents, input.islands), range), 700) });
        const packed = packHits(hits);
        return { ...empty, hits: packed, block: renderRecallBlock(packed, [], VETTING_NOTE), vetting: true, ms: Date.now() - t0 };
      }
      const m = await ensureMemory(ctx);
      const vocab = m.bm25.postings;
      const { terms, searchTerms, corrections } = correctTerms(words, m.lexicon, (t) => Object.prototype.hasOwnProperty.call(vocab, t), m.isCommonWord);
      const noteTerms = isWorldOnly(terms) ? [] : terms;

      const ordered: RecallHit[] = [];
      const closedPaths: string[] = [];
      let closed = 0;
      if (folderWanted) {
        const f = await folderHit(text);
        if (f) ordered.push(f);
      }
      if (sessionsWanted) {
        const refs = sessionRefs(ctx, input.agents, input.islands);
        if (range) ordered.push({ source: "sessions", ref: `sessions ${range.label}`, text: renderDaySessions(range, sessionsInRange(refs, range), 700) });
        if (noteTerms.length && wantsSessionHistory(text)) {
          const matches = matchSessionsByTopic(range ? sessionsInRange(refs, range) : refs, noteTerms).slice(0, 12);
          ordered.push({ source: "sessions", ref: `sessions about "${noteTerms.join(" ")}"`, text: renderTopicSessions(noteTerms, matches, 700) });
        }
      }
      if (residentWanted) {
        const r = await residentHit(range ? new Date(range.startMs) : input.now, closedPaths);
        if (r) ordered.push(r);
        if (r?.text === CLOSED_NOTE) closed++;
      }
      let vaultReady = true;
      if (noteTerms.length) {
        const mh = await memoryHits(m, noteTerms, /\bwho(?:'s|\s+(?:is|are|was))\b/i.test(text), closedPaths);
        ordered.push(...mh.hits);
        closed += mh.closed;
        const memoryRel = relative(await realOrResolved(deps.vaultRoot), await realOrResolved(deps.memoryDir));
        // The vault also searches the heard word (the memory index never knows a corrected one): a
        // wrong guess never drops what he said.
        const v = await vaultHits(ctx, searchTerms, memoryRel.startsWith("..") ? "" : memoryRel, closedPaths);
        vaultReady = v.ready;
        closed += v.closed;
        ordered.push(...v.hits);
        ordered.push(...(await webHits(ctx, text, noteTerms, input.now)));
      }
      const hits = packHits(ordered);
      const counts: Partial<Record<RecallSource, number>> = {};
      for (const h of hits) counts[h.source] = (counts[h.source] ?? 0) + 1;
      return { hits, corrections, block: renderRecallBlock(hits, corrections), closed, closedPaths, ms: Date.now() - t0, counts, vaultReady, ...(m.isPlainWord ? { isWord: m.isPlainWord } : {}) };
    },
  };
  return recall;
}

/** Alex's real layout on this Mac. */
export function defaultRecallPaths(home = homedir()): Pick<VoiceRecallDeps, "home" | "memoryDir" | "vaultRoot" | "codeRoot" | "residentDir"> {
  const user = home.split("/").filter(Boolean).join("-");
  return {
    home,
    memoryDir: join(home, ".claude", "projects", `-${user}`, "memory"),
    vaultRoot: vaultRoot(home),
    codeRoot: join(home, "Documents", "Code"),
    residentDir: join(home, ".alef-resident"),
  };
}
