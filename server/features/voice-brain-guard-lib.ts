// The copy guard on every sentence Alef says. It does not read phrasing (the credential rules do
// that, at the source); it compares what the reply COPIES with what the turn's notes and lookups
// held, and it asks one question about intent.
//   (a) Always: any run of the reply that equals a tainted value (a value from a closed file, by
//       keyed hash: credential-taint-lib.ts) is withheld.
//   (b) When his question (or an earlier one in the conversation), or the reply so far, is about access (a short
//       list of stems: code, pass, pin, login, wifi, door, gate, garage, safe, alarm, … in English,
//       French, Spanish, Dutch and Arabic/Arabizi), every token the sentence copies from the notes
//       or the lookup's results is withheld when it is a run of 3+ digits (spaced, dashed or said
//       in words: "36 24 12", "7-7-3-1", "cinco dos nueve siete"), a token that is not a dictionary
//       word ("swordfish9", "Qx7mB2pz", "zorbavex", re-spaced or spelled out one character at a
//       time), or a dictionary word the notes wrote in a clause about access ("I set marmalade as
//       the wifi password"). Tokens and numbers he said himself stay.
// The number blackout (voice-brain-blackout-lib.ts) runs next to it on every sentence, whatever the
// turn is about; with it, a sentence that is only a piece of a number waits for what follows.
// Everything here is pure; voice-brain.ts feeds it the question, the sources and the taint.

import { foldText } from "./credential-scan-lib.js";
import { normalizeValue, prepareText, TIER_SPOKEN, type TaintPart, type TaintSet } from "./credential-taint-lib.js";
import type { BlackoutSources, BlackoutTurn } from "./voice-brain-blackout-lib.js";

/** What Alef says in place of a withheld part. */
export const WITHHELD_SPOKEN = "I've kept that part to myself: it looks like a credential.";

// ── tokens ────────────────────────────────────────────────────────────────

const TOKEN_RE = /[\p{L}\p{N}\p{M}]+/gu;

interface Token {
  /** Prepared (folded, accents dropped, lowercased). */
  t: string;
  start: number;
  end: number;
}

function tokensOf(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ t: prepareText(m[0]), start: m.index, end: m.index + m[0].length });
  return out;
}

// ── intent ────────────────────────────────────────────────────────────────

/** Stems matched at the start of a word. */
const STEMS = [
  "code", "cod", "pass", "pwd", "pin", "login", "admin", "unlock", "wifi", "psk", "ssid", "seed", "key", "combin", "combo", "garage", "gate", "door",
  "porte", "puerta", "deur", "safe", "coffre", "alarm", "2fa", "otp", "backup", "recovery", "entry", "entr", "open", "secret", "token", "credential",
  "account", "compte", "contrase", "clave", "wachtw", "sleutel", "kluis", "poort", "digicode", "mdp", "buzz", "intercom", "lock", "padlock", "cadenas",
  "portail", "ouvr", "garaj", "dial", "kelmet", "kelmit", "fta7", "bfta7", "byefta7", "yefta7",
];
/** Whole words only (a prefix would catch "baby", "clean" or "abril"). */
const EXACT = new Set(["bab", "cle", "clef", "creds", "pw", "sudo", "abre", "abro", "abrir", "abren", "abra"]);
/** A label's separator right after a word: "pass: …", "key = …", "admin — …", "\"pass\": …". */
const LABEL_AFTER = /^["'\s]*(?:[:=/→\-–—]|phrase|word|code)/i;
/** Words that start like a stem but are about something else. */
const FALSE_FRIEND =
  /^(?:passport|passenger|passage|passion|passiv|passing|passed|passes|pinterest|ping|pink|pint|pine|pinch|pinpoint|pinned|keyboard|keynote|keyword|openai|codec|codex|coda|codebase|codegraph|coding|coder|codespace|entrepreneur|entropy|accounting|accountant|safety|safely|safeguard|tokeniz|administr|combine|combined|combines|combining|compter|comptable|porter|seeding|seeded|gateway|lockdown)/;
/** "Claude Code", "source code", "lines of code", "zip code": a code that opens nothing. */
const CODE_BEFORE = new Set(["claude", "vs", "source", "zip", "postal", "area", "country", "qr", "bar", "promo", "error", "status", "exit", "morse", "dress", "colour", "color", "iso", "http", "of"]);
const AR_STEMS = ["كود", "رمز", "باب", "بواب", "كلم", "قفل", "خزن", "سري", "باسو", "باسورد", "مرور", "انذار", "إنذار"];
const AR_PREFIX = /^(?:وال|بال|فال|كال|لل|ال|و|ب|ل|ف)/;

/** `after`: the text right after the word. A bare "pass" is a label only before its value's
 *  separator ("wifi pass: …", "pass = …"), never a verb ("the tests pass", "pass the report"). */
function isStemWord(t: string, prev: string, next: string, after = ""): boolean {
  if (FALSE_FRIEND.test(t)) return false;
  if (t === "pass" && !LABEL_AFTER.test(after) && next !== "phrase") return false;
  if (/^codes?$/.test(t) && (CODE_BEFORE.has(prev) || /^(?:review|reviews|reviewer|base)$/.test(next))) return false;
  if (t.startsWith("secret") && next.startsWith("scan")) return false;
  if (t === "open" && next === "source") return false;
  if (t === "pin" && next === "up" && /^[-‐]/.test(after)) return false; // a "PIN-up poster" opens nothing
  if (t === "seed" && /^(?:round|rounds|stage|funding|investors?|capital|fund|money|deck)$/.test(next)) return false;
  if (EXACT.has(t) || STEMS.some((s) => t.startsWith(s))) return true;
  if (/[؀-ۿ]/.test(t)) {
    const bare = t.replace(AR_PREFIX, "");
    return !/^بابا/.test(bare) && AR_STEMS.some((s) => bare.startsWith(s) || t.startsWith(s));
  }
  return false;
}

function intentIn(toks: readonly Token[], text: string): boolean {
  if (ACCESS_SYMBOL.test(text)) return true;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const t = tok?.t ?? "";
    const prev = toks[i - 1]?.t ?? "";
    const next = toks[i + 1]?.t ?? "";
    if (isStemWord(t, prev, next, text.slice(tok?.end ?? 0, (tok?.end ?? 0) + 12))) return true;
    // "wi-fi", "log in", "get into the flat", "let me in"
    if ((t === "wi" && next === "fi") || (t === "log" && next === "in") || (t === "get" && (next === "in" || next === "into")) || (t === "let" && (next === "in" || toks[i + 2]?.t === "in"))) return true;
  }
  return false;
}

