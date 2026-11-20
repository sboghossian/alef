// The number blackout: Alef never says aloud a number of 4 or more digits, or a code-like token,
// that he COPIED from what this turn read (the retrieved notes, a deep lookup's tool results) or
// that a closed file holds (the value taint). It does not ask what the question is about: it runs
// on every spoken reply, fast and deep, next to the copy guard (voice-brain-guard-lib.ts).
//
//   Numbers. Both sides are read the same way: digits in any script, spaced, dashed, dotted or
//   comma-separated ("0 9 3 6", "7-7-3-1"), or said in words in English, French, Spanish, Dutch,
//   German, Italian, Arabic or Arabizi, "o"/"oh" for zero, digit by digit or in pairs. A note's
//   number is withheld when its digits appear ANYWHERE in the digits the turn says, in order, words
//   between them ignored: "8830 and 21", "eight thousand eight hundred and thirty", "Six. Oh.
//   Nine. Three." and "- 60\n- 93" all say 8830 or 6093. A closed file's value (the taint keeps
//   keyed hashes only) is matched against every run of consecutive numbers the turn says, across
//   sentences.
//   Codes. A token of 5+ letters and digits mixed ("Qx7mB2pz", "Castor-Lune-58") copied from the
//   notes is withheld however it is re-spaced, reversed, or spelled out letter by letter, NATO
//   words included ("Queen, x-ray, seven, mike, …").
//   Exceptions, decided by how the NOTE wrote the number: a year inside a date (2026-11-03,
//   "3 November 2026", "March 2025") and an amount or measure written with its currency or unit
//   ("850 USD", "$14.99", "94 Mbps", "42.2 km", "83%"). Everything else, order and room numbers
//   included, is withheld. His own numbers (said in this question) stay.
//   What is said instead: a pointer to where it is ("that number is in your note 'Garage'; I don't
//   read codes aloud").
// Everything here is pure; voice-brain.ts feeds it the block, the tool results and the taint.

import { normalizeValue, prepareText, TIER_SPOKEN, type TaintPart, type TaintSet } from "./credential-taint-lib.js";
import { digitWord, isConnector, isNumberWord, looseDigit, numberRuns, type NumberRun } from "./voice-brain-guard-lib.js";

/** The shortest number the blackout withholds, and the shortest code. */
export const BLACKOUT_MIN_DIGITS = 4;
export const BLACKOUT_MIN_CODE = 5;
/** The longest number or code it records whole (a longer run of numbers, like a lookup reading a
 *  column of figures, is recorded as its numbers; a longer single number in 64-digit pieces). */
export const BLACKOUT_MAX = 64;

/** What Alef says in place of a withheld number or code. */
export function blackoutNotice(kind: "number" | "code", where: string | null): string {
  return `That ${kind} is in ${where ?? "your notes"}; I don't read codes aloud.`;
}

/** "your note 'Garage'" for a note named Garage.md or user_garage.md; "your notes" when the name
 *  is missing, long, quoted, or holds a digit (a title never says a number in the notice's place). */
