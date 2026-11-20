// Value taint: the values the credential rules find in a CLOSED file close every other file that
// repeats one, and a reply never says one, whatever words stand around it. Phrasing rules can never
// close a note that holds nothing but a bare copy of a master code; its VALUE can.
//
// Only keyed hashes and lengths are kept. A value is normalised (other scripts' digits and
// fullwidth forms folded, accents, case and every separator dropped: "Qx7m-B2pz" → "qx7mb2pz"),
// hashed with a random per-process key, and its plaintext is dropped. Text is matched by hashing
// windows of consecutive letter-or-digit runs, so "36 24 12", "36-24-12" and "362412" are the same
// value, without building a string per run (a sweep reads gigabytes).

import { randomBytes } from "node:crypto";
import { foldText } from "./credential-scan-lib.js";

/** Always withheld from a spoken reply. */
export const TIER_SPOKEN = 1;
/** Also closes every file that repeats it (stricter: a common short value would close thousands). */
export const TIER_FILE = 2;
/** The longest window compared (a longer value is matched by its prefixes and suffixes). */
export const TAINT_MAX_LEN = 64;
/** A value this long or longer also taints its prefixes and suffixes of MIN_AFFIX characters or more. */
const AFFIX_FROM = 10;
const MIN_AFFIX = 8;
/** At most this many runs in one window ("12 08 33" is 3; a seed phrase's words are matched 4 at a time). */
const MAX_PARTS = 12;
/** Words of a phrase value hashed together (a seed phrase taints every 4 consecutive words). */
const PHRASE_WINDOW = 4;

export interface TaintKey {
  b1: number;
  b2: number;
  k1: number;
  k2: number;
}

/** A fresh random key (odd bases for the two polynomial lanes, and a final mask for each). */
export function randomTaintKey(): TaintKey {
  const r = randomBytes(16);
  return { b1: r.readUInt32LE(0) | 1, b2: r.readUInt32LE(4) | 1, k1: r.readUInt32LE(8), k2: r.readUInt32LE(12) };
}

// ── what counts as a letter or digit ──────────────────────────────────────

/** Non-ASCII code units: 0 unknown yet, 1 letter or digit, 2 not. */
const NON_ASCII = new Uint8Array(65536);
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
function nonAsciiAlnum(c: number): boolean {
  let v = NON_ASCII[c] ?? 2;
  if (v === 0) {
    v = c >= 0xd800 && c <= 0xdfff ? 2 : LETTER_OR_DIGIT.test(String.fromCharCode(c)) ? 1 : 2;
    NON_ASCII[c] = v;
  }
  return v === 1;
}

/** True for a code unit of a letter-or-digit run in prepared (lowercased) text. */
export function isRunChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 128 && nonAsciiAlnum(c));
}

const NON_ASCII_RE = /[^\x00-\x7f]/;
const MARKS = /\p{M}+/gu;

/** Text as the taint reads it: folded like the credential rules read it (other scripts' digits,
 *  fullwidth forms, invisible characters), accents dropped, lowercased. ASCII text is only lowercased. */
export function prepareText(text: string): string {
  if (!NON_ASCII_RE.test(text)) return text.toLowerCase();
  return foldText(text).normalize("NFKD").replace(MARKS, "").toLowerCase();
}

/** A value as the taint compares it: prepared, then letters and digits only. */
export function normalizeValue(raw: string): string {
  const t = prepareText(raw);
  let out = "";
  for (let i = 0; i < t.length; i++) if (isRunChar(t.charCodeAt(i))) out += t.charAt(i);
  return out;
}

// ── which values taint ─────────────────────────────────────────────────────

/** "1234", "abcd", "9876": a run that counts up or down by one. */
function isSequence(n: string): boolean {
  if (n.length < 3) return false;
  const d = n.charCodeAt(1) - n.charCodeAt(0);
  if (d !== 1 && d !== -1) return false;
  for (let i = 2; i < n.length; i++) if (n.charCodeAt(i) - n.charCodeAt(i - 1) !== d) return false;
  return true;
}

/** An 8-digit date (20260928, 28092026) or a Unix timestamp in seconds or milliseconds. */
function isDateLike(n: string): boolean {
  if (/^(?:19|20)\d\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:\d{4}(?:\d\d)?)?$/.test(n)) return true;
  if (/^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d\d$/.test(n)) return true;
  return /^1[5-9]\d{8}(?:\d{3})?$/.test(n);
}