/** True when `text` is about access or credentials (a stem, matched at a word's start). */
export function hasIntent(text: string): boolean {
  return intentIn(tokensOf(text), text);
}

/** A word that is itself about access ("garage", "password", "wifi"): never withheld as a value. */
function isIntentToken(t: string): boolean {
  return isStemWord(t, "", "", ":");
}

/** Access words that also mean everyday things in his notes ("open loops", "key results", "token
 *  savings", "a journal entry", "seed round", "admin work"): about access in a question or a reply,
 *  but in the notes they mark a value only as a label ("key: …", "admin — steph / …"). */
const EVERYDAY = new Set(
  "open opens opened opening key keys entry entries account accounts compte comptes token tokens secret secrets backup backups recovery admin admins seed seeds".split(" "),
);

/** A word in the notes that marks the value next to it as a credential. */
function marksValue(t: string, prev: string, next: string, after: string): boolean {
  if (EVERYDAY.has(t)) return LABEL_AFTER.test(after) && !/^\s*-\s*\p{L}/u.test(after);
  return isStemWord(t, prev, next, after);
}
/** A lock or key symbol: what the note is about when it has no word for it ("🔑 7731"). */
const ACCESS_SYMBOL = /[\u{1F511}\u{1F510}\u{1F512}\u{1F513}\u{1F5DD}]/u;

// ── numbers said in words ─────────────────────────────────────────────────

type NumTok = { kind: "digits"; s: string } | { kind: "unit" | "teen" | "tens"; v: number } | { kind: "mult"; v: number } | { kind: "rep"; n: number } | { kind: "plural"; v: number };