export function whereOf(kind: "note" | "file", name: string | null | undefined): string {
  const t = (name ?? "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/^(?:user|project|feedback|reference)_/, "")
    .replace(/_+/g, " ")
    .trim();
  if (!t || /\d/.test(t) || t.length > 48 || /['"‘’“”`]/.test(t)) return kind === "note" ? "your notes" : "your files";
  return `your ${kind} '${t}'`;
}

// ── tokens ────────────────────────────────────────────────────────────────

interface Tok {
  t: string;
  start: number;
  end: number;
}

function toks(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) out.push({ t: prepareText(m[0]), start: m.index, end: m.index + m[0].length });
  return out;
}

/** `text` lowercased with accents dropped, one code unit per code unit (offsets stay valid). */
function foldSameLength(text: string): string {
  let out = "";
  for (const c of text) {
    const f = c.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
    out += f.length === c.length ? f : c;
  }
  return out;
}

// ── what the notes wrote: numbers, codes, and their exceptions ────────────

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|" +
  "janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|" +
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|" +
  "januari|februari|maart|mei|juni|juli|augustus|oktober|" +
  "januar|janner|februar|marz|dezember|" +
  "gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre";
const YEAR4 = "(?:19|20)\\d\\d";
const YEAR = `${YEAR4}(?!\\d)`;
const DAY = "(?:0?[1-9]|[12]\\d|3[01])";
const MONTH_NUM = "(?:0?[1-9]|1[0-2])";
/** A date that holds a 4-digit year: its year is a date's, not a code. */
const DATES: readonly RegExp[] = [
  new RegExp(`(?<![\\d.])${YEAR4}([-/.])${MONTH_NUM}\\1${DAY}(?![\\d])`, "g"), // 2026-11-03
  new RegExp(`(?<![\\d.])${DAY}([-/.])${MONTH_NUM}\\1${YEAR}`, "g"), // 03/11/2026, 03.11.2026
  new RegExp(`(?<![\\d.])${MONTH_NUM}([-/.])${DAY}\\1${YEAR}`, "g"), // 11/03/2026
  new RegExp(`(?<![\\d.])${DAY}(?:st|nd|rd|th|er|e|º)?\\.?\\s+(?:of\\s+|de\\s+)?(?:${MONTHS})\\.?,?\\s+(?:de\\s+|del\\s+)?${YEAR}`, "g"), // 3 November 2026
  new RegExp(`(?<![\\p{L}])(?:${MONTHS})\\.?\\s+${DAY}(?:st|nd|rd|th)?,?\\s+${YEAR}`, "gu"), // November 3, 2026
  new RegExp(`(?<![\\p{L}])(?:${MONTHS})\\.?,?\\s+(?:of\\s+|de\\s+)?${YEAR}`, "gu"), // March 2025
];
/** Currencies and units written as a word after a number (a space allowed: "850 USD", "94 Mbps"). */
const UNITS =
  "usd|eur|gbp|chf|lbp|aed|sar|cad|aud|jpy|dollars?|euros?|pounds?|francs?|lira|liras|livres?|cents?|%|percent|per cent|pct|pourcent|prozent|procent|" +
  "km|kms|cm|mm|mi|miles?|ft|feet|inch(?:es)?|kg|kgs|mg|lbs?|tonnes?|tons?|ml|cl|gal|" +
  "kb|mb|gb|tb|pb|kib|mib|gib|tib|kbps|mbps|gbps|hz|khz|mhz|ghz|kw|mw|kwh|wh|mah|" +
  "ms|sec|secs|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|yrs?|years?|" +
  "°c|°f|m²|m2|sqm|sq ?m|sq ?ft|square (?:metres|meters|feet)|px|pt|dpi|fps|rpm|psi|kcal|cal|calories|mn|bn|millions?|billions?";
/** One-letter units only glued to the number ("5m", "12h", "100w"): a lone "w" after a number is
 *  Arabizi for "and" ("2258 w ba3den"), not watts. */
const UNITS_GLUED = "m|g|t|l|w|v|s|h|k|°";
const NUM = "(?:\\d{1,3}(?:[,.\\u00a0\\u202f ]\\d{3})+|\\d+)(?:[.,]\\d+)?";
/** An amount or a measure: a number written with its currency or unit. */
const AMOUNTS: readonly RegExp[] = [
  new RegExp(`(?:[$€£¥₹]|(?<![\\p{L}])(?:usd|eur|gbp|chf|lbp|aed|sar|cad|aud|us\\$)\\s?)(?<![\\d.,])${NUM}`, "gu"),
  new RegExp(`(?<![\\d.,])${NUM}(?:\\s?(?:[$€£¥₹]|(?:${UNITS})(?![\\p{L}\\p{N}]))|(?:${UNITS_GLUED})(?![\\p{L}\\p{N}]))`, "gu"),
];
/** A number glued to its unit or an ordinal: one word, not a code ("128GB", "1080p", "21st"). */
const UNIT_WORD = new RegExp(`^[$€£]?\\d+(?:[.,]\\d+)?(?:${UNITS}|${UNITS_GLUED}|p|x)$`, "iu");
const ORDINAL = /^\d+(?:st|nd|rd|th|er|e|eme|ème|de|ste|º|ª)$/iu;

/** Arabizi: Lebanese written in Latin letters, digits for the sounds Latin lacks ("ra2em", "ba3den",
 *  "3ashra"). Each digit (2 3 5 6 7 8 9) stands alone next to a vowel, and not only at the end. */
function arabizi(n: string): boolean {
  const digits = [...n.matchAll(/\d/g)];
  if (!digits.length || digits.length > 2 || /\d\d/.test(n) || !/^[a-z0-9]+$/.test(n)) return false;
  let inside = false;
  for (const d of digits) {
    const i = d.index;
    if (!/[2356789]/.test(d[0])) return false;
    if (!/[aeiouy]/.test(`${n[i - 1] ?? ""}${n[i + 1] ?? ""}`)) return false;
    if (i < n.length - 1) inside = true;
  }
  return inside;
}

/** A token that reads like a code: 5+ letters and digits mixed, not a measure, an ordinal, an
 *  Arabizi word or a number word. */
export function isCodeToken(raw: string, n = normalizeValue(raw)): boolean {
  if (n.length < BLACKOUT_MIN_CODE || n.length > 64 || !/\d/.test(n) || !/\p{L}/u.test(n)) return false;
  const bare = raw.replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%]+$/gu, "");
  return !UNIT_WORD.test(bare) && !ORDINAL.test(bare) && !arabizi(n) && !isNumberWord(n);
}

/** `text` with its dates-with-a-year and its amounts and measures blanked ("_", same length), so
 *  they neither count nor join the numbers around them. */
