// The credential scanner's IO (rules: credential-scan-lib.ts). It walks every folder the voice
// brain can reach (the deep roots: ~/Documents/Code with the vault and memory, ~/.alef-resident)
// and keeps the set of files that hold credentials. Those files are CLOSED: retrieval never uses
// or lists them, deep mode gets a deny rule for each, and its tripwire kills a lookup that
// touches one.
//
// Two nets. The rules close a file by what it SAYS (a label, a code near a door…). Then the VALUES
// the rules found in every closed file are tainted (credential-taint-lib.ts: keyed hashes only) and
// close every other file that repeats one ("tainted-value"), with no credential word near it: a
// master code pasted bare into another note. A value more than COMMON_FILES open files repeat is
// nobody's secret (a URL, a code identifier, a word the rules took for a value): it closes nothing
// and is never withheld. The taint is rebuilt each sweep from the closed files. Every open file is
// read again for it in a census: once per process (the counts live in memory), then when it gained
// a value, at most every CENSUS_EVERY_MS (a census reads every file: minutes of background work).
// Between two, a file that changed is checked by the walk, and a file asked about (retrieval, the
// memory index) is checked against the values gained since the census before it is let through.
//
// Cached by path + mtime + size (a 53-bit fingerprint per clean file, a small map for the
// excluded ones), so a sweep only re-reads what changed. Reads are bounded: a file over maxBytes,
// or an iCloud placeholder whose bytes are not on disk, is never read and stays closed
// ("unvetted"). Only paths, reason classes and a digest of the closed files' paths and versions are
// persisted; values are read on request, in memory, and the taint keeps only keyed hashes.

import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CREDENTIAL_REASONS, fileKind, isUnscannedDirName, isUnscannedFileName, pathKey, SCANNER_RULES_VERSION, scanName, scanText, type CredentialReason } from "./credential-scan-lib.js";
import { randomTaintKey, taintEntries, TaintSet, TIER_FILE, TIER_SPOKEN, type TaintEntry, type TaintKey } from "./credential-taint-lib.js";
import { inDictionary, isDeniedPath, parseDictionary } from "./voice-brain-recall-lib.js";

export interface Verdict {
  excluded: boolean;
  reasons: CredentialReason[];
}

export interface TaintStatus {
  /** The taint is built in this process (it is rebuilt from the closed files after a restart). */
  ready: boolean;
  /** Closed files whose values feed it, and the values that were eligible. */
  sources: number;
  values: number;
  /** Keyed hashes held (values, their long prefixes and suffixes). */
  entries: number;
  /** Of those, the ones too common to taint (more than COMMON_FILES open files repeat them). */
  common: number;
  /** Open files kept for the counts: they repeat a value that is not common (closed or not). */
  repeating: number;
  /** Values gained since the last census (a verdict checks a cached open file against them). */
  pending: number;
  /** When the last census of every open file ended (null: none in this process yet). */
  lastCensusAt: number | null;
  /** The last re-read of open files for the taint (full: a census). */
  lastRecheck: { files: number; ms: number; full: boolean } | null;
}

export interface CredentialScanStatus {
  /** A full sweep has completed: the excluded set covers every file under the roots. */
  ready: boolean;
  sweeping: boolean;
  /** Files seen by the last complete sweep. */
  files: number;
  excluded: number;
  byReason: Partial<Record<CredentialReason, number>>;
  lastSweepMs: number | null;
  lastSweepAt: number | null;
  /** Files (re)read by the last sweep: the rest were unchanged. */
  lastSweepRead: number;
  taint: TaintStatus;
}

export interface CredentialScannerOptions {
  home: string;
  /** The folders to vet (real paths). */
  roots(): Promise<string[]>;
  /** Largest file read in full (default 2 MiB). Bigger text files stay closed, unread. */
  maxBytes?: number;
  /** Parallel stat/read operations during a sweep (default 32). */
  concurrency?: number;
  now?(): number;
  /** Every file actually read by the rules (tests count re-reads). */
  onRead?(abs: string): void;
  /** Every file read for the taint: a closed file's values, or a clean file re-checked. */
  onTaintRead?(abs: string, why: "values" | "recheck"): void;
  /** Where the scan persists between restarts (paths, fingerprints and reason classes only; no
   *  values), so only the first sweep ever reads everything. Also settable later (persistTo). */
  cacheFile?: string;
  /** The taint's hash key (default: random per process). */
  taintKey?: TaintKey;
  /** A value more open files than this repeat is too common to taint (default COMMON_FILES). */
  commonFiles?: number;
  /** The least time between two censuses of every open file (default CENSUS_EVERY_MS). */
  censusEveryMs?: number;
  /** A word list: a letters-only value that is a word taints no other file (default
   *  /usr/share/dict/words; without one, every letters-only value of 12+ letters does). */
  dictionaryPath?: string;
}