const WORDS: Record<string, NumTok> = {};
const put = (kind: "unit" | "teen" | "tens", pairs: Record<string, number>): void => {
  for (const [w, v] of Object.entries(pairs)) WORDS[w] = { kind, v };
};
// English ("o" and "oh" for zero, "niner" as radio operators say it)
put("unit", { zero: 0, oh: 0, o: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9 });
put("teen", { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 });
put("tens", { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
// French
put("unit", { zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9 });
put("teen", { dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16 });
put("tens", { vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 });
// Spanish (and the Portuguese words it lacks)
put("unit", { cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, dois: 2, quatro: 4, sete: 7, oito: 8 });
put("teen", { diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, dez: 10 });
put("tens", { veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 });
// Dutch
put("unit", { nul: 0, een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 });
put("teen", { tien: 10, elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19 });
put("tens", { twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90 });
// German (accents folded: fünf → funf, zwölf → zwolf)
put("unit", { null: 0, ein: 1, eine: 1, eins: 1, zwei: 2, zwo: 2, drei: 3, funf: 5, fuenf: 5, sechs: 6, sieben: 7, neun: 9 });
put("teen", { zehn: 10, zwolf: 12, zwoelf: 12, dreizehn: 13, vierzehn: 14, funfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19 });
put("tens", { zwanzig: 20, dreissig: 30, dreißig: 30, vierzig: 40, funfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 });
// Italian ("sette" is 6 in Arabizi: read as 7 next to another Italian number word, see runGroups)
put("unit", { due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, otto: 8, nove: 9 });
put("teen", { dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19 });
put("tens", { venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90 });
// Lebanese Arabizi
put("unit", { sefr: 0, sifr: 0, wa7ad: 1, wahad: 1, wa7ed: 1, wahed: 1, wa7de: 1, tnen: 2, tneyn: 2, tnein: 2, itnen: 2, etnen: 2, tlete: 3, tleteh: 3, tlata: 3, tleta: 3, arb3a: 4, arba3a: 4, arbaa: 4, khamse: 5, "5amse": 5, khamsa: 5, "5amsa": 5, sette: 6, sitte: 6, setteh: 6, sitta: 6, sab3a: 7, saba3a: 7, sabaa: 7, tmene: 8, tmeneh: 8, tamanya: 8, tmenye: 8, tmanye: 8, tes3a: 9, tis3a: 9, tesaa: 9 });
put("teen", { "3ashra": 10, ashra: 10, "3ashara": 10 });
// Arabic (hamza forms as ا, ة as ه)
put("unit", { صفر: 0, واحد: 1, واحده: 1, اثنان: 2, اثنين: 2, اتنين: 2, ثنين: 2, ثلاثه: 3, ثلاث: 3, تلاته: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7, ثمانيه: 8, ثماني: 8, ثمان: 8, تمانيه: 8, تسعه: 9, تسع: 9 });
put("teen", { عشره: 10 });
for (const w of ["hundred", "cent", "cents", "cien", "ciento", "cientos", "honderd", "hundert", "cento"]) WORDS[w] = { kind: "mult", v: 100 };
for (const w of ["thousand", "mille", "mil", "duizend", "tausend", "mila"]) WORDS[w] = { kind: "mult", v: 1000 };
WORDS.double = { kind: "rep", n: 2 };
WORDS.triple = { kind: "rep", n: 3 };
// "four zeros", "two fives": a digit said as a count
for (const [w, v] of Object.entries({ zeros: 0, zeroes: 0, ones: 1, twos: 2, threes: 3, fours: 4, fives: 5, sixes: 6, sevens: 7, eights: 8, nines: 9 })) WORDS[w] = { kind: "plural", v };
/** Number words that are also everyday words: numbers only next to another number word. */
const AMBIGUOUS = new Set(["one", "ones", "fours", "oh", "o", "un", "une", "uno", "una", "sept", "neuf", "once", "een", "elf", "nul", "cent", "cents", "mil", "double", "triple", "dix", "ست", "سبع", "null", "ein", "eine", "due", "sei", "otto", "tre", "sete", "dez"]);
/** Between two number words: "and", "then", "et", "puis", "y", "en", "w", "و", "und", "dann", "e", "poi", "dan". */
const CONNECTOR = new Set(["and", "then", "et", "puis", "y", "en", "w", "و", "ba3den", "und", "dann", "e", "poi", "dan", "luego"]);
const NL_TENS_UNIT = /^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(twintig|dertig|veertig|vijftig|zestig|zeventig|tachtig|negentig)$/;
const DE_TENS_UNIT = /^(ein|zwei|drei|vier|funf|sechs|sieben|acht|neun)und(zwanzig|dreissig|dreißig|vierzig|funfzig|sechzig|siebzig|achtzig|neunzig)$/;
const IT_TENS_UNIT = /^(vent|trent|quarant|cinquant|sessant|settant|ottant|novant)[ia]?(uno|due|tre|quattro|cinque|sei|sette|otto|nove)$/;
const IT_TENS: Record<string, number> = { vent: 20, trent: 30, quarant: 40, cinquant: 50, sessant: 60, settant: 70, ottant: 80, novant: 90 };
const IT_UNITS: Record<string, number> = { uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9 };
/** Italian number words that tell a run is Italian ("sette" is then 7, not the Arabizi 6). */
const ITALIAN = new Set(["due", "tre", "quattro", "cinque", "sei", "otto", "nove", "dieci", "venti", "trenta", "quaranta", "cinquanta", "cento", "mila"]);
const ES_VEINTI = /^veinti(uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)$/;

function numTok(t: string): NumTok | null {
  if (/^\d+$/.test(t)) return { kind: "digits", s: t };
  const ar = t.replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");
  const w = WORDS[t] ?? WORDS[ar] ?? (ar.startsWith("و") ? WORDS[ar.slice(1)] : undefined);
  if (w) return w;
  for (const re of [NL_TENS_UNIT, DE_TENS_UNIT]) {
    const m = re.exec(t);
    if (!m) continue;
    const u = WORDS[m[1] ?? ""];
    const tens = WORDS[m[2] ?? ""];
    if (u && tens && "v" in u && "v" in tens) return { kind: "digits", s: String(tens.v + u.v) };
  }
  const it = IT_TENS_UNIT.exec(t);
  if (it) return { kind: "digits", s: String((IT_TENS[it[1] ?? ""] ?? 0) + (IT_UNITS[it[2] ?? ""] ?? 0)) };
  const es = ES_VEINTI.exec(t);
  if (es) {
    const u = WORDS[es[1] === "un" ? "uno" : (es[1] ?? "")];
    if (u && "v" in u) return { kind: "digits", s: String(20 + u.v) };
  }
  return null;
}

/** One number as it was said: its digits, and whether it came from words. */
type Piece = { kind: "num"; s: string } | { kind: "mult"; v: number };

/** The numbers of a run, each whole: "forty-eight" is 48, "quatre-vingt-dix-neuf" 99, "double
 *  five" 55, "four zeros" 0000; "hundred" and "thousand" stay multipliers. */
function pieces(toks: readonly NumTok[]): Piece[] {
  const out: Piece[] = [];
  const num = (s: string | number): void => {
    out.push({ kind: "num", s: String(s) });
  };
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i];
    const n = toks[i + 1];
    const n2 = toks[i + 2];
    if (!x) break;
    if (x.kind === "mult") out.push({ kind: "mult", v: x.v });
    else if (x.kind === "digits") num(x.s);
    else if (x.kind === "rep") {
      if (n && n.kind === "unit") {
        num(String(n.v).repeat(x.n));
        i++;
      }
    } else if (x.kind === "plural") num(x.v);
    else if (x.kind === "unit" && n?.kind === "plural") {
      num(String(n.v).repeat(x.v));
      i++;
    } else if (x.kind === "unit" && x.v === 4 && n?.kind === "tens" && n.v === 20) {
      // quatre-vingt(-dix-sept)
      if (n2?.kind === "teen") {
        const n3 = toks[i + 3];
        if (n2.v === 10 && n3?.kind === "unit" && n3.v >= 7) {
          num(90 + n3.v);
          i += 3;
        } else {
          num(80 + n2.v);
          i += 2;
        }
      } else if (n2?.kind === "unit" && n2.v > 0) {
        num(80 + n2.v);
        i += 2;
      } else {
        num(80);
        i++;
      }
    } else if (x.kind === "tens" && n?.kind === "unit" && n.v > 0) {
      num(x.v + n.v);
      i++;
    } else if (x.kind === "tens" && x.v === 60 && n?.kind === "teen") {
      num(60 + n.v);
      i++;
    } else if (x.kind === "teen" && x.v === 10 && n?.kind === "unit" && n.v >= 7) {
      num(10 + n.v); // dix-sept
      i++;
    } else num(x.v);
  }
  return out;
}