export function maskExceptions(text: string): string {
  const f = foldSameLength(text);
  const blank = new Array<boolean>(text.length).fill(false);
  for (const re of [...DATES, ...AMOUNTS])
    for (const m of f.matchAll(re)) for (let i = m.index; i < m.index + m[0].length; i++) blank[i] = true;
  if (!blank.includes(true)) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) out += blank[i] ? "_" : text.charAt(i);
  return out;
}

/** The numbers (4+ digits) and codes a note or a tool result wrote, as the blackout compares them. */
export function noteNumbersAndCodes(text: string): { numbers: string[]; codes: string[] } {
  const masked = maskExceptions(text);
  const numbers = new Set<string>();
  const put = (d: string): void => {
    if (d.length < BLACKOUT_MIN_DIGITS) return;
    if (d.length <= BLACKOUT_MAX) numbers.add(d);
    else for (let i = 0; i + BLACKOUT_MIN_DIGITS <= d.length; i += BLACKOUT_MAX) numbers.add(d.slice(i, i + BLACKOUT_MAX));
  };
  for (const r of numberRuns(masked)) {
    if (r.digits.length <= BLACKOUT_MAX) put(r.digits);
    for (const g of r.groups) put(g);
  }
  const codes = new Set<string>();
  for (const w of masked.matchAll(/\S+/g)) {
    const n = normalizeValue(w[0]);
    if (isCodeToken(w[0], n)) codes.add(n);
  }
  for (const t of masked.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const n = normalizeValue(t[0]);
    if (isCodeToken(t[0], n)) codes.add(n);
  }
  return { numbers: [...numbers], codes: [...codes] };
}

/** The recall block's line shape: "[memory] memory/user_garage.md: …". */
const BLOCK_LINE = /^\[([a-z]+)\][^\S\n]+(.*?):[^\S\n](.*)$/;

/** What this turn read, as the blackout compares a reply with it: the notes' numbers and codes,
 *  each with where it came from. */
/** A 53-bit key for each prefix of `s` (two multiplicative lanes, like the taint's keys): the
 *  blackout remembers the starts of the notes' numbers as keys, not as strings. */
function prefixKeys(s: string): number[] {
  const out: number[] = [];
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    out.push((a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff));
  }
  return out;
}

export class BlackoutSources {
  readonly numbers = new Map<string, string>();
  readonly codes = new Map<string, string>();
  /** The proper starts of the notes' numbers, as keys: a sentence whose digits end on one waits. */
  private readonly starts = new Set<number>();
  /** Every 4 characters in a row of the notes' codes: what a piece of a code must hold. */
  private readonly grams = new Set<string>();
  private maxNumber = 0;
  private maxCode = 0;

  /** One note or tool result, and where it is ("your note 'Garage'"). It can land while the turn
   *  is already speaking: everything here is read live. */
  add(text: string, where: string): void {
    if (!text) return;
    const { numbers, codes } = noteNumbersAndCodes(text);
    for (const n of numbers)
      if (!this.numbers.has(n)) {
        this.numbers.set(n, where);
        this.maxNumber = Math.max(this.maxNumber, n.length);
        for (const k of prefixKeys(n).slice(0, -1)) this.starts.add(k);
      }
    for (const c of codes)
      if (!this.codes.has(c)) {
        this.codes.set(c, where);
        this.maxCode = Math.max(this.maxCode, c.length);
        for (let i = 0; i + 4 <= c.length; i++) this.grams.add(c.slice(i, i + 4));
      }
  }

  /** True when `digits` is the start of a note's number, or one whole. */
  continues(digits: string): boolean {
    if (!digits || digits.length > this.maxNumber) return false;
    return this.numbers.has(digits) || this.starts.has(prefixKeys(digits).at(-1) ?? -1);
  }

  /** True when `digits` is a proper start of a note's number. */
  startsNumber(digits: string): boolean {
    return digits.length > 0 && digits.length < this.maxNumber && this.starts.has(prefixKeys(digits).at(-1) ?? -1);
  }

  /** The note's code that holds `piece` (4+ characters), and where it is; null when none does. */
  codeHolding(piece: string): string | null {
    if (piece.length < 4 || piece.length > this.maxCode) return null;
    for (let i = 0; i + 4 <= piece.length; i++) if (!this.grams.has(piece.slice(i, i + 4))) return null;
    for (const [c, where] of this.codes) if (c.includes(piece)) return where;
    return null;
  }

  /** The rendered recall block (voice-brain-recall-lib.ts renderRecallBlock), line by line. */
  addBlock(block: string): void {
    for (const line of block.split("\n")) {
      const m = BLOCK_LINE.exec(line);
      if (!m) continue;
      const [, source, ref, text] = m;
      const base = (ref ?? "").split("/").at(-1) ?? "";
      const where =
        source === "memory" || source === "vault" ? whereOf("note", base) : source === "resident" ? "the resident's journal" : source === "web" ? "a page Jev found on the web" : "your notes";
      this.add(text ?? "", where);
    }
  }