/** True when the digits pass the Luhn check (a card number). */
function luhn(n: string): boolean {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = n.charCodeAt(n.length - 1 - i) - 48;
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Which tiers a normalised value belongs to (0: it taints nothing). Spoken: 4 characters or more,
 *  not a year, not "1234" or "aaaa". File (the value closes other files that repeat it): 8 or more
 *  characters with at least 5 distinct ones, and letters mixed with digits ("swordfish9"), a card
 *  number (Luhn) or 14+ digits that are not a date or timestamp, or 12+ letters that are not a
 *  dictionary word ("purplewalrus", not "subscription"). Measured on the real corpus, words and
 *  8-12 digit numbers (phone numbers, ids) the rules took for values closed unrelated notes. */
export function taintTiers(n: string, isWord?: (w: string) => boolean): number {
  const len = n.length;
  if (len < 4) return 0;
  let digits = 0;
  for (let i = 0; i < len; i++) {
    const c = n.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
  }
  const distinct = new Set(n).size;
  if (distinct < 2 || isSequence(n)) return 0;
  if (digits === len && len === 4 && /^(?:19|20)\d\d$/.test(n)) return 0;
  let tiers = TIER_SPOKEN;
  const letters = len - digits;
  const fileShape =
    (digits > 0 && letters > 0) ||
    (digits === len && !isDateLike(n) && (len >= 14 || (len >= 13 && luhn(n)))) ||
    (letters === len && len >= 12 && !(isWord?.(n) ?? false));
  if (len >= 8 && distinct >= 5 && fileShape) tiers |= TIER_FILE;
  return tiers;
}

// ── keyed hashing ─────────────────────────────────────────────────────────

/** One hashed string: its key (53 bits), its length and its tiers. */
export interface TaintEntry {
  k: number;
  len: number;
  tiers: number;
}

/** The low 21 bits of a window's key (a cheap first test before the whole key). */
function lowBits(key: TaintKey, h2: number, len: number): number {
  return ((h2 ^ key.k2) ^ Math.imul(len, 0x9e3779b1)) & 0x1fffff;
}

/** The 53-bit key of a window from its two lane hashes and length. */
function finish(key: TaintKey, h1: number, h2: number, len: number): number {
  return ((h1 ^ key.k1) >>> 0) * 0x200000 + lowBits(key, h2, len);
}

/** The key of a normalised string. */
export function keyOf(key: TaintKey, s: string): number {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (Math.imul(h1, key.b1) + c) | 0;
    h2 = (Math.imul(h2, key.b2) + c) | 0;
  }
  return finish(key, h1, h2, s.length);
}

/** A piece of a value that could be a secret's on its own: letters AND digits. A letters-only
 *  prefix or suffix is too often a word, a URL or a code identifier ("httpswwwncbi", "ationmanager":
 *  measured, on the real corpus they closed tens of thousands of files). */
const MIXED = /^(?=.*\d)(?=.*\p{L})/u;

/** The hashed entries one raw value contributes (none when it is too plain to taint): the whole
 *  value, its prefixes and suffixes of 8+ characters that mix letters and digits when it has 10+,
 *  and every 4 consecutive words of a phrase (a seed phrase copied in part). Each piece must itself
 *  be eligible. */
export function taintEntries(key: TaintKey, raw: string, isWord?: (w: string) => boolean): TaintEntry[] {
  const n = normalizeValue(raw);
  const tiers = taintTiers(n, isWord);
  if (!tiers) return [];
  const out = new Map<number, TaintEntry>();
  const add = (s: string, max: number): void => {
    const t = taintTiers(s) & max;
    if (!t || s.length > TAINT_MAX_LEN) return;
    const k = keyOf(key, s);
    const e = out.get(k);
    if (e) e.tiers |= t;
    else out.set(k, { k, len: s.length, tiers: t });
  };
  add(n, tiers);
  if (n.length >= AFFIX_FROM)
    for (let m = MIN_AFFIX; m < n.length && m <= TAINT_MAX_LEN; m++)
      for (const piece of [n.slice(0, m), n.slice(n.length - m)]) if (MIXED.test(piece)) add(piece, tiers);
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length > PHRASE_WINDOW && words.every((w) => /^\p{L}+$/u.test(w)))
    for (let i = 0; i + PHRASE_WINDOW <= words.length; i++) add(normalizeValue(words.slice(i, i + PHRASE_WINDOW).join(" ")), tiers);
  return [...out.values()];
}