export interface CredentialScanner {
  /** One file's verdict: cached by path + mtime + size, else read (bounded) and scanned now. */
  verdict(abs: string): Promise<Verdict>;
  /** What is known right now (sweeps and verdicts so far), case- and Unicode-insensitive. */
  isExcluded(abs: string): boolean;
  /** Every excluded file, with its reason classes. */
  excluded(): Array<{ path: string; reasons: CredentialReason[] }>;
  /** One incremental pass over every root (joins the running one). */
  sweep(): Promise<CredentialScanStatus>;
  /** Starts a sweep when none has run, the taint is not built yet, or the last is older than
   *  `maxAgeMs`; never waits. */
  maintain(maxAgeMs: number): void;
  /** Resolves true once a full sweep has completed and the taint is built (starting a sweep if
   *  needed), false on timeout. */
  whenReady(timeoutMs: number): Promise<boolean>;
  /** The values one file holds (for the spoken filter, when a lookup somehow saw it): in memory only. */
  valuesOf(abs: string): Promise<string[]>;
  /** The closed files' values as keyed hashes (null until this process built it; after a rules or
   *  roots change, first a provisional one from the files closed before). */
  taint(): TaintSet | null;
  /** The taint is built from a complete sweep under the current rules and roots: until then a
   *  file the rules find clean is closed as unvetted, and retrieval reads no note. */
  vetted(): boolean;
  status(): CredentialScanStatus;
  /** Persists the scan to `file` from now on, and restores it first when it exists. */
  persistTo(file: string): void;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** Texts over this are scanned in slices, yielding to the event loop between them. */
const SLICE_CHARS = 128 * 1024;
const CLEAN: Verdict = { excluded: false, reasons: [] };
const TAINTED: CredentialReason[] = ["tainted-value"];
/** A file the rules found clean that no taint could check yet (the first sweep after a fresh
 *  install, a rules change or a new root): closed for now, never cached as such. */
const UNVETTED: Verdict = { excluded: true, reasons: ["unvetted"] };
/** A value from a closed file of these kinds is never too common to taint: a master or recovery
 *  code copied into a dozen checkouts is still his master code. */
const NEVER_COMMON: readonly CredentialReason[] = ["password-manager", "recovery-code"];
/** A value repeated by more open files than this is nobody's secret. Measured on the real corpus
 *  (PR #38): a master code sits in 2 other notes; the values that closed tens of thousands of
 *  files were code and URL fragments the rules took for values. */
export const COMMON_FILES = 12;
/** A census re-reads every open file (on this Mac, ~320,000 files in 5-10 minutes of background
 *  work): at most this often once the process has had its first. */
export const CENSUS_EVERY_MS = 6 * 60 * 60_000;

/** A 53-bit fingerprint of a file's identity and version (two FNV-1a passes). */
function fingerprint(abs: string, st: Stats): number {
  return hash53(`${abs}\0${st.mtimeMs}\0${st.size}\0${st.ino}`);
}

function hash53(s: string): number {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff);
}

/** An iCloud file whose bytes are not on this disk: reading it would start a download (and can
 *  hang the reader), so it is never read. */
function isDataless(st: Stats): boolean {
  return st.size > 0 && st.blocks === 0;
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** scanText over a big text in line-aligned slices (20 lines of overlap, so a table or a label
 *  cut at a slice edge is still seen whole), yielding between slices: the live server keeps
 *  answering while a sweep reads a megabyte of HTML. */
async function scanSliced(text: string, abs: string, collectValues = false): Promise<{ reasons: CredentialReason[]; values: string[] }> {
  if (text.length <= SLICE_CHARS) return scanText(text, abs, { collectValues });
  const lines = text.split("\n");
  const reasons = new Set<CredentialReason>();
  const values = new Set<string>();
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (size < SLICE_CHARS || end === start)) size += (lines[end++] ?? "").length + 1;
    const r = scanText(lines.slice(Math.max(0, start - 20), end).join("\n"), abs, { collectValues });
    for (const x of r.reasons) reasons.add(x);
    for (const v of r.values) values.add(v);
    start = end;
    await yieldToLoop();
  }
  return { reasons: [...reasons], values: [...values] };
}