/** A run of numbers as the separate numbers it says, each as digits: said digit by digit
 *  ("4 8 2 1" is 4, 8, 2, 1), in pairs ("forty-eight twenty-one": 48, 21), or with "hundred" and
 *  "thousand" by place value. A number is complete once a word would land on a place it already
 *  filled: "eight thousand eight hundred and thirty, and twenty-one" is 8830 then 21, never their
 *  sum. */
function runGroups(toks: readonly NumTok[]): string[] {
  const ps = pieces(toks);
  if (!ps.some((p) => p.kind === "mult")) return ps.flatMap((p) => (p.kind === "num" ? [p.s] : []));
  const out: string[] = [];
  let total = 0;
  let cur = 0;
  let open = false;
  const emit = (): void => {
    if (open) out.push(String(total + cur));
    total = 0;
    cur = 0;
    open = false;
  };
  for (const p of ps) {
    if (p.kind === "mult") {
      if (p.v === 1000) {
        if (total > 0) {
          out.push(String(total));
          total = 0;
        }
        total = (cur || 1) * 1000;
        cur = 0;
      } else if (cur >= 100) {
        emit();
        cur = 100;
      } else cur = (cur || 1) * 100;
      open = true;
      continue;
    }
    // A long number, or one with a leading zero, is its own ("0936", a phone number).
    if (p.s.length > 4 || (p.s.length > 1 && p.s.startsWith("0"))) {
      emit();
      out.push(p.s);
      continue;
    }
    const v = Number(p.s);
    if (open && cur % 10 ** p.s.length === 0 && v < 10 ** p.s.length) cur += v;
    else {
      emit();
      cur = v;
      open = true;
    }
  }
  emit();
  return out;
}

/** A run of numbers in `text` (digits, or words in English, French, Spanish, Dutch, German,
 *  Italian, Arabic or Arabizi), with its span, its digits, and the separate numbers it says. */
export interface NumberRun {
  start: number;
  end: number;
  digits: string;
  groups: string[];
}

/** What may separate two numbers of one run: spaces, commas, dots, ellipses, dashes, slashes,
 *  bullets (never a colon: "15:30" is a time, not a code). */
const GAP = /^[\s,.…\-–—/·•*]*$/;

export function numberRuns(text: string): NumberRun[] {
  const toks = tokensOf(text);
  const out: NumberRun[] = [];
  let run: Array<{ tok: Token; n: NumTok; word: boolean }> = [];
  let pendingConnector = false;
  const flush = (): void => {
    // A lone everyday word ("one of them", "Sept 2025") is not a number.
    const words = run.filter((r) => r.word);
    if (words.length === 1 && AMBIGUOUS.has(words[0]?.tok.t ?? "")) run = run.filter((r) => !r.word);
    // Arabizi words are letters and digits ("wa7ad"): only a run of two or more of them counts.
    if (run.length) {
      const first = run[0];
      const last = run[run.length - 1];
      const italian = run.some((r) => ITALIAN.has(r.tok.t));
      const groups = runGroups(run.map((r) => (italian && r.tok.t === "sette" ? { kind: "unit", v: 7 } : r.n)));
      const digits = groups.join("");
      if (first && last && digits) out.push({ start: first.tok.start, end: last.tok.end, digits, groups });
    }
    run = [];
    pendingConnector = false;
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (!tok) continue;
    const prev = toks[i - 1];
    const gapOk = prev ? GAP.test(text.slice(prev.end, tok.start)) : false;
    const n = numTok(tok.t);
    if (n) {
      const mixedArabizi = /\d/.test(tok.t) && /\p{L}/u.test(tok.t);
      if (run.length && !gapOk) flush();
      else if (!run.length) pendingConnector = false;
      if (mixedArabizi && !run.length && !numTok(toks[i + 1]?.t ?? "")) continue; // "wa7ad" alone
      run.push({ tok, n, word: n.kind !== "digits" || !/^\d+$/.test(tok.t) });
      pendingConnector = false;
      continue;
    }
    if (run.length && CONNECTOR.has(tok.t) && gapOk && !pendingConnector && numTok(toks[i + 1]?.t ?? "") && GAP.test(text.slice(tok.end, toks[i + 1]?.start ?? tok.end))) {
      pendingConnector = true;
      continue;
    }
    if (run.length) flush();
  }
  if (run.length) flush();
  return out;
}

/** True for a word that is a number word or digits (the blackout tells a number fragment by it). */
export function isNumberWord(t: string): boolean {
  return numTok(prepareText(t)) !== null;
}

/** The digit a single word says ("six", "oh", "sechs", "7"), or null. */
export function digitWord(t: string): string | null {
  const n = numTok(prepareText(t));
  if (!n) return null;
  if (n.kind === "digits") return n.s.length === 1 ? n.s : null;
  return n.kind === "unit" ? String(n.v) : null;
}

/** The digit an everyday word says when it is a digit ("one", "oh", "un", "uno", "een", "sei"):
 *  numberRuns leaves such a word out when it stands alone ("one of them"); the blackout decides by
 *  where it stands. Null for any other word. */
export function looseDigit(t: string): string | null {
  const p = prepareText(t);
  const n = numTok(p);
  return n?.kind === "unit" && AMBIGUOUS.has(p) ? String(n.v) : null;
}

/** True for a connector between two numbers ("and", "then", "et", "und", …). */
export function isConnector(t: string): boolean {
  return CONNECTOR.has(prepareText(t));
}

// ── what the turn's notes and lookups held ────────────────────────────────