// ── the set and its matchers ──────────────────────────────────────────────

/** A run of letters and digits as the spoken matcher sees it: its normalised text and its span in
 *  the original sentence. */
export interface TaintPart {
  norm: string;
  start: number;
  end: number;
}

export class TaintSet {
  private readonly keys = new Map<number, number>();
  private readonly lenOf = new Map<number, number>();
  /** Tiers present per window length, and a bit per low 21 bits of every key: cheap first tests
   *  before a key lookup (most windows of a text fail one). */
  private readonly lens = new Uint8Array(TAINT_MAX_LEN + 1);
  private readonly low = new Uint32Array(0x200000 >>> 5);
  private maxLen = [0, 0, 0, 0];

  constructor(
    readonly key: TaintKey,
    entries: Iterable<TaintEntry> = [],
  ) {
    for (const e of entries) this.add(e);
  }

  add(e: TaintEntry): void {
    this.keys.set(e.k, (this.keys.get(e.k) ?? 0) | e.tiers);
    this.lenOf.set(e.k, e.len);
    const lo = e.k % 0x200000;
    this.low[lo >>> 5] = (this.low[lo >>> 5] ?? 0) | (1 << (lo & 31));
    this.lens[e.len] = (this.lens[e.len] ?? 0) | e.tiers;
    for (const t of [TIER_SPOKEN, TIER_FILE]) if (e.tiers & t && e.len > (this.maxLen[t] ?? 0)) this.maxLen[t] = e.len;
  }

  get size(): number {
    return this.keys.size;
  }

  /** The keys of one tier (to tell whether a newer set gained any). */
  keysOf(tier: number): Set<number> {
    const out = new Set<number>();
    for (const [k, t] of this.keys) if (t & tier) out.add(k);
    return out;
  }

  /** The tiers of one key (0: not in the set). */
  tiersOf(k: number): number {
    return this.keys.get(k) ?? 0;
  }

  /** A copy with only the keys `keep` accepts. */
  filter(keep: (k: number) => boolean): TaintSet {
    const out = new TaintSet(this.key);
    for (const [k, tiers] of this.keys) if (keep(k)) out.add({ k, len: this.lenOf.get(k) ?? 0, tiers });
    return out;
  }

  /** A copy without some keys (the values too common to be anyone's secret). */
  without(drop: ReadonlySet<number>): TaintSet {
    return this.filter((k) => !drop.has(k));
  }

  /** The key of a window when it is a value of `tier`, else -1. */
  private hit(h1: number, h2: number, len: number, tier: number): number {
    if (!((this.lens[len] ?? 0) & tier)) return -1;
    const lo = lowBits(this.key, h2, len);
    if (!((this.low[lo >>> 5] ?? 0) & (1 << (lo & 31)))) return -1;
    const k = finish(this.key, h1, h2, len);
    return ((this.keys.get(k) ?? 0) & tier) !== 0 ? k : -1;
  }

  /** True when `text` repeats a value of `tier`: any window of consecutive letter-or-digit runs
   *  that equals one. */
  textHit(text: string, tier = TIER_FILE): boolean {
    return this.scan(text, tier, () => true);
  }

  /** Every value of `tier` that `text` repeats, as keys (each once). */
  textKeys(text: string, tier = TIER_FILE): number[] {
    const out = new Set<number>();
    this.scan(text, tier, (k) => {
      out.add(k);
      return false;
    });
    return [...out];
  }