async function readBounded(abs: string, max: number): Promise<string | null> {
  const fh = await open(abs, "r");
  try {
    const st = await fh.stat();
    const n = Math.min(st.size, max);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.subarray(0, 8192).includes(0)) return null; // binary
    return data.toString("utf8");
  } finally {
    await fh.close();
  }
}

/** A small pool: at most `n` tasks in flight. */
function pool(n: number): { submit(task: () => Promise<void>): Promise<void>; drain(): Promise<void> } {
  const inflight = new Set<Promise<void>>();
  return {
    async submit(task) {
      while (inflight.size >= n) await Promise.race(inflight);
      const p: Promise<void> = task().finally(() => inflight.delete(p));
      inflight.add(p);
    },
    async drain() {
      await Promise.all(inflight);
    },
  };
}

export function createCredentialScanner(opts: CredentialScannerOptions): CredentialScanner {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const concurrency = Math.max(1, opts.concurrency ?? 32);
  const now = opts.now ?? Date.now;
  const taintKey = opts.taintKey ?? randomTaintKey();
  const commonFiles = opts.commonFiles ?? COMMON_FILES;
  const censusEvery = opts.censusEveryMs ?? CENSUS_EVERY_MS;
  let dict: Promise<((w: string) => boolean) | undefined> | null = null;
  /** The word list, read once (a missing one: no word test). */
  const isWord = (): Promise<((w: string) => boolean) | undefined> => {
    dict ??= readFile(opts.dictionaryPath ?? "/usr/share/dict/words", "utf8").then(
      (t) => {
        const words = parseDictionary(t);
        return words.size ? (w: string) => inDictionary(w, words, false) : undefined;
      },
      () => undefined,
    );
    return dict;
  };
  /** Fingerprints of files that are clean by the rules AND checked against the taint. */
  let clean = new Set<number>();
  /** Excluded files: abs path → fingerprint + reasons. */
  const flagged = new Map<string, { fp: number; reasons: CredentialReason[] }>();
  /** pathKey → abs, for the tripwire's case-insensitive lookups. */
  const flaggedKeys = new Map<string, string>();
  let ready = false;
  let running: Promise<CredentialScanStatus> | null = null;
  let last: Omit<CredentialScanStatus, "ready" | "sweeping" | "excluded" | "byReason" | "taint"> = { files: 0, lastSweepMs: null, lastSweepAt: null, lastSweepRead: 0 };
  /** Clean fingerprints learnt while a sweep runs (kept when it swaps its set in). */
  let sideClean: Set<number> | null = null;
  let cacheFile = opts.cacheFile ?? null;
  let loading: Promise<void> | null = null;
  /** Files a cache made under other rules or roots had closed by the rules: read first for a
   *  provisional taint, so the first walk checks what it reads against their values. */
  let staleSources: string[] = [];
  /** The taint in place is the provisional one: it closes what repeats its values, but vets nothing. */
  let provisional = false;

  // The taint: each closed file's hashed values (by the version of the file they came from), the
  // set built from them, which open files repeat which of them, and what the open files were last
  // checked against. All in memory: keys are random per process, so nothing of it is persisted.
  const contrib = new Map<string, { fp: number; entries: TaintEntry[]; values: number }>();
  /** Every value (to count who repeats it), and the set in use: without the common ones. */
  let fullSet: TaintSet | null = null;
  let taintSet: TaintSet | null = null;
  /** Open files that repeat a value: their version, the values' keys, and a hash of the content
   *  (copies of one file in several checkouts count once). */
  const repeats = new Map<string, { fp: number; keys: number[]; ch: number }>();
  /** Keys never too common to taint (from a password manager's or a recovery code's file). */
  let neverCommon = new Set<number>();
  /** Keys more than `commonFiles` open files repeat, and those the last census found common (they
   *  stay common until the next one: their repeating files are not kept). */
  let common = new Set<number>();
  let sticky = new Set<number>();
  /** The keys the last census checked every open file against (null: none in this process yet). */
  let censusKeys: Set<number> | null = null;
  let censusAt = 0;
  /** The keys at the end of the last sweep (a walk reads new files against the taint before it). */
  let sweptKeys = new Set<number>();
  /** Values gained since the census (file tier, not common), and the files a verdict checked
   *  against this generation of them. */
  let pending: TaintSet | null = null;
  let pendingGen = 0;
  const checkedGen = new Map<number, number>();
  let lastRecheck: TaintStatus["lastRecheck"] = null;
  /** Called whenever `ready` or the taint changes (whenReady waits on it). */
  const waiters = new Set<() => void>();
  const notify = (): void => {
    for (const w of [...waiters]) w();
  };

  /** Restores a persisted scan made under the same rules and roots (once). */
  function load(): Promise<void> {
    loading ??= (async () => {
      if (!cacheFile) return;
      try {
        const o = JSON.parse(await readFile(cacheFile, "utf8")) as { v?: unknown; roots?: unknown; clean?: unknown; flagged?: unknown; files?: unknown; at?: unknown };
        const roots = await opts.roots();
        if (!Array.isArray(o.clean) || !Array.isArray(o.flagged)) return;
        const rows: Array<[string, number, CredentialReason[]]> = [];
        for (const row of o.flagged) {
          if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "number" || !Array.isArray(row[2])) continue;
          const reasons = row[2].filter((r): r is CredentialReason => (CREDENTIAL_REASONS as readonly unknown[]).includes(r));
          if (reasons.length) rows.push([row[0], row[1], reasons]);
        }
        if (o.v !== SCANNER_RULES_VERSION || JSON.stringify(o.roots) !== JSON.stringify(roots)) {
          // Other rules or roots: nothing of it is trusted, but what it had closed by the rules is
          // read first for a provisional taint, and what it had closed only for repeating a value
          // stays closed until this process's census counts again.
          const inRoots = (p: string): boolean => roots.some((r) => p === r || p.startsWith(`${r}/`));
          for (const [p, fp, reasons] of rows) {
            if (!inRoots(p)) continue;
            if (isSource(reasons)) staleSources.push(p);
            else setFlagged(p, fp, TAINTED);
          }
          return;
        }
        for (const fp of o.clean) if (typeof fp === "number") clean.add(fp);
        for (const [p, fp, reasons] of rows) setFlagged(p, fp, reasons);
        ready = true;
        last = { files: typeof o.files === "number" ? o.files : 0, lastSweepMs: null, lastSweepAt: typeof o.at === "number" ? o.at : null, lastSweepRead: 0 };
      } catch {
        /* no cache yet, or unreadable: the first sweep reads everything */
      }
    })();
    return loading;
  }

  async function save(roots: readonly string[]): Promise<void> {
    if (!cacheFile) return;
    const body = JSON.stringify({
      v: SCANNER_RULES_VERSION,
      roots,
      at: last.lastSweepAt,
      files: last.files,
      clean: [...clean],
      flagged: [...flagged.entries()].map(([p, f]) => [p, f.fp, f.reasons]),
    });
    await mkdir(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, cacheFile);
  }

  function setFlagged(abs: string, fp: number, reasons: CredentialReason[]): void {
    flagged.set(abs, { fp, reasons });
    flaggedKeys.set(pathKey(abs), abs);
  }
  function unflag(abs: string): void {
    if (flagged.delete(abs)) flaggedKeys.delete(pathKey(abs));
  }

  /** A closed file whose values feed the taint (closed by the rules, not by the taint itself). */
  const isSource = (reasons: readonly CredentialReason[]): boolean => reasons.some((r) => r !== "tainted-value");

  /** True when a file repeating these keys closes: one of them is a file-tier value that is not
   *  common. */
  const closes = (keys: readonly number[]): boolean => keys.some((k) => ((fullSet?.tiersOf(k) ?? 0) & TIER_FILE) !== 0 && !common.has(k));

  /** Records which values an open file repeats; true when that closes it. */
  function noteRepeats(abs: string, fp: number, text: string): boolean {
    const keys = fullSet?.textKeys(text, TIER_SPOKEN) ?? [];
    if (!keys.length) {
      repeats.delete(abs);
      return false;
    }
    repeats.set(abs, { fp, keys, ch: hash53(text) });
    return closes(keys);
  }

  /** Reads one closed file's values (bounded, in slices) and hashes them; the plaintext is dropped
   *  when this returns. */
  async function hashValuesOf(abs: string): Promise<{ entries: TaintEntry[]; values: number }> {
    try {
      const st = await stat(abs);
      if (!st.isFile() || isDataless(st) || st.size === 0 || st.size > maxBytes || fileKind(abs) === "binary") return { entries: [], values: 0 };
      opts.onTaintRead?.(abs, "values");
      const text = await readBounded(abs, maxBytes);
      if (text === null) return { entries: [], values: 0 };
      const entries = new Map<number, TaintEntry>();
      let values = 0;
      const word = await isWord();
      for (const v of (await scanSliced(text, abs, true)).values) {
        const es = taintEntries(taintKey, v, word);
        if (es.length) values++;
        for (const e of es) {
          const cur = entries.get(e.k);
          if (cur) cur.tiers |= e.tiers;
          else entries.set(e.k, { ...e });
        }
      }
      return { entries: [...entries.values()], values };
    } catch {
      return { entries: [], values: 0 };
    }
  }

  /** Brings the taint up to date with the closed files: re-reads only a closed file that is new or
   *  changed, forgets one that reopened or is gone, and rebuilds the set. */
  async function refreshTaint(): Promise<void> {
    const sources = [...flagged.entries()].filter(([, f]) => isSource(f.reasons));
    const live = new Set(sources.map(([p]) => p));
    for (const p of [...contrib.keys()]) if (!live.has(p)) contrib.delete(p);
    const work = pool(Math.min(concurrency, 8));
    for (const [abs, f] of sources) {
      if (contrib.get(abs)?.fp === f.fp) continue;
      await work.submit(async () => {
        const r = await hashValuesOf(abs);
        contrib.set(abs, { fp: f.fp, ...r });
      });
    }
    await work.drain();
    const set = new TaintSet(taintKey);
    for (const c of contrib.values()) for (const e of c.entries) set.add(e);
    neverCommon = new Set<number>();
    for (const [abs, f] of sources) if (f.reasons.some((r) => NEVER_COMMON.includes(r))) for (const e of contrib.get(abs)?.entries ?? []) neverCommon.add(e.k);
    for (const k of neverCommon) common.delete(k);
    fullSet = set;
    taintSet = set.without(common);
    provisional = false;
    notify();
  }

  /** Before the first walk under new rules or roots: a taint from the files closed before, read
   *  with today's rules (they are re-judged by the walk; the full taint follows it). */
  async function provisionalTaint(): Promise<void> {
    const work = pool(Math.min(concurrency, 8));
    for (const abs of staleSources)
      await work.submit(async () => {
        try {
          const st = await stat(abs);
          if (!st.isFile()) return;
          contrib.set(abs, { fp: fingerprint(abs, st), ...(await hashValuesOf(abs)) });
        } catch {
          /* gone since: nothing to read */
        }
      });
    await work.drain();
    staleSources = [];
    const set = new TaintSet(taintKey);
    for (const c of contrib.values()) for (const e of c.entries) set.add(e);
    fullSet = set;
    taintSet = set.without(common);
    provisional = true;
    notify();
  }

  /** Counts which open files repeat each value, drops the common ones, and closes (or reopens) each
   *  repeating file by what is left. `live`: a file of this walk (a gone one is forgotten). */
  function applyRepeats(live: (abs: string, fp: number) => boolean, into: Set<number>): void {
    // Distinct contents per value: the same file in two checkouts is one copy, not two.
    const counts = new Map<number, Set<number>>();
    for (const [abs, r] of repeats) {
      if (!live(abs, r.fp)) {
        repeats.delete(abs);
        continue;
      }
      for (const k of r.keys) {
        const c = counts.get(k) ?? new Set<number>();
        c.add(r.ch);
        counts.set(k, c);
      }
    }
    common = new Set([...sticky, ...[...counts].filter(([, n]) => n.size > commonFiles).map(([k]) => k)].filter((k) => !neverCommon.has(k)));
    // Closed only for repeating a value, and now repeating none (its value is gone): reopens.
    for (const [abs, f] of [...flagged])
      if (!isSource(f.reasons) && !repeats.has(abs)) {
        unflag(abs);
        into.add(f.fp);
      }
    for (const [abs, r] of repeats) {
      const f = flagged.get(abs);
      if (f && isSource(f.reasons)) continue; // closed by the rules: its own values feed the taint
      if (closes(r.keys)) {
        into.delete(r.fp);
        clean.delete(r.fp);
        if (!f || f.fp !== r.fp) setFlagged(abs, r.fp, TAINTED);
      } else {
        if (f) unflag(abs);
        into.add(r.fp);
      }
    }
    if (fullSet) taintSet = fullSet.without(common);
  }

  /** Re-reads open files (and files closed only by the taint) for the values they repeat; the
   *  counts decide after (applyRepeats). Each file read joins `into` for now. */
  async function recheck(files: ReadonlyArray<readonly [string, number]>, into: Set<number>): Promise<number> {
    if (!fullSet) return 0;
    let read = 0;
    let lastYield = Date.now();
    const work = pool(concurrency);
    for (const [abs, fp] of files) {
      await work.submit(async () => {
        try {
          let st = await lstat(abs);
          if (st.isSymbolicLink()) st = await stat(abs);
          // isDataless too: the bytes are not on this disk, so readBounded would block in pread for
          // as long as iCloud takes, holding a libuv threadpool slot. The fingerprint is size+mtime,
          // which eviction does not change, so without this every recheck re-reads the same file.
          if (!st.isFile() || isDataless(st) || fingerprint(abs, st) !== fp) return; // changed since: the next sweep reads it
          opts.onTaintRead?.(abs, "recheck");
          read++;
          const text = await readBounded(abs, maxBytes);
          if (text !== null) noteRepeats(abs, fp, text);
          into.add(fp);
        } catch {
          /* raced delete: nothing to check */
        }
        if (Date.now() - lastYield > 20) {
          lastYield = Date.now();
          await yieldToLoop();
        }
      });
    }
    await work.drain();
    return read;
  }

  /** Reads and scans one file (never a dataless or oversized one). `taintChecked` is false when the
   *  file is clean by the rules but no taint was built yet to check it against. */
  async function scanFile(abs: string, st: Stats, fp: number): Promise<{ reasons: CredentialReason[]; taintChecked: boolean }> {
    const reasons = new Set<CredentialReason>(scanName(abs));
    if (fileKind(abs) === "binary" || st.size === 0) return { reasons: [...reasons], taintChecked: true };
    if (isDataless(st) || st.size > maxBytes) {
      reasons.add("unvetted");
      return { reasons: [...reasons], taintChecked: true };
    }
    opts.onRead?.(abs);
    let text: string | null = null;
    try {
      text = await readBounded(abs, maxBytes);
      if (text !== null) for (const r of (await scanSliced(text, abs)).reasons) reasons.add(r);
    } catch {
      reasons.add("unvetted"); // unreadable now: closed until a later sweep can read it
    }
    if (reasons.size || text === null) return { reasons: [...reasons], taintChecked: true };
    if (!fullSet) return { reasons: [], taintChecked: false };
    // A provisional taint (other rules or roots before) closes what repeats its values, but a file
    // it lets through is not vetted: a file only the new rules close may hold the value it repeats.
    return { reasons: noteRepeats(abs, fp, text) ? TAINTED : [], taintChecked: !provisional };
  }

  /** The verdict for a file whose stat we have, from the cache or a fresh scan. */
  async function judge(abs: string, st: Stats, into: Set<number>, onDemand = false): Promise<{ verdict: Verdict; read: boolean; fp: number; taintChecked: boolean }> {
    const fp = fingerprint(abs, st);
    const f = flagged.get(abs);
    if (f && f.fp === fp) return { verdict: { excluded: true, reasons: f.reasons }, read: false, fp, taintChecked: true };
    if (clean.has(fp) || into.has(fp)) {
      // Asked about between two censuses: checked against the values gained since the last one.
      if (onDemand && pending?.size && checkedGen.get(fp) !== pendingGen && st.size > 0 && st.size <= maxBytes && !isDataless(st) && fileKind(abs) !== "binary") {
        opts.onTaintRead?.(abs, "recheck");
        const text = await readBounded(abs, maxBytes).catch(() => null);
        if (text !== null && pending.textHit(text, TIER_FILE) && noteRepeats(abs, fp, text)) {
          into.delete(fp);
          clean.delete(fp);
          setFlagged(abs, fp, TAINTED);
          return { verdict: { excluded: true, reasons: TAINTED }, read: true, fp, taintChecked: true };
        }
        checkedGen.set(fp, pendingGen);
      }
      into.add(fp);
      if (f) unflag(abs);
      return { verdict: CLEAN, read: false, fp, taintChecked: true };
    }
    const { reasons, taintChecked } = await scanFile(abs, st, fp);
    if (reasons.length) {
      setFlagged(abs, fp, reasons);
      return { verdict: { excluded: true, reasons }, read: true, fp, taintChecked };
    }
    if (f) unflag(abs);
    if (taintChecked) into.add(fp); // else re-read once the taint exists
    return { verdict: CLEAN, read: true, fp, taintChecked };
  }

  async function runSweep(): Promise<CredentialScanStatus> {
    await load();
    const t0 = now();
    const roots = await opts.roots();
    // After a restart the taint is built first, from the restored closed files, so the walk can
    // check what it reads against it (and a lookup can start sooner). Under new rules or roots, a
    // provisional one from the files closed before; with no cache at all, verdicts fail closed
    // (UNVETTED) until the walk's end builds it.
    if (!taintSet && ready) await refreshTaint();
    else if (!taintSet && staleSources.length) await provisionalTaint();
    let lastYield = Date.now();
    const nextClean = new Set<number>();
    sideClean = new Set<number>();
    const seenFlagged = new Set<string>();
    /** Every clean file of this walk (for a full re-check), and those read without a taint. */
    const cleanFiles: Array<[string, number]> = [];
    const unchecked: Array<[string, number]> = [];
    /** Open files this walk read (new or changed): checked against the taint as it was before. */
    const readNow: Array<[string, number]> = [];
    let files = 0;
    let read = 0;
    const work = pool(concurrency);
    const visitFile = async (abs: string, linked: boolean): Promise<void> => {
      try {
        let st = await lstat(abs);
        if (linked) st = await stat(abs); // a symlink to a file: vetted as the file it reads
        if (!st.isFile()) return;
        files++;
        const r = await judge(abs, st, nextClean);
        if (r.read) read++;
        if (r.verdict.excluded) seenFlagged.add(abs);
        else if (r.taintChecked) {
          cleanFiles.push([abs, r.fp]);
          if (r.read) readNow.push([abs, r.fp]);
        } else unchecked.push([abs, r.fp]);
        if (Date.now() - lastYield > 20) {
          lastYield = Date.now();
          await yieldToLoop();
        }
      } catch {
        /* raced delete, broken link: nothing to read */
      }
    };
    const stack = [...roots];
    const visitedRoots = new Set<string>();
    while (stack.length) {
      const dir = stack.pop() ?? "";
      if (visitedRoots.has(dir)) continue;
      visitedRoots.add(dir);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (isDeniedPath(abs, opts.home)) continue; // already refused by class: nothing to vet
        if (e.isDirectory()) {
          if (!isUnscannedDirName(e.name)) stack.push(abs);
        } else if ((e.isFile() || e.isSymbolicLink()) && !isUnscannedFileName(e.name)) await work.submit(() => visitFile(abs, e.isSymbolicLink()));
      }
    }
    await work.drain();
    // Forget excluded files that are gone.
    let removed = 0;
    for (const abs of [...flagged.keys()])
      if (!seenFlagged.has(abs) && roots.some((r) => abs === r || abs.startsWith(`${r}/`))) {
        unflag(abs);
        contrib.delete(abs);
        removed++;
      }
    // The taint from the closed files as they are now. A census reads every open file (and every
    // file closed only by the taint) again: on this process's first sweep (who repeats what is
    // counted in memory), then when the taint gained a value, at most every `censusEvery`.
    // Otherwise only what this walk read, when the taint changed under it.
    await refreshTaint();
    const keys = fullSet?.keysOf(TIER_SPOKEN) ?? new Set<number>();
    const gained = censusKeys === null || [...keys].some((k) => !censusKeys?.has(k));
    const census = censusKeys === null || (gained && now() - censusAt >= censusEvery);
    const r0 = now();
    const onlyTainted = [...flagged.entries()].filter(([, f]) => !isSource(f.reasons)).map(([p, f]): [string, number] => [p, f.fp]);
    const gainedNow = [...keys].some((k) => !sweptKeys.has(k));
    const targets = census ? [...cleanFiles, ...unchecked, ...onlyTainted] : gainedNow ? [...unchecked, ...readNow] : unchecked;
    if (census) sticky = new Set(); // counted again from every file
    const rechecked = targets.length ? await recheck(targets, nextClean) : 0;
    // Swap in the new clean set (plus what on-demand verdicts learnt meanwhile), then close or
    // reopen each file that repeats a value by the new counts (a lost value reopens its copies).
    for (const fp of sideClean) nextClean.add(fp);
    const before = flagged.size;
    applyRepeats((abs, fp) => seenFlagged.has(abs) || flagged.get(abs)?.fp === fp || nextClean.has(fp), nextClean);
    if (census) {
      censusKeys = keys;
      censusAt = now();
      checkedGen.clear();
      // What the census found common stays common until the next one, so the files that repeat
      // only common values need not be kept (most of the ~260,000 that repeat anything).
      sticky = new Set(common);
      for (const [abs, r] of [...repeats]) if (r.keys.every((k) => sticky.has(k))) repeats.delete(abs);
    }
    // Values gained since the census: what a verdict checks a cached open file against.
    const fresh = [...keys].filter((k) => !censusKeys?.has(k) && ((fullSet?.tiersOf(k) ?? 0) & TIER_FILE) !== 0 && !common.has(k));
    const freshSet = new Set(fresh);
    if (fresh.length !== (pending?.size ?? 0) || fresh.some((k) => !pending?.tiersOf(k))) {
      pending = fresh.length && fullSet ? fullSet.filter((k) => freshSet.has(k)) : null;
      pendingGen++;
    }
    if (targets.length) lastRecheck = { files: rechecked, ms: now() - r0, full: census };
    sweptKeys = keys;
    clean = nextClean;
    sideClean = null;
    const changed = !ready || read > 0 || removed > 0 || rechecked > 0 || census || flagged.size !== before;
    ready = true;
    last = { files, lastSweepMs: now() - t0, lastSweepAt: now(), lastSweepRead: read };
    notify();
    if (changed) await save(roots).catch(() => undefined); // a failed save only costs a slower next boot
    return scanner.status();
  }

  const scanner: CredentialScanner = {
    async verdict(abs) {
      await load();
      let st: Stats;
      try {
        st = await lstat(abs);
        if (st.isSymbolicLink()) st = await stat(abs);
      } catch {
        return CLEAN; // nothing there to read
      }
      if (!st.isFile()) return CLEAN;
      const r = await judge(abs, st, sideClean ?? clean, true);
      // Fail closed: clean by the rules, but it may repeat a closed file's value and there is no
      // taint to check it against yet.
      return !r.verdict.excluded && !r.taintChecked ? UNVETTED : r.verdict;
    },

    isExcluded(abs) {
      return flaggedKeys.has(pathKey(abs));
    },

    excluded() {
      return [...flagged.entries()].map(([path, f]) => ({ path, reasons: f.reasons })).sort((a, b) => a.path.localeCompare(b.path));
    },

    sweep() {
      running ??= runSweep().finally(() => {
        running = null;
      });
      return running;
    },

    maintain(maxAgeMs) {
      if (running) return;
      if (!ready || !taintSet || last.lastSweepAt === null || now() - last.lastSweepAt >= maxAgeMs) void scanner.sweep().catch(() => undefined);
    },

    async whenReady(timeoutMs) {
      await load();
      if (ready && taintSet) {
        scanner.maintain(5 * 60_000); // a restored scan is refreshed in the background
        return true;
      }
      const failed = scanner.sweep().then(
        () => false,
        () => true,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiter: (() => void) | undefined;
      const outcome = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        waiter = () => {
          if (ready && taintSet) resolve(true);
        };
        waiters.add(waiter);
        void failed.then((f) => {
          if (f) resolve(false);
        });
      });
      try {
        return await outcome;
      } finally {
        clearTimeout(timer);
        if (waiter) waiters.delete(waiter);
      }
    },

    async valuesOf(abs) {
      try {
        const st = await stat(abs);
        if (!st.isFile() || isDataless(st) || st.size > maxBytes || fileKind(abs) === "binary") return [];
        const text = await readBounded(abs, maxBytes);
        return text === null ? [] : scanText(text, abs, { collectValues: true }).values;
      } catch {
        return [];
      }
    },

    taint() {
      return taintSet;
    },

    vetted() {
      return taintSet !== null && !provisional;
    },

    persistTo(file) {
      if (cacheFile === file) return;
      cacheFile = file;
      if (!ready) loading = null; // nothing swept yet: restore from it first
    },

    status() {
      const byReason: Partial<Record<CredentialReason, number>> = {};
      for (const f of flagged.values()) for (const r of f.reasons) byReason[r] = (byReason[r] ?? 0) + 1;
      let values = 0;
      for (const c of contrib.values()) values += c.values;
      const taint: TaintStatus = { ready: taintSet !== null, sources: contrib.size, values, entries: fullSet?.size ?? 0, common: common.size, repeating: repeats.size, pending: pending?.size ?? 0, lastCensusAt: censusKeys ? censusAt : null, lastRecheck };
      return { ready, sweeping: running !== null, excluded: flagged.size, byReason, ...last, taint };
    },
  };
  return scanner;
}