  get longestNumber(): number {
    return this.maxNumber;
  }

  get longestCode(): number {
    return this.maxCode;
  }

  /** The blackout for one turn: `question` is what he said (his own numbers stay); `taint` the
   *  closed files' values, read when a sentence is judged (it can land mid-turn). */
  turn(question: string, taint: () => TaintSet | null | undefined): BlackoutTurn {
    return new BlackoutTurn(this, question, taint);
  }
}

// ── what the turn says ────────────────────────────────────────────────────

/** Words that say a letter's case when a value is spelled out ("Capital Q, lowercase x"): skipped
 *  inside a spelled run, never an item and never its end. */
const CASE_MARKERS = new Set("capital capitals cap caps uppercase lowercase upper lower case small big majuscule minuscule mayuscula minuscula maiuscola minuscola".split(" "));

/** NATO and the common radio alphabets' words, by letter. */
const SPELL_WORDS: Record<string, string> = {};
for (const w of "alpha alfa bravo charlie delta echo foxtrot golf hotel india juliet juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey whisky xray yankee zulu".split(" ")) SPELL_WORDS[w] = w.charAt(0);

interface Spelled {
  /** The characters, one per item. */
  chars: string;
  /** Each character's span in the unit. */
  spans: Array<[number, number]>;
  /** The run reaches the end of the unit (only punctuation after it). */
  atEnd: boolean;
}

/** A value spelled out one character at a time: single letters or digits, NATO words, digit words
 *  ("Q x 7 m", "Foxtrot Echo Romeo …", "Queen, x-ray, seven, mike, …": in a comma list of mostly
 *  such items, any other word stands for its first letter). */
function spelledRuns(text: string): Spelled[] {
  const ts = toks(text);
  // "x-ray" is one item.
  const items: Array<{ t: string; start: number; end: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const a = ts[i];
    const b = ts[i + 1];
    if (!a) continue;
    if (a.t === "x" && b?.t === "ray" && text.slice(a.end, b.start) === "-") {
      items.push({ t: "xray", start: a.start, end: b.end });
      i++;
    } else items.push(a);
  }
  const strong = (t: string): string | null => {
    if (normalizeValue(t).length === 1) return normalizeValue(t);
    return SPELL_WORDS[t] ?? digitWord(t);
  };
  const out: Spelled[] = [];
  let cur: Spelled | null = null;
  let weak = 0;
  const close = (): void => {
    if (cur && cur.chars.length >= 3 && weak * 2 <= cur.chars.length) out.push(cur);
    cur = null;
    weak = 0;
  };
  // Case markers stand between items ("Capital Q, lowercase x"): they are left out of the gap.
  const kept = items.filter((it) => !CASE_MARKERS.has(it.t));
  const gapBefore = (i: number): string => {
    const it = kept[i];
    const prev = kept[i - 1];
    if (!it || !prev) return "";
    return prepareText(text.slice(prev.end, it.start)).replace(/[\p{L}]+/gu, (w) => (CASE_MARKERS.has(w) ? "" : w));
  };
  for (let i = 0; i < kept.length; i++) {
    const it = kept[i];
    if (!it) continue;
    const gap = gapBefore(i);
    if (cur && !/^[\s,.\-–—/·;:]{1,6}$/.test(gap)) close();
    const s = strong(it.t);
    // A plain word counts only inside a comma list ("Queen, x-ray, …").
    const nextGap = kept[i + 1] ? gapBefore(i + 1) : "";
    const listed = /,/.test(gap) || /,/.test(nextGap);
    const ch = s ?? (listed && /^\p{L}+$/u.test(it.t) ? it.t.charAt(0) : null);
    if (ch === null) {
      close();
      continue;
    }
    if (!s) weak++;
    cur ??= { chars: "", spans: [], atEnd: false };
    cur.chars += ch;
    cur.spans.push([it.start, it.end]);
  }
  close();
  for (const r of out) {
    const last = r.spans.at(-1);
    r.atEnd = last !== undefined && !/[\p{L}\p{N}]/u.test(text.slice(last[1]));
  }
  return out;
}

/** The unit's letters and digits in order (numbers as their digits), each with its span. */
function alnumOf(text: string, runs: readonly NumberRun[]): { s: string; at: Array<[number, number]> } {
  let s = "";
  const at: Array<[number, number]> = [];
  let r = 0;
  for (const tk of toks(text)) {
    while (r < runs.length && (runs[r]?.end ?? 0) <= tk.start) r++;
    const run = runs[r];
    if (run && tk.start >= run.start && tk.start < run.end) {
      if (tk.start !== run.start) continue; // the run's digits went in at its first token
      for (const d of run.digits) {
        s += d;
        at.push([run.start, run.end]);
      }
      continue;
    }
    for (const c of normalizeValue(tk.t)) {
      s += c;
      at.push([tk.start, tk.end]);
    }
  }
  return { s, at };
}