  /** Calls `on` with the key of every window of `text` that equals a value of `tier`, until it
   *  returns true. One pass, no string per run; a run longer than TAINT_MAX_LEN is compared by its
   *  first TAINT_MAX_LEN characters. */
  private scan(text: string, tier: number, on: (k: number) => boolean): boolean {
    const maxLen = this.maxLen[tier] ?? 0;
    if (!maxLen) return false;
    const t = prepareText(text);
    const { b1, b2 } = this.key;
    // The last MAX_PARTS runs: their lane hashes, lane powers (base^length) and lengths.
    const rh1 = new Int32Array(MAX_PARTS);
    const rh2 = new Int32Array(MAX_PARTS);
    const rp1 = new Int32Array(MAX_PARTS);
    const rp2 = new Int32Array(MAX_PARTS);
    const rl = new Int32Array(MAX_PARTS);
    let runs = 0;
    let h1 = 0;
    let h2 = 0;
    let p1 = 1;
    let p2 = 1;
    let len = 0;
    const end = (): boolean => {
      if (len > maxLen) {
        len = 0;
        runs = 0; // a window never spans a run longer than any value
        return false;
      }
      const at = runs % MAX_PARTS;
      rh1[at] = h1;
      rh2[at] = h2;
      rp1[at] = p1;
      rp2[at] = p2;
      rl[at] = len;
      runs++;
      // Every window that ends with this run, growing leftwards.
      let s1 = h1;
      let s2 = h2;
      let w1 = p1;
      let w2 = p2;
      let l = len;
      let k = this.hit(s1, s2, l, tier);
      if (k >= 0 && on(k)) return true;
      for (let back = 1; back < MAX_PARTS && back < runs; back++) {
        const i = (runs - 1 - back) % MAX_PARTS;
        l += rl[i] ?? 0;
        if (l > maxLen) break;
        s1 = (Math.imul(rh1[i] ?? 0, w1) + s1) | 0;
        s2 = (Math.imul(rh2[i] ?? 0, w2) + s2) | 0;
        w1 = Math.imul(rp1[i] ?? 1, w1);
        w2 = Math.imul(rp2[i] ?? 1, w2);
        k = this.hit(s1, s2, l, tier);
        if (k >= 0 && on(k)) return true;
      }
      len = 0;
      return false;
    };
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 128 && nonAsciiAlnum(c))) {
        if (len === 0) {
          h1 = 0;
          h2 = 0;
          p1 = 1;
          p2 = 1;
        }
        len++;
        if (len <= TAINT_MAX_LEN) {
          h1 = (Math.imul(h1, b1) + c) | 0;
          h2 = (Math.imul(h2, b2) + c) | 0;
          p1 = Math.imul(p1, b1);
          p2 = Math.imul(p2, b2);
          if (len === TAINT_MAX_LEN && len === maxLen) {
            const k = this.hit(h1, h2, len, tier); // a long run's head
            if (k >= 0 && on(k)) return true;
          }
        }
      } else if (len > 0 && end()) return true;
    }
    return len > 0 && end();
  }

  /** The windows of `parts` (consecutive, in order) that equal a value of `tier`, as [first, last]
   *  part indexes. For a spoken sentence: its runs, with numbers said in words already digits. */
  partHits(parts: readonly TaintPart[], tier = TIER_SPOKEN): Array<[number, number]> {
    const maxLen = this.maxLen[tier] ?? 0;
    const out: Array<[number, number]> = [];
    if (!maxLen) return out;
    const { b1, b2 } = this.key;
    const hashed = parts.map((p) => {
      let a = 0;
      let b = 0;
      let x = 1;
      let y = 1;
      for (let i = 0; i < p.norm.length && i < TAINT_MAX_LEN; i++) {
        const c = p.norm.charCodeAt(i);
        a = (Math.imul(a, b1) + c) | 0;
        b = (Math.imul(b, b2) + c) | 0;
        x = Math.imul(x, b1);
        y = Math.imul(y, b2);
      }
      return { a, b, x, y, len: p.norm.length };
    });
    for (let j = 0; j < hashed.length; j++) {
      const last = hashed[j];
      if (!last || last.len > maxLen) continue;
      let s1 = last.a;
      let s2 = last.b;
      let w1 = last.x;
      let w2 = last.y;
      let l = last.len;
      if (this.hit(s1, s2, l, tier) >= 0) out.push([j, j]);
      for (let i = j - 1; i >= 0 && j - i < MAX_PARTS; i--) {
        const p = hashed[i];
        if (!p) break;
        l += p.len;
        if (l > maxLen) break;
        s1 = (Math.imul(p.a, w1) + s1) | 0;
        s2 = (Math.imul(p.b, w2) + s2) | 0;
        w1 = Math.imul(p.x, w1);
        w2 = Math.imul(p.y, w2);
        if (this.hit(s1, s2, l, tier) >= 0) out.push([i, j]);
      }
    }
    return out;
  }
}