/** Function words and everyday verbs: never withheld as a copied word. */
const FUNCTION = new Set(
  (
    "a an the this that these those it its is are was were be been being am of in on at to for from by with into onto over under about as and or but so if then than not no yes " +
    "my your his her our their me you him them us i we he she they who what where when why how which there here all any some each every just also still now first last next same only " +
    "use used uses set sets get gets got has have had do does did go goes went make made press enter type tap punch dial opens opened opener keep kept hold holds held " +
    "note notes file files called named says said write wrote written closed sir please okay ok thing one ones s t d ll re ve m " +
    "le la les des du de et ou au aux dans sur pour par avec est sont ce cette ces mon ma mes ton ta tes son sa ses notre votre leur il elle ils elles je tu nous vous qui que quoi c l d j n qu " +
    "el los las del y o en con por para es son su sus mi mis tu tus lo al " +
    "het een van voor op met zijn mijn jouw je jij hij zij wij dat die " +
    "taba3 tab3 huwe huwwe hiye hiyye fi 3al 3a ma bi ya"
  ).split(/\s+/),
);
/** Everyday names of things that are never a secret on their own. */
const KNOWN = new Set(
  "email emails username usernames wifi wi fi iphone ipad android ios macos mac laptop gmail google whatsapp netflix spotify amazon paypal icloud apple microsoft outlook windows router wpa wpa2 wpa3 wep nas synology netgear tesla bitwarden passwordmanager lastpass keychain notion vault app apps api url sso oauth website online offline".split(" "),
);

/** How many words either side of an access word a value in the notes may sit (function words
 *  like "the", "is", "on" not counted). */
const NEAR = 6;

/** A number the way a code is written: 3+ digits, spaced, dashed or in words, but not a decimal
 *  or a version, an amount with thousands, a date, a time or a year ("83.1", "2.1.283", "1,782",
 *  "14/10", "2026-10-14", "15:30", "2025"). */
function codeShaped(raw: string, digits: string): boolean {
  if (digits.length < 3 || /\d[.:/]\d|\d,\d{3}(?!\d)/.test(raw)) return false;
  if (/^(?:19|20)\d\d$/.test(raw)) return false;
  return !/^(?:19|20)\d\d[-–]\d\d?[-–]\d\d?$/.test(raw);
}

/** The password of a URL's user part ("https://steph:hunter2@nas.local"). */
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi;

/** The turn's sources (the retrieved notes, the world summary, each tool result), as the guard
 *  compares them: their tokens, their digits, and the words they wrote about access. */
export class GuardSources {
  readonly tokens = new Set<string>();
  readonly intentWords = new Set<string>();
  /** What the notes wrote within NEAR words of a word for what opens something ("Cabin door: 7731",
   *  "wifi — pass: qahwa123"): its words and whole words (normalised), and its code-shaped numbers.
   *  Withheld from every sentence, about access or not. */
  readonly accessTokens = new Set<string>();
  readonly accessDigits = new Set<string>();
  /** Each source's number runs and its digits in order, "\0"-separated (never across sources). */
  private digits = "";
  /** Each source's letters and digits in order, without separators: a value the reply re-spaces
   *  ("Qx7m-B2pz" said "Qx7mB2pz", or spelled "s w o r d…") is still a copy. */
  private streams: string[] = [];

  add(text: string): void {
    if (!text) return;
    for (const tok of tokensOf(text)) {
      const n = normalizeValue(tok.t);
      if (n) this.tokens.add(n);
    }
    const stream = normalizeValue(text);
    if (stream) this.streams.push(stream);
    for (const r of numberRuns(text)) this.digits += `${r.digits}\u0000`;
    const all = foldText(text).replace(/\D+/g, "");
    if (all) this.digits += `${all}\u0000`;
    for (const clause of text.split(/(?<=[.!?;])\s+|\n+|\s\|\s/)) {
      const toks = tokensOf(clause);
      if (!intentIn(toks, clause)) continue;
      for (const t of toks) {
        const n = normalizeValue(t.t);
        if (n.length >= 3 && !FUNCTION.has(n)) this.intentWords.add(n);
      }
    }
    // Values next to what they open: across sentences and lines ("Back entrance. The number is
    // 7390.", "## Garage\n6093"), never across a blank line or a table cell.
    for (const para of text.split(/\n\s*\n|\s\|\s/)) this.addAccessValues(para);
    for (const m of text.matchAll(URL_USERINFO)) {
      const n = normalizeValue(m[1] ?? "");
      if (n.length >= 3) this.accessTokens.add(n);
      if (/^\d{3,}$/.test(n)) this.accessDigits.add(n);
    }
  }