const reverse = (s: string): string => [...s].reverse().join("");

/** Words that may stand around the numbers of a fragment ("It's 4821.", "And 21.", "Then oh."). */
const FILLER = new Set("it s is its and then next after that the a so sir yes ok okay c est y e und dann poi en dan w ba3den et puis luego capital uppercase lowercase small".split(" "));

/** A sentence that is only a piece of a number or of a spelled value ("Six.", "- 60", "And 21.",
 *  "Q x 7."): judged with what follows it. */
export function isFragment(s: string): boolean {
  const ts = toks(s);
  if (!ts.length || ts.length > 12) return false;
  let pieces = 0;
  for (const t of ts) {
    if (isNumberWord(t.t) || normalizeValue(t.t).length === 1 || SPELL_WORDS[t.t] !== undefined || (t.t === "x" && ts.some((u) => u.t === "ray"))) pieces++;
    else if (!FILLER.has(t.t) && !isConnector(t.t) && t.t !== "ray") return false;
  }
  return pieces > 0;
}

export interface BlackoutVerdict {
  spans: Array<[number, number]>;
  /** What to say in their place. */
  notice: string;
}

/** A number of this many digits or fewer is a piece: it joins the piece before it across words. */
const PIECE_DIGITS = 3;
/** At most this many words between two pieces of one number ("it's 88, then 30"). */
const PIECE_WORDS = 6;
/** At most this many numbers or words in one window of the taint (credential-taint-lib MAX_PARTS). */
const WINDOW = 12;

/** The numbers the turn says, in order, as one chain while they belong together: the numbers of
 *  one run always ("7394, 12 and 40"), and a piece (1-3 digits) after a piece across up to
 *  PIECE_WORDS words and across sentences ("it's 88, then 30", "Six. Oh. Nine. Three."). */
interface Chain {
  digits: string;
  /** Each digit's span in the sentence being judged (null: said in an earlier sentence). */
  at: Array<[number, number] | null>;
  /** Its numbers, each whole, with their spans. */
  groups: TaintPart[];
  /** Its last number is a piece. */
  piece: boolean;
  /** Words said since its last number. */
  words: number;
}

const EMPTY_CHAIN: Chain = { digits: "", at: [], groups: [], piece: false, words: 0 };

/** The chain as it was, for the next sentence: its spans belong to a sentence already said. */
function carried(c: Chain): Chain {
  return { digits: c.digits.slice(-128), at: c.digits.slice(-128).split("").map(() => null), groups: c.groups.slice(-WINDOW).map((g) => ({ norm: g.norm, start: -1, end: -1 })), piece: c.piece, words: c.words };
}

/** Walks `text`'s numbers onto `chain`; `on` sees the chain after each number joins it (`from`:
 *  where that number's digits start in it). With `loose`, an everyday word that is also a digit
 *  ("one", "oh", "un"), which numberRuns leaves out when it stands alone, counts as a 1-digit piece
 *  when it ends its clause ("The first digit is one.", "…and ends with one.") or when a number
 *  follows it right away. The turn keeps a chain with and one without them ("the last one is
 *  three" is not a 1). */
function walk(chain: Chain, text: string, runs: readonly NumberRun[], on?: (c: Chain, from: number) => void, loose = false, guide?: (digits: string) => boolean): Chain {
  let c = carried(chain);
  let r = 0;
  for (const tk of toks(text)) {
    while (r < runs.length && (runs[r]?.end ?? 0) <= tk.start) r++;
    const run = runs[r];
    if (!run || tk.start < run.start || tk.start >= run.end) {
      const d = loose ? looseDigit(tk.t) : null;
      const after = text.slice(tk.end);
      const endsClause = /^\s*(?:[.,;:!?…—–)"'”’]|$)/u.test(after);
      const nextIsNumber = runs.some((x) => x.start >= tk.end && /^[\s,.\-–—]*$/.test(text.slice(tk.end, x.start)));
      if (d === null || !(endsClause || nextIsNumber)) {
        c.words++;
        continue;
      }
      if (!(c.groups.length > 0 && c.piece && c.words <= PIECE_WORDS)) c = { digits: "", at: [], groups: [], piece: false, words: 0 };
      const from = c.digits.length;
      c.digits += d;
      c.at.push([tk.start, tk.end]);
      c.groups.push({ norm: d, start: tk.start, end: tk.end });
      c.piece = true;
      c.words = 0;
      on?.(c, from);
      continue;
    }
    if (tk.start !== run.start) continue; // the run went in at its first token
    run.groups.forEach((g, gi) => {
      // A number also joins when the chain's last digits and it go on to spell one of the notes'
      // numbers ("It starts with 4821. Then 5561. …" for a card number).
      let guided = false;
      if (guide && gi === 0 && c.groups.length > 0 && c.words <= PIECE_WORDS)
        for (let k = 1; k <= Math.min(c.digits.length, BLACKOUT_MAX) && !guided; k++) guided = guide(c.digits.slice(-k) + g);
      const joins = gi > 0 || guided || (c.groups.length > 0 && c.piece && g.length <= PIECE_DIGITS && c.words <= PIECE_WORDS);
      if (!joins) c = { digits: "", at: [], groups: [], piece: false, words: 0 };
      const from = c.digits.length;
      c.digits += g;
      for (let i = 0; i < g.length; i++) c.at.push([run.start, run.end]);
      c.groups.push({ norm: g, start: run.start, end: run.end });
      c.piece = g.length <= PIECE_DIGITS;
      c.words = 0;
      on?.(c, from);
    });
  }
  return c;
}

/** Words that glue the pieces of a value together when it is read out ("it starts Kx9 Plum, then
 *  44 Travel, and ends Zq81"): left out when a closed value or a note's code is looked for in what
 *  is left. */
const GLUE = new Set(
  (
    "capital capitals cap caps uppercase lowercase upper lower case small big majuscule minuscule mayuscula minuscula maiuscola minuscola " +
    "it its s is are was the a an then and after that this next followed by with plus also finally so ok okay sir " +
    "starts start starting begins begin beginning ends end ending first second third fourth last part half rest comes come " +
    "et puis ensuite und dann e poi y luego en dan w"
  ).split(" "),
);

/** The parts of `text` a value is looked for in with the glue left out: numbers (each whole) and
 *  every other word. */
function glueFree(text: string, runs: readonly NumberRun[]): TaintPart[] {
  const out: TaintPart[] = [];
  let r = 0;
  for (const tk of toks(text)) {
    while (r < runs.length && (runs[r]?.end ?? 0) <= tk.start) r++;
    const run = runs[r];
    if (run && tk.start >= run.start && tk.start < run.end) {
      if (tk.start === run.start) for (const g of run.groups) out.push({ norm: g, start: run.start, end: run.end });
      continue;
    }
    const norm = normalizeValue(tk.t);
    if (norm && !GLUE.has(norm)) out.push({ norm, start: tk.start, end: tk.end });
  }
  return out;
}

/** The blackout over one turn: what it said so far (its chain of numbers, its letters and digits,
 *  its last words without the glue, the spelled characters it ended on), and what it may not add. */
export class BlackoutTurn {
  private chain: Chain = EMPTY_CHAIN;
  /** The same chain with everyday digit words ("one", "oh") counted as digits where they may be. */
  private looseChain: Chain = EMPTY_CHAIN;
  private alnum = "";
  /** The turn's last parts with the glue left out (for a value read out in pieces). */
  private glued: TaintPart[] = [];
  /** The spelled characters the turn ended on. */
  private spelled = "";
  private readonly ownNumbers = new Set<string>();
  private readonly ownCodes = new Set<string>();
  /** The notes' numbers guide which numbers of the turn belong together. */
  private readonly guide = (d: string): boolean => this.src.continues(d);

  constructor(
    private readonly src: BlackoutSources,
    question: string,
    private readonly taint: () => TaintSet | null | undefined,
  ) {
    for (const r of numberRuns(question)) {
      this.ownNumbers.add(r.digits);
      for (const g of r.groups) this.ownNumbers.add(g);
    }
    for (const w of question.matchAll(/\S+/g)) this.ownCodes.add(normalizeValue(w[0]));
    for (const t of toks(question)) this.ownCodes.add(normalizeValue(t.t));
  }

  /** The spans of `unit` that say a note's number or code, or a closed file's value, given what the
   *  turn already said; null when there is none. */
  judge(unit: string): BlackoutVerdict | null {
    const runs = numberRuns(unit);
    const hits: Array<{ start: number; end: number; kind: "number" | "code"; where: string | null }> = [];
    const taint = this.taint();
    // 1. A note's number or a closed file's value in the chain of numbers the turn says: whole,
    //    summed never, or read out in pieces with words between them.
    const longest = this.src.longestNumber;
    const onNumber = (c: Chain, from: number): void => {
      if (this.src.numbers.size)
        for (let end = from + 1; end <= c.digits.length; end++)
          for (let len = BLACKOUT_MIN_DIGITS; len <= longest && len <= end; len++) {
            const seq = c.digits.slice(end - len, end);
            const where = this.src.numbers.get(seq);
            if (where === undefined || this.ownNumbers.has(seq)) continue;
            const first = c.at.slice(end - len, end).find((a) => a !== null);
            const last = c.at[end - 1];
            if (first && last) hits.push({ start: first[0], end: last[1], kind: "number", where });
          }
      if (taint) {
        const parts = c.groups.slice(-WINDOW);
        for (const [a, b] of taint.partHits(parts, TIER_SPOKEN)) {
          if (b !== parts.length - 1) continue; // each window once, when its last number is said
          const first = parts.slice(a, b + 1).find((p) => p.start >= 0);
          const last = parts[b];
          if (first && last) hits.push({ start: first.start, end: last.end, kind: "number", where: null });
        }
      }
    };
    walk(this.chain, unit, runs, onNumber, false, this.guide);
    walk(this.looseChain, unit, runs, onNumber, true, this.guide);
    // 2. A note's code, however it is spaced or cased, forwards or backwards.
    const { s: unitAlnum, at: alnumAt } = alnumOf(unit, runs);
    if (unitAlnum && this.src.codes.size) {
      const cand = this.alnum + unitAlnum;
      const base = this.alnum.length;
      const longestCode = this.src.longestCode;
      for (let end = base + 1; end <= cand.length; end++)
        for (let len = BLACKOUT_MIN_CODE; len <= longestCode && len <= end; len++) {
          const sub = cand.slice(end - len, end);
          const where = this.src.codes.get(sub) ?? this.src.codes.get(reverse(sub));
          if (where === undefined || this.ownCodes.has(sub)) continue;
          const first = alnumAt[Math.max(end - len, base) - base];
          const last = alnumAt[end - 1 - base];
          if (first && last) hits.push({ start: first[0], end: last[1], kind: "code", where });
        }
    }
    // 2b. Part of a note's code said as one word ("The first part is Qx7m."): 4+ letters and
    //     digits mixed that the code holds.
    if (this.src.codes.size)
      for (const w of [...unit.matchAll(/\S+/g)].map((m) => ({ t: m[0], start: m.index, end: m.index + m[0].length })).concat(toks(unit))) {
        const n = normalizeValue(w.t);
        if (n.length < 4 || !/\d/.test(n) || !/\p{L}/u.test(n) || this.ownCodes.has(n) || UNIT_WORD.test(w.t) || ORDINAL.test(w.t) || arabizi(n)) continue;
        const where = this.src.codeHolding(n) ?? this.src.codeHolding(reverse(n));
        if (where !== null) hits.push({ start: w.start, end: w.end, kind: "code", where });
      }
    // 3. A value spelled out one character at a time (NATO words too): a note's code, or 4+
    //    characters of one ("P z 8 q").
    const spelled = spelledRuns(unit);
    for (const [i, sp] of spelled.entries()) {
      const carry = i === 0 && sp.spans[0] && !/[\p{L}\p{N}]/u.test(unit.slice(0, sp.spans[0][0])) ? this.spelled : "";
      const chars = carry + sp.chars;
      const longestCode = this.src.longestCode;
      if (longestCode)
        for (let end = carry.length + 1; end <= chars.length; end++)
          for (let len = 4; len <= end && len <= longestCode; len++) {
            const sub = chars.slice(end - len, end);
            let where = len >= BLACKOUT_MIN_CODE ? (this.src.codes.get(sub) ?? this.src.codes.get(reverse(sub))) : undefined;
            if (where === undefined && /\d/.test(sub) && /\p{L}/u.test(sub)) where = this.src.codeHolding(sub) ?? undefined;
            if (where === undefined || this.ownCodes.has(sub)) continue;
            const first = sp.spans[Math.max(end - len, carry.length) - carry.length];
            const last = sp.spans[end - 1 - carry.length];
            if (first && last) hits.push({ start: first[0], end: last[1], kind: "code", where });
          }
    }
    // 4. A value read out in pieces with glue words between them ("starts Kx9 Plum, then 44 Travel,
    //    ends Zq81"): the turn's last words without the glue, across sentences, against the notes'
    //    codes and the closed files' values.
    const glued = [...this.glued.map((g) => ({ norm: g.norm, start: -1, end: -1 })), ...glueFree(unit, runs)];
    const base = this.glued.length;
    if (glued.length > base) {
      if (this.src.codes.size) {
        let joined = "";
        const at: number[] = [];
        glued.forEach((g, gi) => {
          for (let k = 0; k < g.norm.length; k++) at.push(gi);
          joined += g.norm;
        });
        const longestCode = this.src.longestCode;
        for (let end = 1; end <= joined.length; end++) {
          if ((at[end - 1] ?? 0) < base) continue; // ends in an earlier sentence: judged there
          for (let len = BLACKOUT_MIN_CODE; len <= longestCode && len <= end; len++) {
            const sub = joined.slice(end - len, end);
            const where = this.src.codes.get(sub) ?? this.src.codes.get(reverse(sub));
            if (where === undefined || this.ownCodes.has(sub)) continue;
            const first = glued.slice(at[end - len] ?? 0, (at[end - 1] ?? 0) + 1).find((p) => p.start >= 0);
            const last = glued[at[end - 1] ?? 0];
            if (first && last) hits.push({ start: first.start, end: last.end, kind: "code", where });
          }
        }
      }
      const parts = glued.slice(-(WINDOW + glued.length - base));
      if (taint)
        for (const [a, b] of taint.partHits(parts, TIER_SPOKEN)) {
          const first = parts.slice(a, b + 1).find((p) => p.start >= 0);
          const last = parts[b];
          if (first && last && last.start >= 0) hits.push({ start: first.start, end: last.end, kind: /\p{L}/u.test(parts.slice(a, b + 1).map((p) => p.norm).join("")) ? "code" : "number", where: null });
        }
    }
    // 5. A closed file's value in the sentence's own words and numbers, glue and all, or spelled.
    if (taint) {
      const parts: TaintPart[] = [];
      let r = 0;
      for (const tk of toks(unit)) {
        while (r < runs.length && (runs[r]?.end ?? 0) <= tk.start) r++;
        const run = runs[r];
        if (run && tk.start >= run.start && tk.start < run.end) {
          if (tk.start === run.start) for (const g of run.groups) parts.push({ norm: g, start: run.start, end: run.end });
          continue;
        }
        const norm = normalizeValue(tk.t);
        if (norm) parts.push({ norm, start: tk.start, end: tk.end });
      }
      for (const [a, b] of taint.partHits(parts, TIER_SPOKEN)) {
        const first = parts[a];
        const last = parts[b];
        if (first && last) hits.push({ start: first.start, end: last.end, kind: /\p{L}/u.test(parts.slice(a, b + 1).map((p) => p.norm).join("")) ? "code" : "number", where: null });
      }
      for (const sp of spelled) {
        const chars: TaintPart[] = [...sp.chars].map((c, i) => ({ norm: c, start: sp.spans[i]?.[0] ?? 0, end: sp.spans[i]?.[1] ?? 0 }));
        for (const [a, b] of taint.partHits(chars, TIER_SPOKEN)) {
          const first = chars[a];
          const last = chars[b];
          if (first && last) hits.push({ start: first.start, end: last.end, kind: "code", where: null });
        }
      }
    }
    if (!hits.length) return null;
    hits.sort((x, y) => x.start - y.start);
    const lead = hits[0];
    const where = lead?.where ?? hits.find((h) => h.where !== null)?.where ?? null;
    return { spans: hits.map((h) => [h.start, h.end]), notice: blackoutNotice(lead?.kind ?? "number", where) };
  }

  /** Records what the turn actually said (after the guard cut what it withheld). */
  commit(said: string): void {
    const runs = numberRuns(said);
    this.chain = walk(this.chain, said, runs, undefined, false, this.guide);
    this.looseChain = walk(this.looseChain, said, runs, undefined, true, this.guide);
    this.alnum += alnumOf(said, runs).s;
    if (this.alnum.length > 512) this.alnum = this.alnum.slice(-256); // a code is at most 64 characters
    this.glued = [...this.glued, ...glueFree(said, runs)].slice(-WINDOW);
    const sp = spelledRuns(said).at(-1);
    this.spelled = sp?.atEnd ? (sp.spans[0] && !/[\p{L}\p{N}]/u.test(said.slice(0, sp.spans[0][0])) ? this.spelled : "") + sp.chars : "";
    if (this.spelled.length > 64) this.spelled = this.spelled.slice(-64);
  }

  /** True when `unit` should wait for what follows: it is only a piece of a number or a spelled
   *  value (isFragment), its chain of numbers ends on the start of a note's number ("The first
   *  digit is six." when a note holds 6093), or it ends on spelled characters that could start a
   *  code. `held`: the sentences already waiting. */
  wantsHold(unit: string, held: readonly string[]): boolean {
    if (isFragment(unit)) return true;
    if (this.src.numbers.size)
      for (const loose of [false, true]) {
        let c = loose ? this.looseChain : this.chain;
        for (const h of held) c = walk(c, h, numberRuns(h), undefined, loose, this.guide);
        let said = false;
        c = walk(
          c,
          unit,
          numberRuns(unit),
          () => {
            said = true;
          },
          loose,
          this.guide,
        );
        const endsOnNumber = said && c.words === 0;
        if (said) for (let k = Math.min(c.digits.length, this.src.longestNumber - 1); k >= 1; k--) if (this.src.startsNumber(c.digits.slice(-k)) && (k >= 2 || endsOnNumber)) return true;
      }
    const sp = spelledRuns(unit).at(-1);
    return sp !== undefined && sp.atEnd && this.src.codes.size > 0;
  }

  /** True when `text` (an action's field, judged alone) says a note's number or code or a closed
   *  file's value. */
  carries(text: string): boolean {
    return this.fresh().judge(text) !== null;
  }

  private fresh(): BlackoutTurn {
    const t = new BlackoutTurn(this.src, "", this.taint);
    for (const n of this.ownNumbers) t.ownNumbers.add(n);
    for (const c of this.ownCodes) t.ownCodes.add(c);
    return t;
  }
}