  /** The values within NEAR words of a word that marks one (a lock symbol marks its whole line). */
  private addAccessValues(para: string): void {
    const toks = tokensOf(para);
    // Distance in words that carry meaning ("the lock screen on the old Pixel is 663311": 4).
    const pos: number[] = [];
    let content = 0;
    for (const t of toks) {
      pos.push(content);
      if (!FUNCTION.has(normalizeValue(t.t))) content++;
    }
    const marks: number[] = []; // the positions of the words that mark a value, in order
    toks.forEach((tok, i) => {
      if (marksValue(tok.t, toks[i - 1]?.t ?? "", toks[i + 1]?.t ?? "", para.slice(tok.end, tok.end + 12))) marks.push(pos[i] ?? 0);
    });
    const near = new Set<number>();
    let m = 0;
    toks.forEach((_, j) => {
      const at = pos[j] ?? 0;
      while (m < marks.length && (marks[m] ?? 0) < at - NEAR) m++;
      if (m < marks.length && (marks[m] ?? 0) <= at + NEAR) near.add(j);
    });
    for (const line of para.matchAll(/[^\n]+/g)) {
      if (!ACCESS_SYMBOL.test(line[0])) continue;
      toks.forEach((t, i) => {
        if (t.start >= line.index && t.start < line.index + line[0].length) near.add(i);
      });
    }
    if (!near.size) return;
    const index = new Map(toks.map((t, i) => [t.start, i]));
    toks.forEach((tok, i) => {
      const n = normalizeValue(tok.t);
      if (near.has(i) && n.length >= 3 && !FUNCTION.has(n) && !KNOWN.has(n)) this.accessTokens.add(n);
    });
    for (const w of wordsOf(para)) {
      const i = index.get(w.start);
      const n = normalizeValue(para.slice(w.start, w.end));
      if (i !== undefined && near.has(i) && n.length >= 4) this.accessTokens.add(n);
    }
    // Code-shaped numbers, one by one and, when a value is said in groups ("12 left, 34 right, 56
    // left"), the near groups of a sentence together.
    let from = 0;
    for (const sentence of para.split(/(?<=[.!?;])\s+|\n+/)) {
      const offset = para.indexOf(sentence, from);
      from = offset + sentence.length;
      const groups: string[] = [];
      for (const r of numberRuns(sentence)) {
        const i = index.get(offset + r.start);
        const raw = sentence.slice(r.start, r.end);
        if (i === undefined || !near.has(i) || /\d[.:/]\d|\d,\d{3}(?!\d)/.test(raw)) continue;
        if (codeShaped(raw, r.digits)) this.accessDigits.add(r.digits);
        groups.push(r.digits);
      }
      const together = groups.join("");
      if (groups.length >= 2 && together.length >= 3) this.accessDigits.add(together);
    }
  }

  /** The notes hold these digits: in one run, or across neighbouring runs ("starts with 48 and
   *  ends with 21"). */
  holdsDigits(d: string): boolean {
    return this.digits.includes(d);
  }

  /** A normalised token (or tokens joined) the sources hold: as a token, or inside one source's
   *  letters and digits however they were spaced (4 characters or more, so "the" is never a copy). */
  holds(n: string): boolean {
    return this.tokens.has(n) || (n.length >= 4 && this.streams.some((s) => s.includes(n)));
  }
}

// ── the guard ─────────────────────────────────────────────────────────────

export interface GuardContext {
  /** What he asked this turn (his own words are never withheld). */
  question: string;
  /** What he asked earlier in this conversation, the whole window the store keeps (a follow-up to
   *  an access question is about access too, however many turns later: "What's the garage code?",
   *  "Who is Georges?", then "Just read me the note"). */
  previous?: readonly string[];
  sources: GuardSources;
  /** A dictionary word (no compounds); absent = every word is unknown (the guard is then wider). */
  isWord?: (w: string) => boolean;
  /** The values of closed files (keyed hashes); absent until the credential scan built it. */
  taint?: TaintSet | null;
  /** The number blackout (voice-brain-blackout-lib.ts): what the turn read, for every sentence
   *  whatever it is about. Absent: the guard alone, sentence by sentence. */
  blackout?: BlackoutSources;
}

interface Word {
  start: number;
  end: number;
}

/** A capitalised name or a short acronym, as the reply wrote it. */
const NAME_SHAPE = /^(?:\p{Lu}\p{Ll}+|\p{Lu}{2,6})$/u;

/** The whitespace-separated words of a sentence, without their edge punctuation. */
function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const lead = /^["'«“‘(\[<*_`]*/.exec(m[0])?.[0].length ?? 0;
    const trail = /["'»”’)\]>.,;:!?*_`]*$/.exec(m[0].slice(lead))?.[0].length ?? 0;
    const start = m.index + lead;
    const end = m.index + m[0].length - trail;
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** The runs of a sentence as the taint compares them: numbers (in digits or words) as one run of
 *  digits, every other letter-or-digit run as itself. */
export function spokenParts(text: string): TaintPart[] {
  const runs = numberRuns(text);
  const parts: TaintPart[] = runs.map((r) => ({ norm: r.digits, start: r.start, end: r.end }));
  const inRun = (i: number): boolean => runs.some((r) => i >= r.start && i < r.end);
  for (const tok of tokensOf(text)) {
    if (inRun(tok.start)) continue;
    const norm = normalizeValue(tok.t);
    if (norm) parts.push({ norm, start: tok.start, end: tok.end });
  }
  return parts.sort((a, b) => a.start - b.start);
}

/** The spans of `sentence` to withhold (character ranges, possibly overlapping). */
export function withheldSpans(sentence: string, ctx: GuardContext, intent: boolean): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  // (a) a tainted value, however it is said
  if (ctx.taint) {
    const parts = spokenParts(sentence);
    for (const [a, b] of ctx.taint.partHits(parts, TIER_SPOKEN)) {
      const pa = parts[a];
      const pb = parts[b];
      if (pa && pb) spans.push([pa.start, pb.end]);
    }
  }
  const q = new Set(tokensOf(ctx.question).map((t) => normalizeValue(t.t)));
  const qDigits = numberRuns(ctx.question).map((r) => r.digits);
  // His own numbers and words stay, exactly as he said them (not a longer run that holds one).
  const runs = numberRuns(sentence).filter((r) => !qDigits.includes(r.digits));
  const toks = tokensOf(sentence);
  const words = wordsOf(sentence).map((w) => ({ ...w, raw: sentence.slice(w.start, w.end), n: normalizeValue(sentence.slice(w.start, w.end)) }));
  // (c) a value the notes wrote next to what it opens, in any sentence ("Cabin door: 7731" said as
  //     "Your note says 7731"): its code-shaped numbers, and its words that are not dictionary words
  for (const r of runs) if (ctx.sources.accessDigits.has(r.digits)) spans.push([r.start, r.end]);
  const groups = runs.filter((r) => !/^:\d/.test(sentence.slice(r.end)) && !/\d:$/.test(sentence.slice(0, r.start)));
  const together = groups.map((r) => r.digits).join("");
  if (groups.length >= 2 && ctx.sources.accessDigits.has(together) && !qDigits.includes(together)) for (const r of groups) spans.push([r.start, r.end]);
  for (const tok of toks) {
    const n = normalizeValue(tok.t);
    if (n.length >= 3 && !q.has(n) && !/^\d+$/.test(n) && ctx.sources.accessTokens.has(n) && valueToken(n, sentence.slice(tok.start, tok.end), ctx.isWord)) spans.push([tok.start, tok.end]);
  }
  for (const w of words) if (w.n.length >= 4 && !q.has(w.n) && ctx.sources.accessTokens.has(w.n) && valueWord(w.raw, ctx.isWord)) spans.push([w.start, w.end]);
  if (!intent) return spans;
  // (b) copied from the notes, in a sentence about access
  for (const r of runs) if (r.digits.length >= 3 && ctx.sources.holdsDigits(r.digits)) spans.push([r.start, r.end]);
  // A combination said in groups with words between them ("left 22, right 8, left 15"): the
  // sentence's numbers together (a time of day aside).
  if (groups.length >= 2 && together.length >= 3 && !qDigits.includes(together) && ctx.sources.holdsDigits(together)) for (const r of groups) spans.push([r.start, r.end]);
  for (const tok of toks) {
    const n = normalizeValue(tok.t);
    if (n.length < 3 || /^\d+$/.test(n) || numTok(tok.t) || q.has(n) || FUNCTION.has(n) || KNOWN.has(n) || isIntentToken(tok.t)) continue;
    const inAccessClause = ctx.sources.intentWords.has(n);
    // A name ("Samir", "Lisbon", "ACME") is said unless the notes wrote it about access.
    if (NAME_SHAPE.test(sentence.slice(tok.start, tok.end)) && !inAccessClause) continue;
    const mixed = /\d/.test(n) && /\p{L}/u.test(n);
    const known = ctx.isWord ? ctx.isWord(n) : false;
    if (inAccessClause || ((mixed || !known) && ctx.sources.holds(n))) spans.push([tok.start, tok.end]);
  }
  // A word joined by symbols with a part that is not a word ("Melody#44", "steph.b", "Qx7m-B2pz").
  for (const w of words) if (w.n.length >= 4 && !q.has(w.n) && valueWord(w.raw, ctx.isWord) && ctx.sources.holds(w.n)) spans.push([w.start, w.end]);
  // A value spelled out, one character at a time ("s, w, o, r, d, f, i, s, h, 9"; "Q x 7 m"): any
  // 3+ characters of a run in a row that the sources hold ("It's Q x 7 m" starts its run at "s").
  for (const run of spelledRuns(sentence, toks))
    for (let i = 0; i + 3 <= run.length; i++)
      for (let j = run.length; j >= i + 3; j--) {
        const n = normalizeValue(run.slice(i, j).map((t) => t.t).join(""));
        const first = run[i];
        const last = run[j - 1];
        if (first && last && !q.has(n) && ctx.sources.holds(n)) {
          spans.push([first.start, last.end]);
          i = j - 1;
          break;
        }
      }
  return spans;
}

/** One letter-or-digit run that looks like part of a value, not a word: letters mixed with digits,
 *  or letters that are not a dictionary word, a name, a function word or an access word. */
function valueToken(n: string, raw: string, isWord: GuardContext["isWord"]): boolean {
  if (/\d/.test(n)) return /\p{L}/u.test(n);
  if (FUNCTION.has(n) || KNOWN.has(n) || isIntentToken(n) || NAME_SHAPE.test(raw)) return false;
  return !(isWord?.(n) ?? false);
}

/** A whole word of 2+ runs joined by symbols ("Melody#44", "steph.b", "tamarind-owl-3") where a run
 *  has a digit or is not a dictionary word ("post-it" and "e-mail" are words). */
function valueWord(raw: string, isWord: GuardContext["isWord"]): boolean {
  const parts = tokensOf(raw).map((t) => normalizeValue(t.t));
  if (parts.length < 2) return false;
  return parts.some((p) => /\d/.test(p) || (p.length >= 2 && !FUNCTION.has(p) && !KNOWN.has(p) && !isIntentToken(p) && !(isWord?.(p) ?? false)));
}

/** Runs of 3 or more single letters or digits with only short separators between them. */
function spelledRuns(text: string, toks: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let run: Token[] = [];
  const flush = (): void => {
    if (run.length >= 3) out.push(run);
    run = [];
  };
  for (const tok of toks) {
    const prev = run[run.length - 1];
    if (normalizeValue(tok.t).length !== 1) {
      flush();
      continue;
    }
    if (prev && !/^[\s,.\-–—/·_]{1,4}$/.test(text.slice(prev.end, tok.start))) flush();
    run.push(tok);
  }
  flush();
  return out;
}

/** `sentence` with its withheld spans cut: what comes before the first one (whole words), then the
 *  notice. "" when nothing of it may be said. */
export function rewriteSentence(sentence: string, spans: ReadonlyArray<readonly [number, number]>, notice = WITHHELD_SPOKEN): string {
  if (!spans.length) return sentence;
  const words = wordsOf(sentence);
  // A span takes the whole word(s) it touches ("Hunter!2", "admin/Qx7mB2pz").
  let first = sentence.length;
  for (const [a, b] of spans) {
    let s = a;
    for (const w of words) if (w.start < b && w.end > a) s = Math.min(s, w.start);
    first = Math.min(first, s);
  }
  const before = sentence.slice(0, first).replace(/[\s,;:—–\-=→>|/(]+$/u, "").trimEnd();
  const lead = /^\s*/.exec(sentence)?.[0] ?? "";
  // Nothing worth keeping before it ("It's", "C'est"): the notice alone.
  if (tokensOf(before).every((t) => FUNCTION.has(normalizeValue(t.t)) || t.t === "sir")) return `${lead}${notice}`;
  return `${before} — ${notice.replace(/^That /, "that ")}`;
}

/** At most this many sentences wait for what follows them (a reply read digit by digit). */
const MAX_HELD = 12;

/** The guard over one reply, sentence by sentence. The turn is about access when he asked about
 *  access in this conversation; the reply is from its first sentence about access on ("You'll
 *  need the garage code. Your note has it. It's 6093."). With a blackout, a sentence that is only a
 *  piece of a number ("Six.", "- 60") or whose digits start a note's number waits and is judged
 *  with what follows it (push, then flush at the end of the turn). */
export class ReplyGuard {
  private replyIntent = false;
  private lastWithheld = false;
  private readonly asked: boolean;
  private readonly blackout: BlackoutTurn | null;
  private held: string[] = [];

  constructor(private readonly ctx: GuardContext) {
    this.asked = hasIntent(ctx.question) || (ctx.previous ?? []).some((p) => hasIntent(p));
    this.blackout = ctx.blackout ? ctx.blackout.turn(ctx.question, () => ctx.taint) : null;
  }

  /** The reply so far, or the conversation, is about access. */
  get intent(): boolean {
    return this.replyIntent || this.asked;
  }

  /** One spoken sentence, guarded now (no waiting); "" when it adds nothing (a second withheld
   *  sentence in a row). */
  sentence(s: string): string {
    return this.judge(s);
  }

  /** One sentence as it streams in: what may be said now (it can be nothing while a number is
   *  still being read out, then several at once). */
  push(s: string): string[] {
    if (this.blackout && this.held.length < MAX_HELD && this.blackout.wantsHold(s, this.held)) {
      this.held.push(s);
      return [];
    }
    const group = [...this.held, s];
    this.held = [];
    return this.release(group);
  }

  /** The end of the turn (or one of Alef's own lines is next): what was waiting, guarded. */
  flush(): string[] {
    const group = this.held;
    this.held = [];
    return this.release(group);
  }

  /** True when `text` (an action's field, not said) holds what a sentence could not say: a note's
   *  number or code, a closed file's value, or what the copy guard withholds. */
  carries(text: string): boolean {
    return withheldSpans(text, this.ctx, this.intent).length > 0 || (this.blackout?.carries(text) ?? false);
  }

  private release(group: readonly string[]): string[] {
    if (!group.length) return [];
    if (group.length === 1) {
      const out = this.judge(group[0] ?? "");
      return out ? [out] : [];
    }
    // Judged as one: the digits of "Six." "Oh." "Nine." "Three." are one number.
    const parts = group.map((g) => g.trim());
    const joined = parts.join(" ");
    const verdict = this.assess(joined);
    if (!verdict) {
      this.say(joined, null);
      return [...group];
    }
    // The sentences after the last withheld part are still said, after the notice ("Six. Oh.
    // Nine. Three. Dinner is on Friday." → the notice, then "Dinner is on Friday.").
    const lastEnd = Math.max(...verdict.spans.map(([, e]) => e));
    let at = 0;
    let cut = parts.length;
    for (const [i, p] of parts.entries()) {
      if (at >= lastEnd) {
        cut = i;
        break;
      }
      at += p.length + 1;
    }
    const head = this.say(parts.slice(0, cut).join(" "), verdict);
    const rest = parts.slice(cut).flatMap((p) => {
      const o = this.judge(p);
      return o ? [o] : [];
    });
    return [...(head ? [head] : []), ...rest];
  }

  /** What `s` may not say (the guard's spans and the blackout's), or null; nothing is recorded. */
  private assess(s: string): { spans: Array<[number, number]>; notice: string } | null {
    if (hasIntent(s)) this.replyIntent = true;
    const spans = withheldSpans(s, this.ctx, this.intent);
    const b = this.blackout?.judge(s) ?? null;
    if (!spans.length && !b) return null;
    return { spans: b ? [...spans, ...b.spans] : spans, notice: b ? b.notice : WITHHELD_SPOKEN };
  }

  /** `s` as it may be said given its verdict, recorded as said; "" for a second notice in a row. */
  private say(s: string, verdict: { spans: Array<[number, number]>; notice: string } | null): string {
    if (!verdict) {
      this.lastWithheld = false;
      this.blackout?.commit(s);
      return s;
    }
    const out = rewriteSentence(s, verdict.spans, verdict.notice);
    this.blackout?.commit(out);
    const whole = out.trim() === verdict.notice;
    if (whole && this.lastWithheld) return "";
    this.lastWithheld = true;
    return out;
  }

  private judge(s: string): string {
    return this.say(s, this.assess(s));
  }

  /** A whole reply (the stored one), sentence by sentence, with its own state. */
  static text(text: string, ctx: GuardContext): string {
    const g = new ReplyGuard(ctx);
    const out: string[] = [];
    for (const s of text.split(/(?<=[.!?;])\s+|\n+/)) if (s.trim()) out.push(...g.push(s));
    out.push(...g.flush());
    return out.filter(Boolean).join(" ");
  }
}
