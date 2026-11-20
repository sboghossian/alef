// Pure rules of the credential scanner (credential-scan.ts does the IO). Alef never guesses at a
// secret in what it is about to SAY; it keeps whole files that hold one CLOSED instead: never
// retrieved, never listed, never readable by a deep lookup. So these rules are high-RECALL on
// purpose (closing a harmless note costs little; a spoken password costs a lot), and they run on
// file text, never on Alef's own sentences.
//
// A file is excluded when any rule below fires. The result is a set of REASON CLASSES, never a
// value: values are collected only on request (collectValues), in memory, for the spoken filter.
//
// Two kinds of text: prose (notes, exports, transcripts: every rule) and code/config (hardcoded
// secrets only: token shapes, private keys, secret-named assignments with a literal value).
//
// The reply guard's own, looser net (looseSecretValues, at the end) lives here too: it never closes
// a file, it only names values a reply must not repeat, so it can afford to be much wider.

import { basename, extname } from "node:path";

/** Bump when a rule changes: a persisted scan made under other rules is thrown away. */
export const SCANNER_RULES_VERSION = "2026-09-29.1";

export const CREDENTIAL_REASONS = [
  "private-key",
  "api-token",
  "env-secret",
  "password-manager",
  "recovery-code",
  "password",
  "access-code",
  "credential-table",
  "login-pair",
  "card-number",
  "credential-name",
  "unvetted",
  "tainted-value",
] as const;
export type CredentialReason = (typeof CREDENTIAL_REASONS)[number];

export type FileKind = "prose" | "code" | "binary";

/** Formats never read as text: a credential in one can't be seen (see credential-name). */
const BINARY_EXT = new Set(
  (
    ".png .jpg .jpeg .gif .webp .bmp .tif .tiff .heic .heif .ico .icns .psd .ai .sketch .fig .exr .hdr .svgz " +
    ".pdf .doc .docx .xls .xlsx .ppt .pptx .key .numbers .pages .odt .ods .odp .epub " +
    ".mp3 .mp4 .m4a .m4v .mov .avi .mkv .webm .wav .aiff .aif .flac .ogg .aac .caf .pcm .aep " +
    ".zip .gz .tgz .bz2 .xz .7z .rar .tar .dmg .pkg .jar .war .whl .apk .ipa " +
    ".so .dylib .dll .exe .bin .o .a .class .pyc .pyo .wasm .node " +
    ".woff .woff2 .ttf .otf .eot .db .sqlite .sqlite3 .db-wal .db-shm .sst .pak .mmap .dat " +
    ".onnx .pt .pth .npy .npz .h5 .ckpt .safetensors .gguf .parquet .arrow .glb .fbx .blend .usdz"
  ).split(/\s+/),
);

/** Notes, exports and transcripts: read with every rule. No extension counts as prose. */
const PROSE_EXT = new Set(
  ".md .markdown .mdx .txt .text .eml .emlx .rtf .org .html .htm .csv .tsv .log .jsonl .vtt .srt .adoc .rst .wiki .textile .note .notes .msg .mbox .ics .vcf".split(/\s+/),
);

/** Config formats whose unquoted `key: value` / `key = value` lines count like a .env file. */
const CONFIG_EXT = new Set(".yml .yaml .toml .ini .conf .cfg .properties .sh .bash .zsh .fish .ps1 .envrc .tf .hcl .xml .plist .service .desktop".split(/\s+/));

export function fileKind(path: string): FileKind {
  const ext = extname(path).toLowerCase();
  if (BINARY_EXT.has(ext)) return "binary";
  if (PROSE_EXT.has(ext) || ext === "") return "prose";
  return "code";
}

function isConfigFile(path: string): boolean {
  const base = basename(path).toLowerCase();
  return CONFIG_EXT.has(extname(base)) || base === "dockerfile" || base.startsWith("dockerfile.") || base === "makefile" || base.endsWith(".env.example");
}

// ── file names ─────────────────────────────────────────────────────────────

/** A name that says what it holds, whatever its length: an Emergency Kit, recovery codes, an export. */
const NAME_STRONG =
  /(?:^|[^a-z0-9])(?:emergency[ _.-]*kit|recovery[ _.-]*(?:codes?|keys?|phrases?)|backup[ _.-]*codes?|seed[ _.-]*phrases?|(?:passwordmanager|bitwarden|lastpass|keepass(?:xc)?|dashlane|enpass|nordpass|proton[ _-]?pass)[ _.-]*(?:export|backup|emergency|kit|vault|data|items)|1pux|1pif)(?:[^a-z0-9]|$)/i;
/** A short name (≤ 4 words once a Notion id is dropped) that names credentials: "Passwords.md",
 *  "Wifi password.pdf", "Door codes 1a2b3c4d.md". Long slugs ("passwordmanager-lets-claude-log-you-in…")
 *  are articles about credentials, and their text is scanned anyway. */
const NAME_SHORT =
  /(?:^|[^a-z0-9])(?:passwords?|passwds?|passcodes?|pwds?|credentials?|creds|logins?|mdp|mots?[ _-]de[ _-]passe|pins?[ _-]?codes?|door[ _-]?codes?|access[ _-]?codes?|digicodes?)(?:[^a-z0-9]|$)/i;

/** The reasons a file's NAME gives ([] or ["credential-name"]). */
export function scanName(path: string): CredentialReason[] {
  const base = basename(path);
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  if (NAME_STRONG.test(stem)) return ["credential-name"];
  const words = stem
    .replace(/[\s_-]+[0-9a-f]{8,32}$/i, "")
    .split(/[\s_.-]+/)
    .filter(Boolean);
  return words.length <= 4 && NAME_SHORT.test(stem) ? ["credential-name"] : [];
}

// ── other scripts and forms ────────────────────────────────────────────────

/** Bidi marks and invisible characters (zero-width space and joiners, word joiner, soft hyphen,
 *  BOM): "pass\u200bword" is "password". */
const BIDI_MARKS = /[\u200b-\u200f\u00ad\u061c\u180e\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const HAS_BIDI_MARK = new RegExp(BIDI_MARKS.source);
/** A word spelled out in single letters ("P A S S W O R D"): four letters or more (three are
 *  initials: "I O U"). */
const SPACED_LETTERS = /(?<![A-Za-z0-9])[A-Za-z](?: [A-Za-z]){3,}(?![A-Za-z0-9])/g;
const HAS_SPACED_LETTERS = /[A-Za-z] [A-Za-z] [A-Za-z] [A-Za-z]/;
const ND = /^\p{Nd}$/u;
/** The digits of every other script in the BMP (Arabic-Indic, Persian, Devanagari, Thai, …) as one
 *  plain character class, built once: a property class is several times slower to scan with.
 *  Fullwidth and mathematical digits are folded by NFKC before this runs. */
const OTHER_DIGITS = ((): RegExp => {
  let cls = "";
  const hex = (n: number): string => `\\u${n.toString(16).padStart(4, "0")}`;
  for (let cp = 0x80; cp <= 0xffff; cp++) {
    if (!ND.test(String.fromCharCode(cp))) continue;
    let end = cp;
    while (end < 0xffff && ND.test(String.fromCharCode(end + 1))) end++;
    cls += `${hex(cp)}-${hex(end)}`;
    cp = end;
  }
  return new RegExp(`[${cls}]`, "g");
})();
const OTHER_DIGIT = new RegExp(OTHER_DIGITS.source);
/** What NFKC changes that the rules care about: combining accents (a decomposed "é"), ligatures,
 *  Arabic presentation forms, fullwidth and halfwidth forms. Other text skips the normalization. */
const NFKC_MATTERS = /[\u0300-\u036f\ufb00-\ufdff\ufe70-\ufeff\uff00-\uffef]/;
/** A bidi mark or another script's digit: one scan decides whether either pass is needed. */
const FOLD_MATTERS = new RegExp(`[${BIDI_MARKS.source.slice(1, -1)}${OTHER_DIGITS.source.slice(1, -1)}]`);
/** One digit of any script as ASCII: Unicode lays every script's digits out 0-9 in a row. */
function asciiDigit(ch: string): string {
  if (ch >= "0" && ch <= "9") return ch;
  const cp = ch.codePointAt(0) ?? 0;
  let k = 0;
  while (k < 90 && ND.test(String.fromCodePoint(cp - k - 1))) k++;
  return String(k % 10);
}

/** Text as the rules read it: fullwidth forms, Arabic presentation forms and ligatures folded
 *  (NFKC), bidi marks and zero-width characters dropped, every script's digits in ASCII ("٣٣٤٤",
 *  "３３４４" → "3344"), and a word spelled out in letters joined ("P A S S W O R D" → "PASSWORD").
 *  Other ASCII text comes back unchanged. */
export function foldText(s: string): string {
  let t = s;
  if (/[^\x00-\x7f]/.test(t)) {
    if (NFKC_MATTERS.test(t)) t = t.normalize("NFKC");
    if (FOLD_MATTERS.test(t)) {
      if (HAS_BIDI_MARK.test(t)) t = t.replace(BIDI_MARKS, "");
      if (OTHER_DIGIT.test(t)) t = t.replace(OTHER_DIGITS, asciiDigit);
    }
  }
  return HAS_SPACED_LETTERS.test(t) ? t.replace(SPACED_LETTERS, (m) => m.replace(/ /g, "")) : t;
}

// ── numbers said in words ──────────────────────────────────────────────────

const NUM_UNIT: Readonly<Record<string, number>> = { zero: 0, oh: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const NUM_TEEN: Readonly<Record<string, number>> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const NUM_TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM_WORD = [...Object.keys(NUM_UNIT), ...Object.keys(NUM_TEEN), ...Object.keys(NUM_TENS), "hundred", "thousand", "double", "triple"].join("|");
const NUM_RUN = new RegExp(String.raw`\b(?:${NUM_WORD})\b(?:(?:[^\S\n]*[,-][^\S\n]*|[^\S\n]+(?:and[^\S\n]+)?)(?:${NUM_WORD})\b)*`, "gi");
const HAS_NUM_WORD = new RegExp(String.raw`\b(?:${NUM_WORD})\b`, "i");

function numberRun(words: readonly string[]): string {
  if (words.includes("hundred") || words.includes("thousand")) {
    let total = 0;
    let cur = 0;
    for (const w of words) {
      if (w === "hundred") cur = (cur || 1) * 100;
      else if (w === "thousand") {
        total += (cur || 1) * 1000;
        cur = 0;
      } else cur += NUM_UNIT[w] ?? NUM_TEEN[w] ?? NUM_TENS[w] ?? 0;
    }
    return String(total + cur);
  }
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    const next = words[i + 1] ?? "";
    const unit = NUM_UNIT[next];
    if ((w === "double" || w === "triple") && unit !== undefined) {
      out += String(unit).repeat(w === "double" ? 2 : 3);
      i++;
    } else if (NUM_TENS[w] !== undefined) {
      if (unit !== undefined && unit > 0) {
        out += String(NUM_TENS[w] + unit);
        i++;
      } else out += String(NUM_TENS[w]);
    } else if (NUM_TEEN[w] !== undefined) out += String(NUM_TEEN[w]);
    else if (NUM_UNIT[w] !== undefined) out += String(NUM_UNIT[w]);
  }
  return out;
}

const FR_UNIT: Readonly<Record<string, number>> = { zéro: 0, zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9 };
const FR_TEEN: Readonly<Record<string, number>> = { dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16 };
const FR_TENS: Readonly<Record<string, number>> = { vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };
const FR_WORD = [...Object.keys(FR_UNIT), ...Object.keys(FR_TEEN), ...Object.keys(FR_TENS), "cents?", "mille"].join("|");
const FR_RUN = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${FR_WORD})(?![\p{L}\p{N}])(?:(?:[^\S\n]*[,-][^\S\n]*|[^\S\n]+)(?:et(?:[^\S\n]+|-))?(?:${FR_WORD})(?![\p{L}\p{N}]))*`, "giu");
/** A cheap first look for a French-only number word (ASCII word boundaries: fast). */
const HAS_FR_WORD = /\b(?:une?|deux|trois|quatre|cinq|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingts?|trente|quarante|cinquante|soixante|cents?|mille|z[ée]ro)\b/i;

/** A number under 100 said in French from words[i]: [value, words used] ("quatre-vingt-dix-neuf" → 99). */
function frenchUnder100(words: readonly string[], i: number): [number, number] | null {
  const w = words[i] ?? "";
  const next = words[i + 1] ?? "";
  const after = words[i + 2] ?? "";
  /** 10-19 from here: "dix", "onze"…"seize", "dix-sept"…"dix-neuf". */
  const teen = (j: number): [number, number] | null => {
    const a = words[j] ?? "";
    const b = FR_UNIT[words[j + 1] ?? ""];
    if (a === "dix" && b !== undefined && b >= 7) return [10 + b, 2];
    const t = FR_TEEN[a];
    return t === undefined ? null : [t, 1];
  };
  if (w === "quatre" && (next === "vingt" || next === "vingts")) {
    const t = teen(i + 2);
    if (t) return [80 + t[0], 2 + t[1]];
    const u = FR_UNIT[after];
    return u !== undefined && u > 0 ? [80 + u, 3] : [80, 2];
  }
  const tens = FR_TENS[w];
  if (tens !== undefined) {
    if (w === "soixante") {
      const t = teen(i + 1);
      if (t) return [60 + t[0], 1 + t[1]];
    }
    const u = FR_UNIT[next];
    return u !== undefined && u > 0 ? [tens + u, 2] : [tens, 1];
  }
  const t = teen(i);
  if (t) return t;
  const u = FR_UNIT[w];
  return u === undefined ? null : [u, 1];
}

/** A French run as digits: digit by digit or in pairs ("quatre huit deux un", "quarante-huit
 *  vingt et un" → "4821"), or one number with cent/mille. */
function frenchRun(words: readonly string[]): string {
  if (words.some((w) => w === "cent" || w === "cents" || w === "mille")) {
    let total = 0;
    let cur = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i] ?? "";
      if (w === "cent" || w === "cents") cur = (cur || 1) * 100;
      else if (w === "mille") {
        total += (cur || 1) * 1000;
        cur = 0;
      } else {
        const n = frenchUnder100(words, i);
        if (!n) continue;
        cur += n[0];
        i += n[1] - 1;
      }
    }
    return String(total + cur);
  }
  let out = "";
  for (let i = 0; i < words.length; ) {
    const n = frenchUnder100(words, i);
    if (!n) {
      i++;
      continue;
    }
    out += String(n[0]);
    i += n[1];
  }
  return out;
}

/** Arabic digits said in words (a leading و is "and"): "أربعة ثمانية اثنان واحد" → "4821". */
const AR_UNIT: Readonly<Record<string, number>> = {
  صفر: 0,
  واحد: 1,
  واحده: 1,
  اثنان: 2,
  اثنين: 2,
  اتنين: 2,
  ثنين: 2,
  ثلاثه: 3,
  ثلاث: 3,
  تلاته: 3,
  اربعه: 4,
  اربع: 4,
  خمسه: 5,
  خمس: 5,
  سته: 6,
  ست: 6,
  سبعه: 7,
  سبع: 7,
  ثمانيه: 8,
  ثماني: 8,
  ثمان: 8,
  تمانيه: 8,
  تسعه: 9,
  تسع: 9,
};
/** An Arabic word as the table spells it: hamza forms as ا, ة as ه. */
const arKey = (w: string): string => w.replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");
function arDigit(word: string): number | undefined {
  const k = arKey(word);
  return AR_UNIT[k] ?? (k.startsWith("و") ? AR_UNIT[k.slice(1)] : undefined);
}
const AR_WORD = String.raw`و?(?:صفر|واحد[ةه]?|[اأإ]ثن(?:ان|ين)|اتنين|ثنين|ثلاث[ةه]?|تلات[ةه]|[اأ]ربع[ةه]?|خمس[ةه]?|ست[ةه]?|سبع[ةه]?|ثماني[ةه]?|ثمان|تماني[ةه]|تسع[ةه]?)`;
/** Two Arabic digit words or more in a row. */
const AR_RUN = new RegExp(String.raw`(?<![\p{L}\p{N}])${AR_WORD}(?:(?:[^\S\n]+|[^\S\n]*[,،][^\S\n]*)${AR_WORD})+(?![\p{L}\p{N}])`, "gu");
/** "48 hundred and 21" → "4821": digits with "hundred". */
const DIGIT_HUNDRED = /(?<![\d.,])(\d{1,2})[^\S\n]+hundred(?:[^\S\n]+(?:and[^\S\n]+)?(\d{1,2}))?(?![\d.,]?\d)/gi;

/** Numbers said in words, as digits: "four eight two one" → "4821", "forty-eight twenty-one" →
 *  "4821", "four thousand eight hundred twenty-one" → "4821", "48 hundred and 21" → "4821",
 *  "double five six six" → "5566", in French from two words on ("quatre huit deux un",
 *  "trente-trois quarante-quatre" → "3344") and in Arabic from two words on. */
export function spokenToDigits(text: string): string {
  let t = text;
  if (/[\u0621-\u064a]/.test(t))
    t = t.replace(AR_RUN, (run) => {
      const digits = run
        .split(/[\s,،]+/)
        .filter(Boolean)
        .map(arDigit);
      return digits.every((d) => d !== undefined) ? digits.join("") : run;
    });
  if (/hundred/i.test(t)) t = t.replace(DIGIT_HUNDRED, (_m, a: string, b: string | undefined) => String(Number(a) * 100 + Number(b ?? 0)));
  if (HAS_FR_WORD.test(t))
    t = t.replace(FR_RUN, (run) => {
      const words = run
        .toLowerCase()
        .split(/[\s,-]+/)
        .filter((w) => w && w !== "et");
      // A lone "un", "sept" or "neuf" is a word ("un chat", "Sept 2025"), not a digit; "six six"
      // is left to the English pass.
      return words.length < 2 || words.every((w) => w === "six" || w === "zero") ? run : frenchRun(words) || run;
    });
  if (!HAS_NUM_WORD.test(t)) return t;
  return t.replace(NUM_RUN, (run) => {
    const words = run
      .toLowerCase()
      .split(/[\s,-]+/)
      .filter((w) => w && w !== "and");
    // A lone "one" or "oh" is a word ("one of them"), not a digit.
    if (words.length === 1 && /^(?:one|oh|double|triple)$/.test(words[0] ?? "")) return run;
    return numberRun(words) || run;
  });
}

// ── card numbers ───────────────────────────────────────────────────────────

/** The Luhn checksum every payment card number passes. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const DIGIT_GROUPS = /(?<![\d.-])\d+(?:[ -]\d+)*/g;

/** Card numbers in `s`: 13–19 digits starting 2–6 that pass Luhn, alone or as the first groups of
 *  a longer run ("4111 1111 1111 1111 0928"). */
export function cardNumbers(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(DIGIT_GROUPS)) {
    let digits = "";
    for (const g of m[0].matchAll(/\d+/g)) {
      digits += g[0];
      if (digits.length > 19) break;
      if (digits.length >= 13 && /^[2-6]/.test(digits) && luhn(digits)) {
        out.push(digits);
        break;
      }
    }
  }
  return out;
}

// ── token and key shapes (every kind of file, and the spoken filter) ─────────

/** Prefixed token shapes: high precision, so they also run on what Alef says. */
export const TOKEN_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9]{2,8}-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|or-v1-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // OpenAI, OpenRouter
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret and restricted keys
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g, // webhook signing secrets
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

/** A private key block (PEM, OpenSSH, PGP), header alone or whole. */
export const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,8192}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)?/g;

/** Password-manager exports and recovery documents. */
const MANAGER_MARKERS: readonly RegExp[] = [
  /\bPasswordManager\b[^\n]{0,40}\bEmergency Kit\b|\bEmergency Kit\b[^\n]{0,40}\bPasswordManager\b/i,
  /\bSecret Key\b[^\n]{0,20}\bA3-[A-Z0-9]{6}-/,
  /\bA3-[A-Z0-9]{6}-[A-Z0-9]{5,6}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/,
  /\*\*\*[0-9a-f]{8}-[0-9a-f]{4}-11dc-[0-9a-f]{4}-[0-9a-f]{12}\*\*\*/i, // 1PIF record separator
  /"encrypted"\s*:\s*false[\s\S]{0,4000}"login"\s*:\s*\{|"login"\s*:\s*\{[^{}]{0,400}"password"\s*:\s*"[^"]/, // Bitwarden JSON export
  /^\s*"?url"?\s*,\s*"?username"?\s*,\s*"?password"?\b/im, // LastPass / browser CSV export
  /^\s*"?name"?\s*,\s*"?url"?\s*,\s*"?username"?\s*,\s*"?password"?\b/im,
  /^\s*"?title"?\s*,\s*"?(?:url|website)"?\s*,\s*"?username"?\s*,\s*"?password"?\b/im,
  /<KeePassFile\b/,
];

const MANAGER_HINT = /password|keepass|emergency kit|secret key|A3-|\*\*\*[0-9a-f]{8}-/i;
const MANAGER_NAME = /\b(?:PasswordManager|Bitwarden|LastPass|KeePass(?:XC)?|Dashlane|Enpass|NordPass|Keeper|Proton Pass|iCloud Keychain)\b/i;

// ── words that name a credential ───────────────────────────────────────────

const WS = String.raw`(?<![\p{L}\p{N}])`;
const WE = String.raw`(?![\p{L}\p{N}])`;

/** Wi-Fi keys are passwords: "WPA2 key", "clé wifi", "WLAN-Schlüssel". */
const WIFI_KEY_WORDS = String.raw`(?:wpa\d?|wep|wi-?fi|wlan|network|wireless|router)[\s_-]?(?:keys?|schl[üu]ssel)|cl[ée]s?\s+(?:wi-?fi|wpa\d?|wep|wlan|r[ée]seau|de\s+s[ée]curit[ée]\s+r[ée]seau|du\s+wi-?fi)`;
/** "clave del wifi", "chiave della rete": the Spanish and Italian word for a key, only with what it
 *  opens ("palabra clave" is a keyword). A bare "Clave:" label is LABEL_ONLY_RE's. */
const CLAVE_WORDS = String.raw`(?:clave|chiave)(?:\s+(?:de|del|de\s+la|della|dello|dell['’]|di|do|da))?\s*(?:(?:la|el|il|lo|l['’])\s*)?(?:wi-?fi|wlan|red|rete|router|internet)`;
/** Shorthand, spellings and languages: "pw", "p/w", "pass phrase", "Pa$$word", "passw0rd",
 *  "wachtwoord", "palavra-passe", "şifre", "пароль", "kelmet el ser" (Lebanese Arabizi). */
const PASSWORD_WORDS = String.raw`pass(?:word|phrase|code)s?|pass\s+phrases?|pa[s$5]{2}w[o0]rds?|passwd|pwd|pw(?![.(\[])|p\/w|mdp|mots?\s+de\s+passe|app[\s-]passwords?|passw[oö]rt(?:er)?|kennw[oö]rt(?:er)?|wachtwoord(?:en)?|contrase[ñn]as?|senhas?|palavras?[\s-]passe|parol[ae]\s+d['’]ordine|[şs]ifre(?:si|m|niz)?|парол[ьяюеи]|${CLAVE_WORDS}|${WIFI_KEY_WORDS}|كلم[ةه]\s+(?:ال)?(?:سر|مرور)|(?:ال)?باسوو?رد|kelm(?:et|it)\s+(?:el\s+|al\s+)?(?:ser|sir|sirr|mourour|murur)`;
/** Chinese, Japanese and Korean words for a password: no word boundaries in those scripts. */
const CJK_PASSWORD = String.raw`密码|密碼|口令|パスワード|暗証番号|비밀번호`;
const MASTER_WORDS = String.raw`master\s+(?:codes?|passwords?|pass(?:phrase)?|keys?|pins?)`;
const RECOVERY_WORDS = String.raw`(?:recovery|backup|2fa|mfa|one[\s-]time|totp|otp)\s+(?:codes?|keys?|phrases?|secrets?|seeds?|words)|(?:seed|secret|wallet|recovery)\s+(?:phrases?|words)|mnemonic(?:\s+phrase)?`;
const TOKEN_WORDS = String.raw`(?:secret|private|api|access|signing|encryption)[\s_-]?keys?|api[\s_-]?(?:secret|token)s?|(?:auth(?:entication)?|bearer|access|refresh|personal\s+access)\s+tokens?|client\s+secrets?`;
const ACCESS_NOUNS = String.raw`door|gate|alarm|safe|entry|entrance|building|garage|lock|lockbox|key\s*box|keypad|intercom|flat|apartment|apt|house|villa|office|parking|gym|locker|mailbox|lobby|elevator|wi-?fi|bike|padlock|porte|portail|immeuble|sim|phone|card|bank|atm|debit|credit|visa|alarm\s+panel|panel|router|wlan`;
/** What a code opens, in French, Spanish, Portuguese, Italian and German: "code de la porte",
 *  "código de la puerta", "código do portão", "codice del cancello", "code alarme". */
const ML_PLACES = String.raw`bo[iî]te(?:\s+(?:aux|à|a)\s+(?:lettres|cl[ée]s))?|buz[óo]n|briefkasten|brievenbus|porte|portail|immeuble|alarme|entr[ée]e|acc[èe]s|b[aâ]timent|appartement|appart|maison|bureau|garage|coffre(?:-fort)?|cadenas|casier|interphone|v[ée]lo|parking|ascenseur|carte(?:\s+bleue)?|banque|wi-?fi|sim|puerta|port[óo]n|alarma|caja\s+fuerte|candado|edificio|acceso|entrada|oficina|tarjeta|banco|porta|port[ãa]o|cofre|cadeado|pr[ée]dio|acesso|escrit[óo]rio|cart[ãa]o|cancello|allarme|cassaforte|lucchetto|portone|citofono|accesso|ingresso|ufficio|carta|casa|t[üu]r|tor|tresor|alarmanlage`;
/** Arabic: رمز / كود (code) + what it opens, and الرقم السري (the PIN). */
const AR_ACCESS = String.raw`(?:ال)?(?:رمز|كود)\s+(?:ال)?(?:بواب[ةه]|باب|دخول|إنذار|انذار|خزن[ةه]|قفل|شق[ةه]|مبنى|عمار[ةه]|مكتب|سر|سري|مرور|واي\s?فاي)|(?:ال)?رقم\s+(?:ال)?سري`;
const ACCESS_WORDS = String.raw`(?:${ACCESS_NOUNS})\s+(?:codes?|pins?|combinations?|pass(?:word|code)s?)|digicode|(?:codes?|codice|c[óo]digos?)\s+(?:(?:de|del|della|dello|dell['’]|do|da|du|des|di|d['’])\s*(?:(?:la|le|el|il|lo|o|a|l['’])\s*)?)?(?:${ML_PLACES})|codes?\s+(?:secrets?|confidentiels?)|secret\s+codes?|code\s+pin|pin\s*(?:codes?|numbers?|#)|pin-code|puk|c[óo]digos?\s+(?:pin|secretos?)|codice\s+(?:pin|segreto)|geheimzahl|geheimnummer|zugangscode|(?:haus)?t[üu]rcode|torcode|(?:deur|poort|toegangs|kluis|door|gate|entry|lock|safe|keypad|alarm)codes?|${AR_ACCESS}`;
const CARD_WORDS = String.raw`cvv2?|cvc2?|csc|security\s+codes?|card\s+verification\s+(?:codes?|values?)`;
const CRED_WORDS = String.raw`credentials?|creds|identifiants|zugangsdaten|credenciales|credenziali|credenciais|بيانات\s+(?:ال)?دخول`;

/** Words after a credential word that make it a topic, not a credential ("password manager"). */
const TOPIC_NEXT = String.raw`\s*(?:managers?|policy|policies|reset|resets|field|fields|hint|hints|strength|rotation|protected|less|prompt|prompts|input|form|forms|box|reuse|leaks?|breach(?:es)?|spray(?:ing)?|guidelines?|requirements?|rules?|length|complexity|expiry|expiration|changes?|updates?|hash(?:es|ing)?|salt|check(?:er|s)?|generators?|vault|holder|owner|login|auth|flow|screen|page|modal|dialog|scan(?:s|ner|ning)?|storage|store|handling|support|sharing|history|gates?|gated|gating|walls?|sign-?ups?|sign-?ins?|authentication|recovery|protection)\b`;

/** A value that is itself a topic word ("the password's strength"). */
const TOPIC_WORD = new RegExp(String.raw`^${TOPIC_NEXT}$`, "i");

/** Any word that names a credential or an access code (case-insensitive; PIN is its own rule). */
const STRONG = String.raw`(?:${MASTER_WORDS}|${RECOVERY_WORDS}|${TOKEN_WORDS}|${ACCESS_WORDS}|${PASSWORD_WORDS}|${CARD_WORDS}|${CRED_WORDS})`;
const STRONG_HINT = /pass|pwd|\bpw\b|p\/w|pa[s$5]{2}w|wachtw|palavra|[şs]ifre|парол|clave|chiave|kelm[ei]t|security\s+code|[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]|mdp|master|combination|recovery|backup|2fa|mfa|otp|seed|secret|wallet|mnemonic|key|token|credential|creds|cvv|cvc|csc|digicode|code|\bcodi|\bc[óo]dig|pin|puk|passw|kennw|contrase|senha|parol|\bcl[ée]|schl[üu]ssel|geheim|zugang|identifiant|credenc|credenzi|[\u0600-\u06ff]/i;
// No leading lookbehind: irregexp can then skip ahead on the alternatives' first letters; the word
// start is checked in code (wordStart).
const STRONG_RE = new RegExp(String.raw`${STRONG}${WE}(?!${TOPIC_NEXT})|${CJK_PASSWORD}`, "giu");
const CJK_START = /^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
function wordStart(s: string, i: number): boolean {
  return i === 0 || !LETTER_OR_DIGIT.test(s.charAt(i - 1));
}
/** "PIN" in capitals, "Pin:" as a label, or a pin stated with digits ("the bank app pin is 7394",
 *  "Pin is 7394", "pin: 7394", "my pin for the office alarm panel is 2580"): never "pin it to the
 *  board", "pin 1234" (a thread id after the verb) or a CSS variable ("--tilt-pin: -1deg"). */
const PIN_RE =
  /(?<![\p{L}\p{N}])(?:PINs?|Pin(?=\s*[:=])|(?<![-_.])[Pp]ins?(?=[^\S\n]+(?:for|of|to|on|at|taba3|ta3|tab3|de|du|del|di|für|von|تبع|الخاص|حق)[^\S\n]+[^\n.:;=!?|]{1,40}?[^\S\n]\d{4,}(?![\p{L}\p{N}]))|(?<![-_.])[Pp]ins?(?=(?:[^\S\n]+(?:for|of|to|on|at|taba3|ta3|tab3|de|du|del|di|für|von|تبع|الخاص|حق)[^\S\n]+[^\n.:;=!?|]{1,40}?(?=[^\S\n]*[:=]|[^\S\n]+(?:is|was)[^\S\n]))?[^\S\n]*(?:[:=#]|-[^\S\n]|(?:is|was|number|code|no\.?)(?![\p{L}\p{N}]))[^\S\n]*["'«]?\d))(?![\p{L}\p{N}])/gu;
/** A bare "code" with an access noun within a few words ("the code to the Lisbon flat is 4821"). */
const BARE_CODE_RE = /(?<![\p{L}\p{N}])(?<!(?:claude|vs|source|qr|bar|promo|error|status|exit)[\s-])codes?(?![\p{L}\p{N}])/giu;
const ACCESS_NOUN_RE = new RegExp(String.raw`${WS}(?:${ACCESS_NOUNS})${WE}`, "iu");
/** "code" with an access noun within 30 characters of it, in the same sentence. */
function accessCodes(norm: string): Array<{ index: number; end: number }> {
  const out: Array<{ index: number; end: number }> = [];
  for (const m of norm.matchAll(BARE_CODE_RE)) {
    const before = norm.slice(Math.max(0, m.index - 36), m.index).split(/[.!?\n]/).pop() ?? "";
    const after = norm.slice(m.index + m[0].length, m.index + m[0].length + 36).split(/[.!?\n]/)[0] ?? "";
    if (ACCESS_NOUN_RE.test(before) || ACCESS_NOUN_RE.test(after)) out.push({ index: m.index, end: m.index + m[0].length });
  }
  return out;
}

const WIFI_KEY_RE = new RegExp(String.raw`^(?:${WIFI_KEY_WORDS})$`, "iu");

function reasonForWord(word: string, line: string): CredentialReason {
  const w = word.toLowerCase();
  if (/^master/.test(w)) return MANAGER_NAME.test(line) ? "password-manager" : "password";
  if (/recovery|backup|2fa|mfa|one.time|totp|otp|seed|phrase|mnemonic|wallet/.test(w)) return "recovery-code";
  if (WIFI_KEY_RE.test(w)) return "password";
  if (/^(?:codes?|codice|c[óo]digos?)\s|^secret\s+codes?$/.test(w)) return "access-code";
  if (/key|token|secret/.test(w)) return "api-token";
  if (/cvv|cvc|csc|security\s+code|card\s+verif/.test(w)) return "card-number";
  if (/^(?:pass(?:word|phrase|code)|passwd|pwd|mdp|mots?\s|passw|kennw|contrase|senha|parol|كلم|(?:ال)?باسورد)/.test(w)) return MANAGER_NAME.test(line) ? "password-manager" : "password";
  if (/code|codi|c[óo]dig|pin|combination|puk|digicode|geheim|رمز|كود|رقم/.test(w)) return "access-code";
  if (MANAGER_NAME.test(line)) return "password-manager";
  return "password";
}

// ── values ─────────────────────────────────────────────────────────────────

/** Words that describe a credential instead of being one ("the password is stored"), function
 *  words, and placeholders. A label followed by one of these states nothing. */
const STOP_WORDS = new Set(
  (
    "a an the this that these those it its is are was were be been being am of in on at to for from by with without into onto over under about as and or but so if then than not no nor yes " +
    "my your his her our their its me you him them us i we he she they who whom whose which what where when why how there here below above next previous same other another each every all any some none " +
    "stored saved kept set reset changed updated rotated required needed missing lost forgotten wrong incorrect correct right valid invalid expired expiring different unknown known secret private public safe secure insecure weak strong long short new old empty blank null unset nil undefined " +
    "attached enclosed included shared written printed encrypted hashed hidden redacted withheld elsewhere fine good okay ok compromised leaked sent managed handled disabled enabled active inactive pending temporary default optional mandatory working broken locked unlocked taped posted noted listed visible masked obvious simple easy hard complex complicated unchanged gone removed deleted revoked " +
    "also still just only really very always never probably likely done ready last first generated random unique sensitive enough free available unavailable outdated current identical similar later soon today tomorrow yesterday useless expected accepted rejected approved blocked stolen guessed shown typed entered given provided asked requested configured standard usual something anything nothing everything somewhere anywhere nowhere unclear " +
    "see use check ask call read find get go look try type enter use change rotate update reset store save keep put send share open login log sign click tap press hit rotate set via using per like such e.g eg i.e ie etc na n/a tbd todo tba ? - — – ... … * ** *** true false yes no on off " +
    "plaintext plain text cleartext clear manager managers vault notion passwordmanager bitwarden lastpass keepass dashlane keychain icloud wiki note notes file files doc docs page pages sheet table credential credentials here's there's it's that's what's " +
    "string str int integer boolean bool object array hash hashing " +
    "expire expires works worked matters fails failed remains stays stayed helps lapses applies exists differs matches " +
    "pas plus jamais rien très trop bien assez vraiment une les des que qui quoi ça cela ici là aussi encore déjà " +
    "oublié oubliée perdu perdue requis requise obligatoire incorrect incorrecte faux fausse changé changée modifié modifiée erroné erronée falsch richtig vergessen erforderlich geändert " +
    "incorrecta incorrecto olvidada olvidado obligatoria obligatorio errada errado esquecida esquecido sbagliata dimenticata obbligatoria مطلوبة مطلوب خاطئة خطأ صحيحة جديدة قديمة منسية"
  ).split(/\s+/),
);

/** Tech tokens that look secret-shaped but are names: sha256, aes256, ed25519, gpt4, http2. */
const TECH_TOKEN = /^(?:sha|aes|rsa|ecdsa|ed|x|md|base|utf|pbkdf|argon|hmac|crc|p|v|gpt|claude|opus|sonnet|haiku|fable|gemini|llama|mistral|mp|h|ipv|http|tls|ssl|oauth|win|macos|ios|es|py|python|node|ts|js|fp|int|uint|float|bf|q|w|mac|iso|rfc|cve|utc|gmt)\d+[a-z]?$/i;

function trimEdges(t: string): string {
  return t.replace(/^["'«“‘(\[<*_`]+|["'»”’)\]>.,;:!?*_`]+$/g, "");
}

/** Looks like a secret's value: a symbol mixed into letters or digits ("Xy7!abcd", "1990#"), or
 *  2+ letters and 2+ digits ("hunter22", "8f3a-22b1"). Paths, links, refs and tech names are not. */
export function isSecretShaped(raw: string): boolean {
  const t = trimEdges(raw);
  if (t.length < 4 || t.length > 128 || t.includes("/") || /->|=>|→/.test(t) || /^(?:https?:|~|www\.)/i.test(t) || /^#\d+$|^[A-Z]{2,}-\d+$/.test(t) || TECH_TOKEN.test(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(t) || /^\d{1,2}:\d{2}/.test(t) || /^v?\d+(?:\.\d+){1,3}$/.test(t)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false; // a UUID: an id (a labelled one is still caught)
  if (/^[\p{L}][\p{L}-]*[-_ ]?v?\d+(?:\.\d+)+[a-z]?$/iu.test(t) || /^[a-z]+(?:-[a-z0-9]+)+$/.test(t)) return false; // grok-4.6, claude-3-5-sonnet: names
  if (/^[$€£]?\d+(?:[.,]\d+)?[kKmMbB%]?$/.test(t) || /^[A-Z][A-Z0-9_]*=\w{0,6}$/.test(t)) return false; // $10K, MAX_TOKENS=0
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  const digits = (t.match(/\d/g) ?? []).length;
  if (/[!@#$%^&*]/.test(t.slice(1)) && digits >= 1 && (letters >= 1 || digits >= 3) && !/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return true;
  return t.length >= 6 && letters >= 2 && digits >= 2;
}

/** A unit or a context after a number that makes it a quantity, not a code. */
const UNIT_AFTER =
  /^\s*(?:%|\+|\/\s*(?:day|week|month|year|yr|h|hr|hour|min|mo|s|sec|user|seat)\b|maus?\b|daus?\b|views?\b|keys?\b|checks?\b|rules?\b|gates?\b|kpa|mpa|psi\b|bar\b|atm\b|hz\b|khz|mhz|ghz|mbps|gbps|kbps|kwh|kw\b|mah\b|conversations?|tickets?|contacts?|customers?|visitors?|events?|dollars?|euros?|aed\b|deals?\b|combinations?|browsers?|devices?|px|ms|µs|ns|s\b|secs?\b|seconds?|mins?\b|minutes?|h\b|hrs?\b|hours?|days?|weeks?|months?|years?|yrs?|k\b|m\b|mb|gb|kb|tb|chars?|characters?|digits?|letters?|words?|tokens?|files?|lines?|sessions?|times?|x\b|usd|eur|lbp|people|users?|notes?|items?|entries|rows?|bytes?|bits?|rounds?|iterations?|attempts?|tries|steps?|pages?|km|mi\b|ft\b|cm|mm|kg|lbs?\b|°|requests?|calls?|credits?|req|rpm|tpm|rps|qps|per\b|stars?|forks?|downloads?|installs?|subscribers?|followers?|views?|visits?|clicks?|leads?|signups?|companies|firms?|countries|documents?|docs?|prompts?|questions?|chunks?|skills?|hooks?|agents?|repos?|commits?|prs?\b|issues?|tests?|bugs?|features?|records?|accounts?|emails?|messages?|members?|seats?|licen[cs]es?)/i;
/** Context before a number that makes it a reference, a port, a price or a version. */
const REF_BEFORE = /(?:#|\$|€|£|\bv|\bports?\s*(?:\d+\s*(?:,|and|or|&)\s*)*|[\p{L}\p{N}]:|\bPR\s*|\bissue\s*|\b[A-Z]{2,}-|\bstep\s*|\bpage\s*|\bline\s*|\bround\s*|\bphase\s*|\bversion\s*|\bchapter\s*|\bsection\s*|\bart(?:icle|icolo|ículo|iculo|igo|ikel)?\.?\s*|\bnumber\s+of\s*|\broom\s*|\bflight\s*|\bbus\s*|\broute\s*)$/iu;

interface WindowValue {
  value: string;
}

/** Values in a window of text next to a credential word: 3+ digit runs (not a date, time,
 *  version, reference, quantity, or a year unless `labelEnd` puts it right after the label),
 *  3+ small digit groups in a row ("4, then 8, then 2, then 1", "12-34-56"), "starts with 48",
 *  secret-shaped tokens and card numbers. */
function windowValues(w: string, labelEnd: number | null): WindowValue[] {
  const out: WindowValue[] = [];
  for (const m of w.matchAll(/(?<![\p{L}\p{N}_])\d{4,}(?![\p{L}\p{N}_])/gu)) {
    const before = w.slice(Math.max(0, m.index - 20), m.index);
    const after = w.slice(m.index + m[0].length);
    if (/\d[-/.:]$/.test(before) || /^[-/.:]\d/.test(after)) continue; // a date, a time, a version
    if (REF_BEFORE.test(before) || UNIT_AFTER.test(after)) continue;
    if (/^(?:19|20)\d\d$/.test(m[0]) && !(labelEnd !== null && m.index >= labelEnd && /^[^\S\n]*(?:[:=#]|is|was)?[^\S\n]*["'«]?$/i.test(w.slice(labelEnd, m.index)))) continue;
    out.push({ value: m[0] });
  }
  for (const m of w.matchAll(/(?<![\p{L}\p{N}.:/-])\d{1,2}(?![\p{L}\p{N}])(?:[^\S\n]*(?:,|;|-|–|—|\/|\.|\bthen\b|\band\b|\bfollowed\s+by\b)?[^\S\n]*(?:then[^\S\n]+)?\d{1,2}(?![\p{L}\p{N}])){2,}(?![-/.:]\d)/gu)) {
    if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(m[0]) && /\b(?:on|in|since|until|from|dated?)\s*$/i.test(w.slice(0, m.index))) continue; // a date
    out.push({ value: m[0].replace(/\D+/g, "") });
  }
  for (const m of w.matchAll(/\b(?:starts?|begins?|ends?|finish(?:es)?)\s+(?:with|in|on)\s+(?:an?\s+)?["'«]?([\p{L}\p{N}!@#$%^&*+=-]+)/giu)) out.push({ value: m[1] ?? "" });
  for (const m of w.matchAll(/\b(?:first|last)\s+(?:\w+\s+)?(?:digits?|numbers?|letters?|characters?)\s+(?:are|is|:)?\s*["'«]?([\p{L}\p{N}!@#$%^&*+=-]+)/giu)) out.push({ value: m[1] ?? "" });
  // Hex ids (commit SHAs, account and Notion ids) sit next to credential words all the time; a
  // labelled one ("API key: 3f2a…") is still caught by the label rule.
  for (const t of w.split(/\s+/)) if (isSecretShaped(t) && !/^[0-9a-f]{7,}$/.test(trimEdges(t))) out.push({ value: trimEdges(t) });
  for (const c of cardNumbers(w)) out.push({ value: c });
  return out.filter((v) => v.value.length >= 2);
}

const PLACEHOLDER_TEXT = /withheld|redacted|placeholder|example|changeme|change[_-]?me|your[-_]|<[^>]*>|\.{3}|…|^x{3,}|^[xX*._-]{4,}$/i;

/** A value after a colon: an everyday word may be one ("correct horse battery staple"), but not
 *  a pointer, a placeholder, a ratio or a tiny number. */
function colonValue(raw: string): string | null {
  const t = trimEdges(raw);
  if (t.length < 3 || t.length > 64 || LABEL_STOP.has(t.toLowerCase()) || PLACEHOLDER_TEXT.test(t) || PLACEHOLDER_TEXT.test(raw) || /[-_]$/.test(t) || /^\d+\/\d+$/.test(t) || /^[^\p{L}\p{N}]+$/u.test(t)) return null;
  if (/^(?:https?:|~\/|\/)/i.test(t)) return null;
  return t;
}

/** A plain word that can be a value (not a stop word, a placeholder or markup). */
function plainValue(raw: string): string | null {
  const t = trimEdges(raw);
  if (t.length < 3 || t.length > 64) return null;
  if (STOP_WORDS.has(t.toLowerCase()) || /^[^\p{L}\p{N}]+$/u.test(t) || /^\[.*\]$/.test(t) || PLACEHOLDER_TEXT.test(t) || /^\d+\/\d+$/.test(t)) return null;
  if (/^(?:https?:|~\/|\/)/i.test(t) || /^[\p{L}]+\.(?:md|txt|json|pdf|com|ai|io|dev)$/iu.test(t)) return null;
  return t;
}

// ── the prose rules ─────────────────────────────────────────────────────────

/** A label then its value: "password: purplewalrus", "PIN - 4821", "the gym password is purplewalrus",
 *  "la password è …", "كلمة المرور هي …", "the password is now …". */
const LABEL_AFTER =
  /^(?:[^\S\n]+(?:for|of|to|on|at|in|de|du|des|pour|à|del|della|do|da|di|für|fur|von|zum|zur|para|per|taba3|ta3|tab3|el|تبع|الخاص|الخاصة|حق)[^\S\n]+[^\n.:;=!?|]{1,40}?)?[^\S\n]*(?:\*\*|__)?[^\S\n]*([:=→]+|->|>>+|=>|\?(?=[^\S\n])|[^\S\n]*,?[^\S\n]*c['’]est(?=[^\S\n])|是|为|[^\S\n]+(?:is|was|are|est|était|ist|war|es|era|é|è|هو|هي|lautet|lautete|=|-|–|—|→|->)[^\S\n]|[^\S\n]*\((?:is|:)\))[^\S\n]*(?:\*\*|__)?[^\S\n]*(?:(?:now|still|currently|simply|just|actually|maintenant|toujours|jetzt|ahora|agora|ora|it['’]s|that['’]s|c['’]est)[^\S\n]+)?(?:(?:le|la|el|il|lo|the)[^\S\n]+(?=[^\s,;]*\d))?["'«“‘`]?([^\s"'»”’`|,;]+)/iu;
/** "the password's X": a contraction of "is", right after the word. */
const APOS_S = /^['’]s[^\S\n]+(?:(?:now|still|just)[^\S\n]+)?["'«“‘`]?([^\s"'»”’`|,;]+)/u;
/** Digit groups that continue a value: "33 44", "48-21", "12 34 56" (never a date). */
const MORE_GROUPS = /^(?:(?:[^\S\n]*[-–—][^\S\n]*|[^\S\n]+)\d{1,4}(?![\p{L}\p{N}]|[-/.:]\d))+/u;
const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;
/** A value that is 1–4 digits (or groups of them) joined with the groups after it: "33" + " 44" →
 *  "3344". Anything else comes back as it was. */
function joinDigitGroups(raw: string, rest: string): string {
  if (!/^\d{1,4}(?:[-–—]\d{1,4})*$/.test(raw) || DATE_LIKE.test(raw)) return raw;
  const more = MORE_GROUPS.exec(rest)?.[0] ?? "";
  if (more && UNIT_AFTER.test(rest.slice(more.length))) return raw;
  const joined = (raw + more).replace(/\D+/g, "");
  return joined.length >= 4 ? joined : raw;
}
/** "to" as a separator: "the password (was just) set to X", or after a change verb earlier in the
 *  clause ("I changed the gym password to X"). */
const TO_VALUE = /^[^\S\n]+(?:(?:is|was|has[^\S\n]+been|got|gets)[^\S\n]+)?(?:(?:now|just)[^\S\n]+)?((?:set|changed|updated|reset|switched|moved|rotated)[^\S\n]+)?to[^\S\n]+["'«“‘`]?([^\s"'»”’`|,;]+)/iu;
const CHANGE_BEFORE = /(?<![\p{L}\p{N}])(?:chang(?:e|ed|es|ing)|set|reset|updat(?:e|ed|es|ing)|switch(?:ed|es|ing)?|rotat(?:e|ed|es|ing)|mov(?:e|ed|es|ing))(?![\p{L}\p{N}])[^.;!?\n]{0,40}$/iu;
/** What may end the clause after a "to" value: punctuation, the line end, or a time or a new clause. */
const TO_END = /^["'»”’`]?[^\S\n]*(?:[.,;!?)]|$|(?:last|this|yesterday|today|tonight|on|in|at|since|earlier|again|recently|before|after|when|because|but|and|so)(?![\p{L}\p{N}]))/iu;
/** Words that name credentials in general or a command: never labels for a value with no separator
 *  or in parentheses ("Application Default Credentials (ADC)", "sudo passwd ubuntu"). */
const NAMES_A_TOPIC = /^(?:credentials?|creds|identifiants|zugangsdaten|credenciales|credenziali|credenciais|بيانات)|^(?:passwd|pwd)$/i;
/** The labels a value may follow with no separator at all ("Home Wi-Fi password purplewalrus"). */
const BARE_LABEL = /pass|pw|p\/w|pa[s$5]{2}w|mots?\s+de\s+passe|passw[oö]rt|kennw|wachtw|contrase|senha|palavra|parol|[şs]ifre|парол|wpa|wep|wlan|wi-?fi|cl[ée]|clave|chiave|كلم|باسو?و?رد/i;
/** A qualifier that describes the password instead of naming what it opens ("Optional password
 *  protection", "Secure password storage"). */
const ADJECTIVE_PREFIX = /(?<![\p{L}\p{N}])(?:optional|secure|strong|weak|default|temporary|temp|random|custom|better|simple|basic|plain|encrypted|hashed|required|current|safe|unique|complex|long|short|initial|generated|generic|shared|stored|saved|forgotten|lost|reset|change|changed|update|auto|automatic|manual|local|remote|valid|invalid|wrong|correct|good|bad|single|same|different|separate|dedicated|proper|real|fake|dummy|test|sample|example|demo|hidden|visible|masked|stronger|weaker|one-time|forgot|forgotten|no|without|with|and|or|via|for|new|old|in|on|at|by|from|into|of|to|per|under|over|about|like|as|if|when|then|use|using|enter|type|choose|pick|set)(?![\p{L}\p{N}])/iu;
/** Word endings of ordinary English nouns and verbs ("hashing", "validation", "management"): a
 *  bare value that ends so is prose unless it is secret-shaped. */
const WORDY_SUFFIX = /(?:tion|sion|ment|ing|ness|ity|ance|ence|ed|ies|ize|ise|able|ible|ure|ship|ism|ist|ery|ory|ous|ive|ful|less|ly|er|or|al|ic)$/i;
/** A value in parentheses right after the label: "Gym password (purplewalrus)". */
const PAREN_VALUE = /^[^\S\n]*\([^\S\n]*["'«“‘`]?([^\s()"'»”’`|,;]{3,64}?)["'»”’`]?[^\S\n]*\)/u;
/** A value with no separator at all, alone at the end of its clause: "Home Wi-Fi password purplewalrus". */
const BARE_VALUE = /^[^\S\n]+["'«“‘`]?([^\s"'»”’`|,;:()]{3,64}?)["'»”’`]?[^\S\n]*(?:[,;]|[.!?](?=\s|$)|$)/u;
/** What may stand before such a bare label: up to three words from the line start ("Home Wi-Fi"),
 *  never an article or a possessive ("My password expires" is a sentence, not a label). */
const LABEL_PREFIX = /^[\s>*•-]*(?:\*\*|__)?(?:[\p{L}\p{N}'’&.,-]+[^\S\n]+){0,3}$/u;
const DETERMINER = /(?<![\p{L}\p{N}])(?:the|my|your|our|his|her|their|this|that|its|a|an|no|any|which|what|whose|le|la|les|mon|ma|mes|ton|ta|son|sa|votre|notre|el|mi|tu|su|der|die|das|mein|meine|dein|sein|ihr)(?![\p{L}\p{N}])/iu;
/** Digits right after an access-code word, no separator needed: "Gate code 33 44", "Digicode 4821B",
 *  "رمز البوابة 3344". */
const BARE_DIGITS = /^[^\S\n]*(?:#|n°|no\.?|nr\.?|number|num[ée]ro)?[^\S\n]*["'«]?([A-Za-z]?\d{2,}(?:(?:[^\S\n]*[-–—][^\S\n]*|[^\S\n]+)\d{2,})*[A-Za-z]?)(?![\p{L}\p{N}]|[-/.:]\d)/u;
/** After a colon, a value may be an everyday word ("master code: correct horse battery staple"):
 *  only pointers and placeholders state nothing there. */
const LABEL_STOP = new Set(
  "a an the this that my your his her our their in on at to from via see ask check use stored saved kept managed shared in: none nil null n/a na tbd tba todo same redacted withheld hidden masked unknown missing required optional set unset empty blank true false yes no ? - — – ... … * ** *** credential credentials manager passwordmanager bitwarden lastpass keepass dashlane keychain vault notion below above attached".split(" "),
);
/** A word that is a credential label only right before its colon: "wifi: SunnyDay", "pass: hunter",
 *  "pw: hunter22", "secret: sesame", "combination: 12-34-56"; "login:" needs a secret-shaped value. */
const LABEL_ONLY_RE = /^[^\S\n]*(?:[-*•>]|\d+[.)])?[^\S\n]*(?:\*\*|__)?(wi-?fi|pass|pw|p\/w|mdp|secrets?|login|combination|combo|clave|chiave)(?:\*\*|__)?[^\S\n]*[:=][^\S\n]*(?:\*\*|__)?["'«`]?([^\s"'»`|,;*]+)/gimu;
/** "punch in 4821 at the door", "key 4 8 2 1 into the keypad". */
const ACCESS_VERB_RE = /(?<![\p{L}\p{N}])(?:punch|key|tap|dial|enter|type|taper|tapez|composer|composez|saisir|marcar|teclear|digitare|eingeben|intoetsen)(?:\s+in)?[^\S\n]+(?:(?:the|these|this|its|digits?|numbers?|code)[^\S\n]+){0,3}(\d{3,}|\d{1,2}(?:[^\S\n]*(?:,|-|then|and)?[^\S\n]*\d{1,2}){2,})(?!\d)/giu;
/** Access points in other languages ("Alarme : 5566", "Coffre-fort : 5566", "Cadenas du vélo : 4821"). */
const ML_ACCESS_NOUNS = String.raw`alarme|coffre(?:-fort)?|cadenas|casier|interphone|t[üu]r|haust[üu]r|tor|tresor|alarmanlage|puerta|port[óo]n|alarma|caja\s+fuerte|candado|porta|port[ãa]o|cofre|cadeado|cancello|allarme|cassaforte|lucchetto|portone|citofono|(?:ال)?(?:باب|بواب[ةه]|إنذار|انذار|خزن[ةه]|قفل)`;
const ACCESS_PLACE_ASCII = /\b(?:door|gate|flat|apartment|house|villa|building|lobby|entrance|keypad|intercom|lock|garage|alarm|digicode|portail|porte|immeuble|safe|locker|alarme|coffre|cadenas|casier|interphone|tor|tresor|alarmanlage|puerta|alarma|candado|porta|cofre|cadeado|cancello|allarme|cassaforte|lucchetto|portone|citofono)\b/i;
const ACCESS_PLACE_ML = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${ML_ACCESS_NOUNS})(?![\p{L}\p{N}])`, "iu");
/** A line that names an access point (the ASCII check first: it is several times faster). */
const ACCESS_PLACE = { test: (s: string): boolean => ACCESS_PLACE_ASCII.test(s) || (/[^\x00-\x7f]/.test(s) && ACCESS_PLACE_ML.test(s)) };
/** Reverse order: "purplewalrus is the gym password", "hunter22 was my old PIN". */
const REVERSE_RE = new RegExp(
  String.raw`(?:^|[\s("'“‘*_>|-])([^\s"'”’()|*,]{3,64})["'”’]?(?:[^\S\n]+(?:is|was|=|are)|[^\S\n]*[,—–-][^\S\n]*(?:that['’]s|that\s+is|it['’]s|this\s+is|c['’]est))[^\S\n]+(?:(?:the|my|our|your|his|her|their|a|an|old|new|current)[^\S\n]+){0,2}(?:(?!(?:for|of|to|in|on|at|with|about|from|by|and|or)[^\p{L}])[\p{L}'’-]+[^\S\n]+){0,3}?(?:${MASTER_WORDS}|${ACCESS_WORDS}|${PASSWORD_WORDS}|PIN)${WE}(?!${TOPIC_NEXT})`,
  "giu",
);
/** An access point's label and its digits: "Gate 3344", "Alarm: 5566", "the alarm is 5566", "Gate: 1990#",
 *  "Gate 33 44", "Digicode 4821B", "Cadenas du vélo : 4821", "Coffre-fort : 5566". */
const ACCESS_LABEL_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:door|gate|alarm|safe|garage|lockbox|key\s*box|keypad|intercom|digicode|portail|porte|padlock|locker|${ML_ACCESS_NOUNS})(?![\p{L}\p{N}])(?:[^\S\n]+(?:du|de|des|of|for|del|della|do|da|di|von)[^\S\n]+[\p{L}'’-]+(?:[^\S\n]+[\p{L}'’-]+)?)?(?:\s+(?:codes?|pins?))?(?:[^\S\n]*[:=#]|[^\S\n]+(?:is|was|est|ist|es|é|è|code|pin)(?:[^\S\n]+is)?)?[^\S\n]*["'«]?(\d[\d#*]{2,}[A-Za-z]?|\d{1,2}(?:[^\S\n]*(?:,|-|then|and)[^\S\n]*\d{1,2}){2,}|\d{2}(?:[^\S\n]*-[^\S\n]*\d{2}|[^\S\n]+\d{2})+)(?![\p{L}\p{N}]|[-/.:]\d)`,
  "giu",
);
/** A bare "code" stated with 4+ digits ("code: 4821", "the code is 4821"): not source, postal,
 *  error or promo codes. */
const CODE_DIGITS_RE =
  /(?<!\b(?:claude|vs|source|zip|postal|post|area|country|dial(?:ling)?|qr|bar|error|exit|status|http|return|promo|discount|coupon|cheat|morse|dress|machine|byte|op|sample|example|test|legacy|native|production|client|server|shared|app|dead|clean|pseudo|reference|ref|product|sku|tracking|confirmation|booking|verification|otp|sms|swift|iban|bic|sort|routing|tax|vat|naf|siren|siret|zipcode|hs|cpt|icd)[\s-]+)(?<![\p{L}\p{N}/?&=])(?:codes?|codice|c[óo]digos?|(?:ال)?(?:رمز|كود))(?:[^\S\n]*[:=#]|[^\S\n]+(?:is|was|è|é|es|est|ist|هو))?[^\S\n]*["'«]?(\d{4,})(?!\d|[-/.:]\d)/giu;
const CVV_RE = /(?<![\p{L}\p{N}])(?:cvv2?|cvc2?|csc)[^\S\n]*[:=#]?[^\S\n]*(\d{3,4})(?!\d)/giu;

/** A value in parentheses AFTER it names it: "- **Gym**: purplewalrus _(password)_". */
const PAREN_AFTER_RE = new RegExp(
  String.raw`(?:^|[\s("'“‘*_>|:-])([^\s"'”’()|*,:]{3,64})["'”’*_]*[^\S\n]*[_*]*\([^\S\n]*(?:the[^\S\n]+)?(?:${PASSWORD_WORDS}|PIN|pin|codes?|combo|combination)[^\S\n]*\)`,
  "giu",
);
/** A colon however far along the clause after a credential word: "Password for the NAS box that sits
 *  in the cupboard under the stairs next to the router: X", "mdp gmail : X", "كلمة سر الواي فاي: X",
 *  "WLAN Passwort lautet: X". Group 1: the words in between; group 2: the value. */
const CLAUSE_COLON = /^((?:[^\n.;!?\\]|\.(?![\s\\]|$)){0,140}?)(?:[:=]+|>>+|=>)(?!\/\/)[^\S\n]*(?:\*\*|__)?[^\S\n]*["'«“‘`]?([^\s"'»”’`|,;]+)/u;
/** A clause-colon gap that opened a parenthesis it did not close: the colon belongs inside it. */
const OPEN_PAREN = (gap: string): boolean => (gap.match(/\(/g) ?? []).length > (gap.match(/\)/g) ?? []).length;
/** A value that is code, not a secret: "useState(", "{a}", "<b>". */
const CODE_CHARS = /[(){}[\]<>]/;
/** "is" a few words after a credential word: "the password I use for everything is X", "كلمة السر
 *  الخاصة بالواي فاي هي X" (never across another "is" or an "and"). */
const WORD_SEP_GAP =
  /^((?:[^\S\n]+(?!(?:is|was|are|est|ist|es|è|é|lautet|هو|هي|and|or|but|so|then|et|und|y|ou|o|و)(?![\p{L}\p{N}]))[^\s.:;=!?|,()"]+){1,6}?)[^\S\n]+(?:is|was|est|ist|es|è|é|lautet|هو|هي)[^\S\n]+(?:(?:now|still|currently|just)[^\S\n]+)?["'«“‘`]?([^\s"'»”’`|,;]+)/iu;
/** A Latin-script word inside Arabic text after a credential word is its value ("باسوورد الواي فاي
 *  purplewalrus"), unless it names what the password is for. */
const LATIN_IN_ARABIC = /(?<![\p{L}\p{N}])[A-Za-z0-9][\x21-\x7e]{2,63}/gu;
const LATIN_LABEL = /^(?:wi-?fi|wlan|ssid|router|nas|pin|code|gmail|g-?mail|email|e-mail|icloud|wpa\d?|iphone|netflix)$/i;
/** "pass" on a line about an account or a network: "wifi pass: X", "User: steph  Pass: X". */
const PASS_WORD_RE = /(?<![\p{L}\p{N}])(?:pass|key)(?![\p{L}\p{N}])/giu;
const PASS_CONTEXT = /(?<![\p{L}\p{N}_])(?:wi-?fi|wlan|ssid|user(?:name)?|login|nas|router|admin|account|e-?mail|gmail|icloud)(?![\p{L}\p{N}_])/iu;
/** Right before "pass": what it opens ("wifi pass", "email pass", "Wifi HomeNet, pass"). */
const PASS_BEFORE = /(?<![\p{L}\p{N}])(?:wi-?fi|wlan|ssid|nas|router|admin|e-?mail|gmail|icloud|account|user(?:name)?|login)(?:[^\S\n]+[\p{L}\p{N}-]+,)?[^\S\n]*$/iu;
/** "The Wi-Fi is X", "Remember the wifi — it's X", "Wifi HomeNet / X". */
const WIFI_RE = /(?<![\p{L}\p{N}])(?:wi-?fi|wlan)(?![\p{L}\p{N}])/giu;
const WIFI_IS = /^[^\S\n]+(?:is|=)[^\S\n]+(?:(?:still|now|just)[^\S\n]+)?["'«“‘`]?([^\s"'»”’`|,;]+)/iu;
const WIFI_DASH = /^[^\S\n]*[—–-][^\S\n]*(?:it['’]s|that['’]s|c['’]est)[^\S\n]+["'«“‘`]?([^\s"'»”’`|,;]+)/iu;
const WIFI_PAIR = /^[^\S\n]+["'«“‘`]?([^\s"'»”’`|,;/]{2,40})["'»”’`]?[^\S\n]*\/[^\S\n]*["'«“‘`]?([^\s"'»”’`|,;/]{3,64})/u;
/** How people describe a network rather than name its password: "The Wi-Fi is down". */
const WIFI_STATE = new Set(
  "down up slow fast flaky spotty patchy unstable stable great good bad terrible awful weak strong free included available unavailable working broken dead back out off on fine excellent decent reliable unreliable solid poor amazing horrible shaky intermittent fixed sorted open public private secured protected called named hidden gone better worse faster slower fibre fiber shared separate different same new old there here everywhere".split(" "),
);
/** Things a code opens, or opening one, in any language: a code-shaped number within 40 characters
 *  of one, in the same clause, is its code ("Buzzer: 4821", "4821 opens the front door", "The gate
 *  opens with 3344", "Alarm disarm: 2580", "Storage unit combo: 19-27-04", "code el bineye: 4821"). */
const ACCESS_NEAR_WORDS = String.raw`doors?|gates?|lobby|entrances?|mailbox(?:es)?|letterbox(?:es)?|alarms?|disarm|keypads?|lockbox(?:es)?|key\s*box(?:es)?|key\s*safes?|padlocks?|locks?(?![^\S\n]*(?:files?|screens?|steps?|free|contention|ins?\b|outs?\b))|combos?|combinations?|buzzers?|buzz|unlock|safes?|lockers?|(?<!\d[^\S\n]?)atm|digicodes?|portes?|portails?|entr[ée]e|bo[iî]tes?\s+(?:[àa]\s+cl[ée]s?|aux\s+lettres)|cadenas|coffres?(?:-forts?)?|casiers?|interphones?|alarmes?|puertas?|port[óo]n|candados?|caja\s+fuerte|alarmas?|portero|cancell[oi]|lucchett[oi]|cassaforte|citofono|allarmi?|allarme|portone|t[üu]r(?:en)?|haust[üu]r|schloss|tresor|alarmanlage|deur(?:en)?|voordeur|poort|kluis|port[ãa]o|cadeados?|cofres?|interfone|bab|bawwab[ea]h?|bin[ae]y[ea]h?|2efel|qefel`;
const ACCESS_NEAR_RE = new RegExp(
  String.raw`(?:${ACCESS_NEAR_WORDS})(?![\p{L}\p{N}_]|[-./][\p{L}\p{N}])|(?:[وفبلك]|لل|ال|بال|وال|فال|كال)?(?:بواب[ةه]|قفل|خزن[ةه]|[إا]نذار|بناي[ةه]|مبنى|عمار[ةه]|شق[ةه])(?![\p{L}\p{N}])|(?:[وفبلك]|لل)(?:ال)?باب(?![\p{L}\p{N}])`,
  "giu",
);
const ACCESS_NEAR_HINT = /lobby|entrance|mailbox|letterbox|door|gate|alarm|disarm|keypad|lock|key\s*box|key\s*safe|combo|combination|buzz|intercom|unlock|safe|atm|digicode|porte|portail|entr[ée]e|bo[iî]te|cadenas|coffre|casier|interphone|puerta|port[óo]n|candado|caja|portero|cancell|lucchett|cassaforte|citofono|allarm|portone|t[üu]r|schloss|tresor|deur|poort|kluis|port[ãa]o|cadeado|cofre|interfone|bab|bawwab|bin[ae]y|2efel|qefel|[\u0600-\u06ff]/i;
/** A number said as a time after "at", "for", "until"…: "Alarm at 0630". */
const TIME_BEFORE = /\b(?:at|for|until|till|by|from|to|before|after|around|à|vers|um|bis|alle|a\s+las)\s*$/i;
/** A login then user and password, joined by ":" or a password word: "Router login → admin : X",
 *  "account: steph@mail.com pw X". */
const LOGIN_PAIR_RE = /(?<![\p{L}\p{N}])(?:logins?|user(?:name)?|accounts?|acct|creds|credentials)(?![\p{L}\p{N}_])[^\S\n]*(?:[:=→-]|->)?[^\S\n]*([\w.@%+-]{2,64})[^\S\n]*(?::|\bpw\b|\bpwd\b|\bpass\b|\bpassword\b)[^\S\n]*[:=]?[^\S\n]*["'«`]?([^\s"'»`|,;]{3,64})/giu;
/** On a line that names a password manager, its code or key however it is labelled: "With PasswordManager,
 *  you get access to everything - code: ***…***", "Bitwarden key: …". Group 1: the value; group 2:
 *  the rest of an emphasised span ("***word, word***"). */
const MANAGER_LABEL_RE = /(?<![\p{L}\p{N}])(?<!(?:claude|vs|source|qr|bar|promo|error|status|exit)[\s-])(?:codes?|keys?|secret(?:\s+key)?|master|pass|pw|pwd|mdp|pin|cl[ée]f?|code\s+secret|mot\s+de\s+passe)[^\S\n]*[:=][^\S\n]*([*_`"'«“]*)([^\s*_`"'»”,;|]{3,64})((?:[^*_`\n]{0,80}?)(?=\1))?/giu;
/** A value that is itself a credential word ("Proton Pass — Password manager"). */
const CRED_WORD_VALUE = new RegExp(`^(?:${PASSWORD_WORDS}|${TOKEN_WORDS})$`, "iu");
/** "<Service> pass = X" as a label at the line start: only a secret-shaped value ("First pass:
 *  extract" is a step). */
const WEAK_PASS_RE = /^[^\S\n]*(?:[-*•>]|\d+[.)])?[^\S\n]*(?:[\p{L}\p{N}+&.'’-]+[^\S\n]+){1,3}pass[^\S\n]*[:=][^\S\n]*["'«`]?([^\s"'»`|,;*]+)/iu;
/** "Netflix: user@mail.com / sesame42", "NAS login: steph / Xy7!abcd", "Credentials: admin / sesame". */
const USER_PAIR_RE = /:[^\S\n]*((?:[\w.%+-]{2,}@[\w.-]+\.\w+)|[\p{L}\p{N}][\w.%+-]{1,})(?:[^\S\n]+\/[^\S\n]*|\/[^\S\n]+)([^\s|/]{3,})/gu;
/** The label before a pair's colon: up to 32 characters of words, after any punctuation. */
function pairLabel(before: string): string {
  const m = /([\p{L}][\p{L}\p{N}&'. -]{0,30})[^\S\n]*$/u.exec(before.slice(-34));
  return m?.[1] ?? "";
}
const CARD_CONTEXT = /\b(?:card|visa|mastercard|master\s*card|amex|american\s+express|maestro|carte|expiry|expires|valid\s+thru|cvv|cvc)\b/i;
/** A .env / shell / config line: SECRET_NAME=value. */
const ENV_LINE = /^[^\S\n]*(?:export[^\S\n]+|set[^\S\n]+|ENV[^\S\n]+|ARG[^\S\n]+)?["']?([A-Za-z_][\w.-]*)["']?[^\S\n]*(=|:(?!:))[^\S\n]*(.*)$/;
const SECRET_KEY_NAME = /(?:^|[_.-])(?:pass(?:word|wd|phrase|code)?|pwd|secret|secrets|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credentials?|signing[_-]?key|encryption[_-]?key|webhook[_-]?secret|db[_-]?pass|dsn|database[_-]?url|connection[_-]?string|master[_-]?key)(?:$|[_.-])/i;
const PLACEHOLDER_VALUE =
  /^(?:|["']{2}|<[^>]*>|\$\{?[\w.:-]+\}?|\{\{.*\}\}|%\w+%|x{3,}|\*+|\.{2,}|…|-+|null|none|nil|undefined|true|false|yes|no|required|optional|todo|tbd|string|str|int|number|boolean|bool|any|unknown|redacted|\[[^\]]*\]|\([^)]*\))$|your[\w-]*|example|changeme|change[_-]me|placeholder|dummy|<[^>]+>|\$\{|\{\{|process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv\(|env\(|secrets\.|ENV\[|config\.|settings\.|Deno\.env|System\.getenv|vault:|op:\/\/|ssm:|arn:aws:secretsmanager/i;
const CODE_REF_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\]|\(\))+[;,)]*$/;
/** A quoted literal assigned to a secret-named key in code: `password: "Xy7!abcd"`, `API_KEY = "…"`. */
const CODE_LITERAL_RE = /["']?([\w$.-]{2,60})["'\]]?[^\S\n]*(?:[:=]|=>|:=|\?\?=)[^\S\n]*(?:[rbfu]|new\s+String\()?["'`]([^"'`\s\\]{4,200})["'`]/g;
const UI_VALUE = /^(?:[A-Z][a-z]+|[a-z]+(?:-[a-z]+)*|text|password|email|hidden|number|tel|off|on|new-password|current-password|one-time-code|username|bearer|basic|oauth2?|jwt|hs256|rs256|es256|sha256|utf-?8|base64|hex|ascii|latin1|json|string|object)$/;

export interface ScanResult {
  reasons: CredentialReason[];
  /** The values found (only with collectValues): kept in memory for the spoken filter, never
   *  persisted or logged. */
  values: string[];
}

/** One rule firing, for tuning (see scanText's onHit): the rule id and the value it saw. */
export interface ScanHit {
  rule: string;
  reason: CredentialReason;
  value: string;
  line: number;
}

class Hits {
  readonly reasons = new Set<CredentialReason>();
  readonly values = new Set<string>();
  rule = "";
  line = 0;
  constructor(
    readonly collect: boolean,
    readonly onHit?: (h: ScanHit) => void,
  ) {}
  add(reason: CredentialReason, ...values: string[]): void {
    this.reasons.add(reason);
    if (this.onHit) for (const v of values.length ? values : [""]) this.onHit({ rule: this.rule, reason, value: v, line: this.line });
    if (!this.collect) return;
    for (const v of values) {
      const t = trimEdges(v.trim());
      if (t.length >= 3) this.values.add(t);
    }
  }
  /** Stop early: without values the first reason of each class is enough. */
  get done(): boolean {
    return !this.collect && this.reasons.size >= 3;
  }
}

const SHAPE_HINT = /sk-|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|ASIA|AIza|glpat-|npm_|hf_|_live_|_test_|whsec_|SG\.|eyJ/;

function scanShapes(text: string, h: Hits): void {
  h.rule = "token-shape";
  if (SHAPE_HINT.test(text)) for (const re of TOKEN_SHAPES) for (const m of text.matchAll(re)) h.add("api-token", m[0]);
  h.rule = "private-key";
  for (const m of text.matchAll(PRIVATE_KEY)) h.add("private-key", m[0]);
  h.rule = "manager-marker";
  if (MANAGER_HINT.test(text) && MANAGER_MARKERS.some((re) => re.test(text))) h.add("password-manager");
}

function secretKeyName(name: string): boolean {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const has = (w: string): boolean => parts.includes(w);
  const pair = (a: string, b: string): boolean => parts.some((p, i) => p === a && parts[i + 1] === b);
  return (
    ["password", "passwd", "passphrase", "passcode", "pass", "pwd", "secret", "secrets", "credential", "credentials", "token", "apikey", "dsn", "privatekey", "accesskey", "clientsecret", "authtoken"].some(has) ||
    pair("api", "key") ||
    pair("private", "key") ||
    pair("access", "key") ||
    pair("secret", "key") ||
    pair("signing", "key") ||
    pair("encryption", "key") ||
    pair("master", "key") ||
    pair("database", "url") ||
    pair("connection", "string")
  );
}

function isPlaceholder(v: string): boolean {
  const t = v.trim().replace(/[;,]$/, "");
  if (PLACEHOLDER_VALUE.test(t) || PLACEHOLDER_TEXT.test(t) || CODE_REF_VALUE.test(t) || t.includes("(") || /^\$\w+$/.test(t)) return true;
  if (/^[\^~<>=v]*\d+(?:\.[\dx*]+)*(?:[-+][\w.]+)?$/.test(t) || /^(?:latest|next|workspace:|npm:|file:|link:|git\+|github:)/.test(t)) return true; // a version or a package source
  if (/^[a-z]+(?:_[a-z]+){2,}$/.test(t) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t) || /^(?:[A-Z][a-z]+){2,}$/.test(t)) return true; // an identifier or an enum
  return /^[a-z][\w+.-]*:\/\/[^/@\s]+(?:\/|$)/i.test(t) && !/:\/\/[^/\s:]+:[^@\s]+@/.test(t); // a URL without a password in it
}

/** `SECRET_NAME=value` lines (.env blocks pasted into notes, shell and config files). */
function scanEnvLine(line: string, h: Hits): void {
  const m = ENV_LINE.exec(line);
  if (!m) return;
  const [, name = "", sep = "", rawValue = ""] = m;
  if (!secretKeyName(name) || !SECRET_KEY_NAME.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))) return;
  const value = rawValue
    .trim()
    .replace(/\s+#.*$/, "")
    .replace(/^["'`]|["'`][;,]?$/g, "");
  if (value.length < 4 || isPlaceholder(value) || (sep === ":" && /^[A-Z][a-z]+(?:\s|$)/.test(value))) return;
  if (/\s/.test(value) && !/:\/\/[^/\s:]+:[^@\s]+@/.test(value)) return; // prose after a colon, not a value
  h.rule = "env";
  h.add("env-secret", value);
}

/** Quoted literals assigned to secret-named keys in code and JSON. */
function scanCodeLine(line: string, h: Hits): void {
  for (const m of line.matchAll(CODE_LITERAL_RE)) {
    const [, key = "", value = ""] = m;
    if (key.includes("/") || key.startsWith("@") || !secretKeyName(key)) continue; // "@auth/core": a package, not a key
    if (isPlaceholder(value) || UI_VALUE.test(value) || value.toLowerCase().includes(key.toLowerCase())) continue;
    if (/^[a-z][a-z-]*$/.test(value) && value.length < 8) continue; // an enum-like word: "bearer", "basic"
    h.rule = "code-literal";
    h.add(/token|key/i.test(key) ? "api-token" : "password", value);
  }
}

interface Table {
  start: number;
  rows: string[][];
}

function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

const SEP_CELL = /^:?-{2,}:?$/;
const CRED_HEADER = new RegExp(String.raw`^(?:\*\*)?(?:[\p{L}-]+\s+){0,2}?(?:${STRONG}|pass|pw|pin|pins|codes?|access\s+codes?|secrets?|mdp|mot\s+de\s+passe|clé|cle|code\s+d['’]acc[eè]s)(?:\s*\([^)]*\))?(?:\*\*)?$`, "iu");
const NAMED_CELL = new RegExp(String.raw`^(?:[\p{L}-]+\s+){0,3}(?:${STRONG})$|^PINs?$|^(?:wi-?fi|wlan)$`, "iu");
const EMPTY_CELL = /^(?:|-|—|–|n\/?a|none|tbd|\?|✅|❌|✓|✗|✔|✘|⚠️?|yes|no|y|n|true|false|pass(?:ed)?|fail(?:ed)?|ok|x|done|skip(?:ped)?|pending|n\/a|\*+|\[.*withheld\]|\[redacted\]|same|see\s+.*)$/iu;

/** Markdown tables: a credential column (header Password, Pass, PIN, Code, Secret…) with a value in
 *  any row, or a row that names a credential in one cell and holds a value in a later one. */
function scanTables(lines: readonly string[], h: Hits): void {
  const tables: Table[] = [];
  let cur: Table | null = null;
  lines.forEach((line, i) => {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!cur) {
        cur = { start: i, rows: [] };
        tables.push(cur);
      }
      cur.rows.push(cells(line));
    } else cur = null;
  });
  for (const t of tables) {
    const sepAt = t.rows.findIndex((r) => r.length > 0 && r.every((c) => SEP_CELL.test(c) || c === ""));
    const header = sepAt > 0 ? (t.rows[sepAt - 1] ?? []) : [];
    const credCols = header.flatMap((c, i) => (CRED_HEADER.test(c.replace(/\*\*/g, "").trim()) ? [i] : []));
    const bareCode = (i: number): boolean => /^(?:\*\*)?codes?(?:\*\*)?$/i.test((header[i] ?? "").trim());
    t.rows.forEach((r, ri) => {
      if (ri <= sepAt) return;
      for (const ci of credCols) {
        const v = r[ci] ?? "";
        h.rule = "table-column";
        if (!EMPTY_CELL.test(v) && v.length >= 3 && (!bareCode(ci) || /\d{3,}/.test(v))) h.add("credential-table", v);
      }
      const named = r.findIndex((c) => NAMED_CELL.test(c));
      if (named >= 0) {
        h.rule = "table-row";
        // A "Wi-Fi" row holds a network name and its key: only a cell that looks like a key counts.
        const wifi = /^(?:wi-?fi|wlan)$/i.test(r[named] ?? "");
        const keyLike = (c: string): boolean => isSecretShaped(c) || (c === c.toLowerCase() && !WIFI_STATE.has(c) && !WORDY_SUFFIX.test(c) && !/\s/.test(c));
        for (const c of r.slice(named + 1)) if (!EMPTY_CELL.test(c) && c.length >= 3 && (plainValue(c) !== null || /\d{3,}/.test(c)) && (!wifi || keyLike(c))) h.add("credential-table", c);
      }
    });
  }
}

function lineReason(line: string): CredentialReason {
  return MANAGER_NAME.test(line) ? "password-manager" : "password";
}

/** Prose rules on one line (`norm`: numbers said in words turned into digits). `next` is the
 *  following non-blank line, for a label that sits alone on its line ("Password\nXy7!abcd"). */
function scanProseLine(norm: string, next: string | undefined, underCredHeading: boolean, h: Hits): void {
  const words: Array<{ index: number; end: number; word: string }> = [];
  // Cheap guards first: each heavy pattern only runs on a line that can match it.
  const hasCode = /code/i.test(norm);
  if (STRONG_HINT.test(norm)) for (const m of norm.matchAll(STRONG_RE)) if (wordStart(norm, m.index) || CJK_START.test(m[0])) words.push({ index: m.index, end: m.index + m[0].length, word: m[0] });
  if (/pin/i.test(norm)) for (const m of norm.matchAll(PIN_RE)) words.push({ index: m.index, end: m.index + m[0].length, word: "pin" });
  if (hasCode) for (const c of accessCodes(norm)) words.push({ ...c, word: "code" });
  // The new rules read the line with its links blanked (a URL's numbers and "=" are parameters).
  const bare = blankLinks(norm);
  if (/pass|key/i.test(norm) && PASS_CONTEXT.test(norm))
    for (const m of bare.matchAll(PASS_WORD_RE)) {
      if (m[0] === "PASS" || words.some((w) => m.index >= w.index && m.index < w.end)) continue; // "qa PASS": a verdict
      const before = bare.slice(Math.max(0, m.index - 40), m.index);
      const labelled = /^[^\S\n]*[:=]/.test(bare.slice(m.index + m[0].length)) && /(?:^|[^\S\n]{2}|[|,;•*>/-])[^\S\n]*(?:\*\*|__)?$/.test(before);
      // "key" only as a label on such a line ("Wifi — SSID: HomeNet, key: …"): a network key.
      const key = m[0].toLowerCase() === "key";
      if (labelled || (!key && PASS_BEFORE.test(before))) words.push({ index: m.index, end: m.index + m[0].length, word: key ? "network key" : "pass" });
    }
  for (const w of words) {
    // A word inside a link is a parameter ("…&pw=123456"): the new rules skip it (the older ones
    // below still read it as before).
    const inLink = !bare.slice(w.index, w.end).trim();
    if (/^(?:pw|p\/w|pass|network key)$/i.test(w.word) && inLink) continue;
    const reason = reasonForWord(w.word, norm);
    // 1. The value right after the label: "password: purplewalrus", "PIN - 4821", "wifi password is SunnyDay".
    const after = norm.slice(w.end);
    const lab = LABEL_AFTER.exec(after);
    const sep = (lab?.[1] ?? "").trim();
    const colon = /^(?:[:=→]|->|>>|=>)/.test(sep);
    const raw = lab ? joinDigitGroups(lab[2] ?? "", after.slice((lab.index ?? 0) + lab[0].length)) : "";
    // "— prompt for your key when…" defines a term; "- purplewalrus" at the end of a clause is a value.
    const endsClause = lab !== null && /^[^\S\n]*(?:[.;,!?)]|$)/.test(after.slice((lab.index ?? 0) + lab[0].length));
    // After "?", only a value that looks like one ("NAS password? purplewalrus", never "Forgot
    // password? Click here" or a question mid-transcript).
    const asked = sep === "?" && (reason === "api-token" || !(isSecretShaped(raw) || (raw === raw.toLowerCase() && !WORDY_SUFFIX.test(raw))));
    const v0 = colon ? colonValue(raw) : asked || (/^[-–—→]|^->/.test(sep) && !endsClause && !isSecretShaped(raw)) ? null : plainValue(raw);
    // "the password's purplewalrus": "'s" right after the word only.
    const apos = v0 || reason !== "password" ? null : APOS_S.exec(after);
    const araw = trimEdges(apos?.[1] ?? "");
    const v = v0 ?? (apos && (isSecretShaped(araw) || !WORDY_SUFFIX.test(araw)) ? plainValue(araw) : null);
    h.rule = `label:${w.word.toLowerCase().replace(/\s+/g, " ")}`;
    const newWord = /^(?:pw|p\/w|pass|network key)$/i.test(w.word);
    if (v && !TOPIC_WORD.test(v) && !(newWord && CODE_CHARS.test(v)) && (reason !== "access-code" || /\d/.test(v) || w.word !== "code")) h.add(reason, v);
    // 1b–1e. Other separators: "to" after a change, parentheses, none at all. A key or token needs a
    //    secret-shaped value there (an ordinary word after "API key" is prose).
    // "credentials (ADC)", "passwd ubuntu" (a command), "email (string)": never values.
    const token = reason === "api-token";
    const named = !NAMES_A_TOPIC.test(w.word);
    const accept = (x: string): string | null => {
      const t = token ? (isSecretShaped(x) ? trimEdges(x) : null) : plainValue(x);
      return t && reason === "access-code" && !/\d/.test(t) ? null : t;
    };
    if (!v && named) {
      const t = TO_VALUE.exec(after);
      const tail = t ? after.slice((t.index ?? 0) + t[0].length) : "";
      // "set to X", or X ends its clause ("changed the gym password to X last week"): never "reset
      // your password to regain access".
      const tv = t && (t[1] || (CHANGE_BEFORE.test(norm.slice(Math.max(0, w.index - 60), w.index)) && (TO_END.test(tail) || isSecretShaped(t[2] ?? "")))) ? accept(t[2] ?? "") : null;
      h.rule = `to:${w.word.toLowerCase()}`;
      if (tv) h.add(reason, tv);
      const p = PAREN_VALUE.exec(after);
      const praw = p?.[1] ?? "";
      const pv = p && (isSecretShaped(praw) || /\d/.test(praw) || !WORDY_SUFFIX.test(praw)) ? accept(praw) : null; // "Password (owner)" is a column note
      h.rule = `paren:${w.word.toLowerCase()}`;
      if (pv) h.add(reason, pv);
      const prefix = norm.slice(0, w.index);
      const b = !token && reason !== "access-code" && BARE_LABEL.test(w.word) && LABEL_PREFIX.test(prefix) && !DETERMINER.test(prefix) && !ADJECTIVE_PREFIX.test(prefix) ? BARE_VALUE.exec(after) : null;
      const braw = b?.[1] ?? "";
      const bv = b && /[A-Za-z0-9]/.test(braw) && (isSecretShaped(braw) || (!WORDY_SUFFIX.test(braw) && /[\p{L}\p{N}]/u.test(prefix))) ? plainValue(braw) : null;
      h.rule = `bare:${w.word.toLowerCase()}`;
      if (bv) h.add(reason, bv);
      // 1f. A colon however far along the clause ("Password for the NAS box … next to the router:
      //     X", "mdp gmail : X"), never a time ("changed at 10:30").
      const bareAfter = bare.slice(w.end);
      const c = !tv && !pv && !bv && !inLink ? CLAUSE_COLON.exec(bareAfter) : null;
      const cgap = c?.[1] ?? "";
      const crest = c ? bareAfter.slice(c.index + c[0].length) : "";
      const craw = c ? joinDigitGroups(c[2] ?? "", crest) : "";
      const cv = c && !(/\d$/.test(cgap) && /^\d/.test(craw)) && !OPEN_PAREN(cgap) && !/[<>`]/.test(cgap) && !CODE_CHARS.test(craw) && !(/^\d/.test(craw) && UNIT_AFTER.test(crest)) ? colonValue(craw) : null;
      h.rule = `clause-colon:${w.word.toLowerCase()}`;
      if (cv && !TOPIC_WORD.test(cv) && (isSecretShaped(cv) || !STOP_WORDS.has(cv.toLowerCase())) && (!token || isSecretShaped(cv)) && (reason !== "access-code" || /\d/.test(cv))) h.add(reason, cv);
      // 1g. "is" a few words on: "the password I use for everything is X".
      const g = !tv && !pv && !bv && !cv && !inLink ? WORD_SEP_GAP.exec(bareAfter) : null;
      const graw = trimEdges(g?.[2] ?? "");
      const short = (g?.[1] ?? "").trim().split(/\s+/).length <= 3 && !/(?<![\p{L}\p{N}])(?:that|which|who|um|uh|you|we|they)(?![\p{L}\p{N}])/iu.test(g?.[1] ?? "") && graw === graw.toLowerCase() && graw.length >= 6;
      const gv = g && (isSecretShaped(graw) || (short && !WORDY_SUFFIX.test(graw) && !TOPIC_WORD.test(graw))) ? accept(graw) : null;
      h.rule = `gap-is:${w.word.toLowerCase()}`;
      if (gv) h.add(reason, gv);
      // 1h. A Latin-script value inside Arabic text: "باسوورد الواي فاي purplewalrus".
      if (reason === "password" && /[\u0600-\u06ff]/.test(w.word)) {
        const clause = after.slice(0, 80).split(/[.!?;\n]/)[0] ?? "";
        h.rule = "latin-in-arabic";
        for (const m of clause.matchAll(LATIN_IN_ARABIC)) {
          const t = trimEdges(m[0]);
          if (!LATIN_LABEL.test(t) && plainValue(t)) h.add(reason, t);
        }
      }
    }
    if (reason === "access-code") {
      const d = BARE_DIGITS.exec(after);
      const digits = (d?.[1] ?? "").replace(/\D+/g, "");
      h.rule = `bare-digits:${w.word.toLowerCase()}`;
      if (d && digits.length >= 4 && !UNIT_AFTER.test(after.slice(d.index + d[0].length))) h.add(reason, digits, ...(/[A-Za-z]/.test(d[1] ?? "") ? [(d[1] ?? "").replace(/\s+/g, "")] : []));
    }
    // A passphrase of plain words after "is": "the master code is correct horse battery staple".
    const phrase = !v && !colon && /pass|master|recovery|seed|mnemonic|phrase|mdp/i.test(w.word) ? /^[^\S\n]+(?:is|was|are)[^\S\n]+([^.;:!?\n]{1,80})/i.exec(norm.slice(w.end)) : null;
    const plain = (phrase?.[1] ?? "").split(/\s+/).filter((x) => plainValue(x) !== null);
    h.rule = `passphrase:${w.word.toLowerCase().replace(/\s+/g, " ")}`;
    if (plain.length >= 3) h.add(reason, plain.join(" "));
    // 2. A label alone on its line, its value on the next: "Password\nXy7!abcd".
    if (next !== undefined && /^[\s*_#>:-]*$/.test(norm.slice(w.end)) && /^[\s*_#>-]*(?:[\p{L}'’-]+\s+){0,3}$/u.test(norm.slice(0, w.index))) {
      const only = next.trim().replace(/^[-*>•]\s*/, "");
      const nv = /^\S+$/.test(only) ? plainValue(only) : null;
      h.rule = `label-newline:${w.word.toLowerCase()}`;
      if (nv) h.add(reason, nv);
    }
    // 3. Any word order: a value within 80 characters ("4821 is the code for the flat", "the
    //    code starts with 48 and ends with 21", "4, then 8, then 2, then 1 at the door").
    // ±80 characters, widened to whole tokens (a cut token looks like a random string).
    let a = Math.max(0, w.index - 80);
    while (a > 0 && !/\s/.test(norm.charAt(a - 1))) a--;
    let b = Math.min(norm.length, w.end + 80);
    while (b < norm.length && !/\s/.test(norm.charAt(b))) b++;
    const vals = windowValues(norm.slice(a, b), w.end - a);
    h.rule = `window:${w.word.toLowerCase().replace(/\s+/g, " ")}`;
    if (vals.length) h.add(reason, ...vals.map((x) => x.value));
  }
  if (/(?:wi-?fi|pass|pw|p\/w|mdp|secret|login|combination|combo|clave|chiave)\s*[:=]/i.test(norm)) for (const m of norm.matchAll(LABEL_ONLY_RE)) {
    const label = (m[1] ?? "").toLowerCase();
    const v = colonValue(m[2] ?? "");
    if (!v || STOP_WORDS.has(v.toLowerCase())) continue;
    const combo = label === "combination" || label === "combo";
    h.rule = `label-only:${label}`;
    if (label === "login" ? isSecretShaped(v) : combo ? /\d/.test(v) : true) h.add(combo ? "access-code" : lineReason(norm), v);
  }
  // 4b. A value named in parentheses after it: "- **Gym**: purplewalrus _(password)_".
  if (bare.includes("(")) for (const m of bare.matchAll(PAREN_AFTER_RE)) {
    const v = plainValue(m[1] ?? "");
    const named = (/\(([^)]*)\)/.exec(m[0])?.[1] ?? "").trim().toLowerCase();
    if (!v || /^(?:pwd|passwd|app[\s-]passwords?)$/.test(named) || bare.slice(Math.max(0, m.index - 2), m.index + 2).includes("$")) continue; // "$(pwd)": a command
    if (/code|pin|combo|combination/.test(named) && !/\d/.test(v)) continue; // "(code)" names a subject
    h.rule = "paren-after";
    if (isSecretShaped(v) || (v === v.toLowerCase() && !WORDY_SUFFIX.test(v))) h.add(lineReason(norm), v);
  }
  // 4c. A network's password with no "password" at all: "The Wi-Fi is X", "Remember the wifi —
  //     it's X", "Wifi HomeNet / X".
  if (/wi-?fi|wlan/i.test(norm)) for (const m of bare.matchAll(WIFI_RE)) {
    const rest = bare.slice(m.index + m[0].length);
    const is = WIFI_IS.exec(rest) ?? WIFI_DASH.exec(rest);
    const raw = trimEdges(is?.[1] ?? "");
    const v = is && !WIFI_STATE.has(raw.toLowerCase()) && (isSecretShaped(raw) || (raw.length >= 5 && !WORDY_SUFFIX.test(raw) && !TOPIC_WORD.test(raw))) ? plainValue(raw) : null;
    h.rule = "wifi-is";
    if (v) h.add("password", v);
    const pair = WIFI_PAIR.exec(rest);
    const pv = pair ? plainValue(pair[2] ?? "") : null;
    h.rule = "wifi-pair";
    if (pv) h.add("password", pv);
    // "Lake house wifi (the one on the router sticker): seagullbay": a lowercase or secret-shaped
    // word after a colon along the clause ("Wi-Fi at the office: slow" is a state).
    const c = !v && !pv ? CLAUSE_COLON.exec(rest) : null;
    const craw = trimEdges(c?.[2] ?? "");
    const cv = c && !OPEN_PAREN(c[1] ?? "") && !CODE_CHARS.test(craw) && !WIFI_STATE.has(craw.toLowerCase()) && (isSecretShaped(craw) || (craw === craw.toLowerCase() && /\p{L}/u.test(craw) && craw.length >= 5 && !WORDY_SUFFIX.test(craw) && !TOPIC_WORD.test(craw))) ? colonValue(craw) : null;
    h.rule = "wifi-colon";
    if (cv && !STOP_WORDS.has(cv.toLowerCase())) h.add("password", cv);
  }
  h.rule = "access-verb";
  const hasDigit = /\d/.test(norm);
  // 5b. A code-shaped number within 40 characters of what it opens, either side, same clause.
  if (hasDigit && ACCESS_NEAR_HINT.test(norm)) accessNear(bare, h);
  if (hasDigit && ACCESS_PLACE.test(norm)) for (const m of norm.matchAll(ACCESS_VERB_RE)) h.add("access-code", (m[1] ?? "").replace(/\D+/g, ""));
  // 4. The value first: "purplewalrus is the gym password".
  if (words.length && /\b(?:is|was|are)\b|=|(?:that|it)['’]s|c['’]est/.test(norm)) for (const m of norm.matchAll(REVERSE_RE)) {
    const v = plainValue(m[1] ?? "");
    h.rule = "reverse";
    if (v) h.add(lineReason(norm), v);
  }
  // 5. An access point's digits: "Gate 3344", "The alarm is 5566.", "Gate: 1990#".
  h.rule = "access-label";
  if (hasDigit && ACCESS_PLACE.test(norm))
    for (const m of norm.matchAll(ACCESS_LABEL_RE)) {
      const val = m[1] ?? "";
      if (/^(?:19|20)\d\d$/.test(val) && !/[:=#]|code|pin/i.test(m[0])) continue;
      if (UNIT_AFTER.test(norm.slice(m.index + m[0].length))) continue; // "the front door is 80-90 cm wide"
      const digits = val.replace(/\D+(?=\d)/g, "");
      h.add("access-code", digits, ...(/[A-Za-z]$/.test(digits) ? [digits.replace(/[A-Za-z]+$/, "")] : []));
    }
  h.rule = "code-digits";
  if ((hasCode || /codice|c[óo]digo|رمز|كود/i.test(norm)) && /\d{4}/.test(norm))
    for (const m of norm.matchAll(CODE_DIGITS_RE)) {
      // "Labor Code 2802", "Cal. Bus. & Prof. Code 16600": a statute, not a door.
      if (/^Code/.test(m[0]) && /[A-Z][\p{L}]*\.?[^\S\n]+$/u.test(norm.slice(Math.max(0, m.index - 30), m.index))) continue;
      h.add("access-code", m[1] ?? "");
    }
  h.rule = "cvv";
  if (/cvv|cvc|csc/i.test(norm)) for (const m of norm.matchAll(CVV_RE)) h.add("card-number", m[1] ?? "");
  // 6. A login and its password.
  if (mayHoldPair(norm)) for (const m of norm.matchAll(USER_PAIR_RE)) {
    const [, user = "", pass = ""] = m;
    const label = pairLabel(norm.slice(0, m.index));
    if (!label) continue;
    if (!(user.includes("@") || /\b(?:login|logins|account|accounts|creds|credentials?|user(?:name)?|nas|router|wi-?fi|admin|ssh|ftp|vpn|portal)\b/i.test(label) || isSecretShaped(pass) || underCredHeading)) continue;
    h.rule = `pair:${user.includes("@") ? "email" : isSecretShaped(pass) ? "shaped" : underCredHeading ? "heading" : "label"}`;
    if (plainValue(pass) || isSecretShaped(pass)) h.add("login-pair", pass);
  }
  // 6b. "Router login → admin : X", "account: steph@mail.com pw X", "Anghami pass = X".
  if (/login|user|account|acct|creds|credential/i.test(norm) && /:|\bpw\b|\bpwd\b|\bpass/i.test(norm)) for (const m of bare.matchAll(LOGIN_PAIR_RE)) {
    const user = m[1] ?? "";
    const pass = trimEdges(m[2] ?? "");
    // A user name that looks like one ("admin", "steph@mail.com"), then a password that looks like one.
    const userLike = /[@\d_]|\.[a-z]/.test(user) || /^(?:admin|root|user|guest|pi|ubuntu)$/i.test(user);
    h.rule = "login-pair2";
    if (!CODE_CHARS.test(pass) && (isSecretShaped(pass) || (userLike && pass === pass.toLowerCase() && plainValue(pass) && !WORDY_SUFFIX.test(pass) && /\p{L}/u.test(pass) && pass.length >= 6))) h.add("login-pair", pass);
  }
  // 6c. A password manager's own code, however it is labelled.
  if (MANAGER_NAME.test(norm)) for (const m of bare.matchAll(MANAGER_LABEL_RE)) {
    const v = colonValue(m[2] ?? "");
    if (!v || STOP_WORDS.has(v.toLowerCase()) || CODE_CHARS.test(v) || CRED_WORD_VALUE.test(v)) continue;
    if (MANAGER_NAME.test(bare.slice(Math.max(0, m.index - 12), m.index + m[0].length).split(/[:=→—–-]/)[0] ?? "")) continue; // "Proton Pass —": the name
    h.rule = "manager-label";
    const more = m[1] ? (m[3] ?? "").split(/[\s,;]+/).map(trimEdges).filter((x) => x.length >= 3 && !STOP_WORDS.has(x.toLowerCase())) : [];
    h.add("password-manager", v, ...more);
  }
  const weak = /pass/i.test(norm) ? WEAK_PASS_RE.exec(bare) : null;
  h.rule = "label-pass";
  if (weak && isSecretShaped(weak[1] ?? "")) h.add("password", trimEdges(weak[1] ?? ""));
  // 7. Card numbers next to a card word, or written in groups.
  h.rule = "card";
  if (/\d{4}/.test(norm) && (CARD_CONTEXT.test(norm) || /\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}/.test(norm))) for (const c of cardNumbers(norm)) h.add("card-number", c);
  // 8. Under a "## Passwords" heading, every "Label: value" line is one.
  if (underCredHeading && norm.length <= 120) {
    const m = /^[\s>*•-]*(?:\*\*)?[\p{L}][^:=|]{0,40}?(?:\*\*)?\s*[:=–—]\s*["'`]?(\S+)["'`]?\s*$/u.exec(norm);
    const v = m?.[1] ? colonValue(m[1]) : null;
    h.rule = "heading-list";
    if (v && !STOP_WORDS.has(v.toLowerCase())) h.add(lineReason(norm), v);
  }
}

const PROSE_TRIGGER =
  /pass|pwd|\bpw\b|mdp|mot de passe|\bpins?\b|\bcodes?\b|digicode|secret|credential|creds|\blogin|wi-?fi|master|recovery|backup|\bseed|mnemonic|private|\bapi\b|\btokens?\b|\bauth|bearer|combination|\bpuk\b|cvv|cvc|\bcsc\b|\bdoor|\bgate|alarm|\bsafe\b|garage|\block|intercom|keypad|portail|porte|\bcard|visa|amex|\bkeys?\b|punch|\d{4}[ -]\d{4}[ -]\d{4}/i;
/** Credential words in other languages (lines are folded first: see foldText). Split by what they
 *  need, so the common line pays for one extra small regex: access points only matter with digits
 *  on the line, accented words and Arabic only on a non-ASCII line. */
const ML_WORD_TRIGGER = /kennw|contrase|senha|parol[ae]\s+d|wpa|\bwep\b|wlan|\bcodi|torcode|geheim|zugang|identifiants|credenc|credenzi/i;
const ML_PLACE_TRIGGER = /coffre|cadenas|casier|interphone|puerta|candado|cofre|cadeado|cancello|allarme|cassaforte|lucchetto|citofono|tresor/i;
const ML_NON_ASCII_TRIGGER = /c[óo]dig|t[üu]rcode|port[óo]n|port[ãa]o|[\u0600-\u06ff]/i;
const ML_TRIGGER = String.raw`${ML_WORD_TRIGGER.source}|${ML_PLACE_TRIGGER.source}|${ML_NON_ASCII_TRIGGER.source}`;
/** Words and places in one regex: one scan of the line instead of two (measured ~45% cheaper). */
const ML_ASCII_TRIGGER = new RegExp(`${ML_WORD_TRIGGER.source}|${ML_PLACE_TRIGGER.source}`, "i");
/** A line the prose rules must read. */
function proseTrigger(line: string, extraWords: boolean): boolean {
  if (PROSE_TRIGGER.test(line) || (extraWords && EXTRA_WORDS.test(line)) || (/\d/.test(line) && EXTRA_PLACES.test(line))) return true;
  // A place only matters with a value: digits, or numbers in words ("Cadenas du vélo : quatre huit deux un").
  if (ML_ASCII_TRIGGER.test(line)) return ML_WORD_TRIGGER.test(line) || /\d/.test(line) || HAS_NUM_WORD.test(line) || HAS_FR_WORD.test(line);
  return /[^\x00-\x7f]/.test(line) && ML_NON_ASCII_TRIGGER.test(line);
}
/** Round-2 password words (shorthand, leetspeak, more languages): rare, so tested once per file,
 *  then per line only in a file that has one. */
const EXTRA_WORDS = /p\/w|pa(?:[$5][s$5]|s[$5])w|kelm[ei]t|wachtw|palavra|\bclave\b|\bchiave\b|[şs]ifre|парол|密码|密碼|口令|パスワード|暗証|비밀번호/i;
/** Round-2 access points: they only matter next to a number, so only a line with a digit is tested. */
const EXTRA_PLACES =
  /\bcombos?\b|buzz|disarm|unlock|padlock|\batm\b|lobby|entrance|mailbox|letterbox|\bsafes\b|caja\s+fuerte|portone|2efel|qefel|(?:deur|poort|toegangs|kluis|door|gate|entry|lock|safe|keypad|alarm|pin)codes?\b|\bbab\b|bawwab|bin[ae]y[ea]|schloss|\bdeur|voordeur|\bpoort|kluis|portero|interfone|\bentree\b|\bboite|entr[ée]e|bo[iî]te|t[üu]r\b/i;
const EXTRA_TRIGGER = new RegExp(`${EXTRA_WORDS.source}|${EXTRA_PLACES.source}`, "i");
/** Lines longer than this are read in windows around anchors (anchorWindows). */
const LONG_LINE = 800;

/** Code-shaped numbers in `w`: 4+ digit runs (a trailing "#" or letter allowed: "4821#", "4821B"),
 *  and 3+ small digit groups ("19-27-04", "3-9-1-7"); never a date, time, version, year, reference
 *  or quantity. `after`: the value directly follows the access word and a separator, where 3 digits
 *  are a code too ("Bike lock: 391"). */
function codeNumbers(w: string, direct: boolean): string[] {
  const out: string[] = [];
  const re = direct ? /(?<![\p{L}\p{N}_])\d{3,}(?:[A-Za-z#*](?![\p{L}\p{N}]))?(?![\p{L}\p{N}_])/gu : /(?<![\p{L}\p{N}_])\d{4,}(?:[A-Za-z#*](?![\p{L}\p{N}]))?(?![\p{L}\p{N}_])/gu;
  for (const m of w.matchAll(re)) {
    const digits = m[0].replace(/\D+$/, "");
    if (/[A-Za-z]$/.test(m[0]) && digits.length > 5) continue; // "1234567a": a commit, not "4821B"
    const before = w.slice(Math.max(0, m.index - 20), m.index);
    const after = w.slice(m.index + digits.length);
    if (/\d[-/.:,]$/.test(before) || /^[-/.:,]\d/.test(after) || /^\.\p{L}/u.test(after)) continue; // a date, a time, a version, 1,000, "12345.lock"
    if (REF_BEFORE.test(before) || UNIT_AFTER.test(after)) continue;
    if (/(?:^|[^A-Za-z])(?!PIN|ATM|CVV|CVC|PUK)[A-Z]{2,4}[^\S\n]*$/.test(before) || /\b[xywh][^\S\n]*=[^\S\n]*$/.test(before)) continue; // "ISO 27001", "SB 1047", "y=1234"
    if (/\bP\.?\s?O\.?\s*Box[^\S\n]*$/i.test(before)) continue; // an address
    if (/(?:~|≈|\b(?:about|around|approx\.?|approximately|over|under|nearly|almost|some|up\s+to|more\s+than|less\s+than|at\s+least))[^\S\n]*$/i.test(before)) continue; // a quantity
    if (/^(?:19|20)\d\d$/.test(digits) && !direct) continue; // a year
    if (/^(?:[01]\d|2[0-3])[0-5]\d$/.test(digits) && TIME_BEFORE.test(before)) continue; // "at 0630"
    if (digits.length > 8) continue; // an id, a phone or account number, not a code
    out.push(digits);
  }
  // "0 8 1 5": four single digits or more, spaced.
  for (const m of w.matchAll(/(?<![\p{L}\p{N}.:/,-])\d(?:[^\S\n]+\d(?![\p{L}\p{N}])){3,}(?![\p{L}\p{N}]|[-/.:,]\d)/gu)) if (!UNIT_AFTER.test(w.slice(m.index + m[0].length))) out.push(m[0].replace(/\D+/g, ""));
  // "23A57", "4B21": a door code with a letter (3+ digits, 1-2 capitals, never a ref like "TICK-1889").
  for (const m of w.matchAll(/(?<![\p{L}\p{N}_$€£-])(?=[0-9A-Z]{4,6}(?![\p{L}\p{N}_-]))(?=(?:[A-Z]*\d){3})(?=\d*[A-Z]\d*(?![\p{L}\p{N}]))\d[0-9A-Z]{3,5}(?![\p{L}\p{N}_-])/gu))
    if (!/^\d+[KMBGT]$/.test(m[0]) && !REF_BEFORE.test(w.slice(Math.max(0, m.index - 20), m.index)) && !UNIT_AFTER.test(w.slice(m.index + m[0].length))) out.push(m[0]);
  for (const m of w.matchAll(/(?<![\p{L}\p{N}.:/,-])\d{1,2}(?![\p{L}\p{N}])(?:[^\S\n]*[-–—][^\S\n]*\d{1,2}(?![\p{L}\p{N}])){2,}(?![-/.:,]\d)/gu)) {
    const g = m[0].split(/\D+/).filter(Boolean);
    if (g.length === 3 && Number(g[1]) <= 12 && /[/.]/.test(m[0])) continue; // a date: 12/09/26
    if (UNIT_AFTER.test(w.slice(m.index + m[0].length))) continue;
    out.push(g.join(""));
  }
  return out;
}

/** URLs, wiki links and markdown link targets as spaces (same length, so indices hold): their
 *  numbers and "=" are ids and parameters ("…?crop=…&width=1200", "[[…-intercom-examplevendor-2552|…]]"). */
const LINK_SPAN = /[a-z][\w+.-]*:\/\/[^\s)\]>"'`]+|\bwww\.[^\s)\]>"'`]+|\[\[[^\]\n]*\]\]|\]\([^)\s]*\)/gi;
function blankLinks(s: string): string {
  return s.includes("//") || s.includes("[[") || s.includes("](") || /www\./i.test(s) ? s.replace(LINK_SPAN, (m) => " ".repeat(m.length)) : s;
}

/** Rule 5b: a code-shaped number within 40 characters of an access word, before or after it, in
 *  the same clause. */
function accessNear(norm: string, h: Hits): void {
  h.rule = "access-near";
  for (const m of norm.matchAll(ACCESS_NEAR_RE)) {
    // A word start (checked here, so the regex can skip ahead on first letters); a SAFE is an
    // investment, not a safe.
    if (/^SAFEs?$/.test(m[0]) || (m.index > 0 && /[\p{L}\p{N}._/-]/u.test(norm.charAt(m.index - 1)))) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    // The clause around the word: from the last sentence end before it to the next one after it.
    let a = Math.max(0, start - 40);
    while (a > 0 && a > start - 80 && !/\s/.test(norm.charAt(a - 1))) a--;
    let b = Math.min(norm.length, end + 40);
    while (b < norm.length && b < end + 80 && !/\s/.test(norm.charAt(b))) b++;
    const left = norm.slice(a, start).split(/[.!;](?=\s)|\n/).pop() ?? "";
    const right = norm.slice(end, b).split(/[.!;](?=\s|$)|\n/)[0] ?? "";
    const direct = /^[^\S\n]*(?:[:=→#]+|->|>>|[-–—](?=[^\S\n]*\d)|\(|is|was|est|ist|es|è|é)[^\S\n]*["'«(]?\d/iu.exec(right);
    const colonYear = direct !== null && /^[^\S\n]*[:=]/.test(right);
    const directVals = direct ? codeNumbers(right.slice(0, direct[0].length + 12), true).filter((v) => colonYear || !/^(?:19|20)\d\d$/.test(v)) : [];
    const vals = [...codeNumbers(left, false), ...codeNumbers(right, false), ...directVals];
    if (vals.length) h.add("access-code", ...vals);
  }
}
/** Where a credential can start on a long line: the prose trigger words, a login pair's slash, a
 *  digit group of a card. */
const PROSE_ANCHOR = new RegExp(
  String.raw`${EXTRA_TRIGGER.source}|pass|pwd|\bpw\b|mdp|\bpins?\b|PIN|\bcodes?\b|digicode|secret|credential|creds|\blogin|wi-?fi|master|recovery|backup|\bseed|mnemonic|private|\bapi\b|\btokens?\b|\bauth|bearer|combination|\bpuk\b|cvv|cvc|\bcsc\b|\bdoor|\bgate|alarm|\bsafe\b|garage|\block|intercom|keypad|portail|porte|\bcard|visa|amex|\bkeys?\b|punch|\d{4}[ -]\d{4}[ -]\d{4}|\s\/\s|${ML_TRIGGER}`,
  "gi",
);
const CODE_ANCHOR = /pass|pwd|secret|token|key|credential|auth|dsn|database_url|connection/gi;
const WINDOW_RADIUS = 240;

/** The merged windows (±240 characters, snapped to whitespace) around each anchor of a long line. */
function anchorWindows(line: string, anchor: RegExp = PROSE_ANCHOR): string[] {
  const spans: Array<[number, number]> = [];
  for (const m of line.matchAll(anchor)) {
    let a = Math.max(0, m.index - WINDOW_RADIUS);
    let b = Math.min(line.length, m.index + m[0].length + WINDOW_RADIUS);
    while (a > 0 && a > m.index - WINDOW_RADIUS - 40 && !/\s/.test(line.charAt(a - 1))) a--;
    while (b < line.length && b < m.index + WINDOW_RADIUS + 40 && !/\s/.test(line.charAt(b))) b++;
    const last = spans.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  }
  return spans.map(([a, b]) => line.slice(a, b));
}

/** A "label: user / pass" line (checked without a regex that rescans the line from every colon). */
function mayHoldPair(line: string): boolean {
  return line.includes(":") && (line.includes(" /") || line.includes("/ "));
}
const CODE_TRIGGER = /pass|pwd|secret|token|key|credential|auth|dsn|database_url|connection/i;
/** A heading (or a bold line) that names credentials: "## Passwords", "**Wifi & door codes**". */
const CRED_HEADING = new RegExp(String.raw`^\s*(?:#{1,6}\s+|\*\*|__)(?:[\p{L}'’&-]+\s+){0,3}(?:${STRONG}|PINs?|logins?|mots?\s+de\s+passe)(?:\s+[\p{L}'’&-]+){0,3}\s*(?:\*\*|__)?\s*:?\s*$`, "iu");
/** A line that opens a list of them: "Passwords:", "Door codes:". */
const CRED_LIST_OPENER = new RegExp(String.raw`^\s*(?:[\p{L}'’&-]+\s+){0,3}(?:${STRONG}|PINs?|logins?)\s*:\s*$`, "iu");

/** Scans one file's text. `path` picks the rules (prose, code, config). High recall: see the
 *  header. Stops at the first few reasons unless `collectValues`. */
export function scanText(text: string, path: string, opts: { collectValues?: boolean; onHit?: (h: ScanHit) => void } = {}): ScanResult {
  const h = new Hits(opts.collectValues === true || opts.onHit !== undefined, opts.onHit);
  scanShapes(text, h);
  const kind = fileKind(path);
  const lines = text.split(/\r?\n/);
  if (kind === "code") {
    if (!CODE_TRIGGER.test(text)) return { reasons: [...h.reasons], values: [...h.values] };
    const config = isConfigFile(path);
    for (const [i, line] of lines.entries()) {
      h.line = i + 1;
      if (!CODE_TRIGGER.test(line)) continue;
      if (line.length > LONG_LINE) {
        for (const win of anchorWindows(line, CODE_ANCHOR)) scanCodeLine(win, h); // minified JSON or JS
        continue;
      }
      if (config) scanEnvLine(line, h);
      scanCodeLine(line, h);
      if (h.done) break;
    }
    return { reasons: [...h.reasons], values: [...h.values] };
  }
  if (/\.html?$/i.test(path) && /<script|<style/i.test(text)) {
    // A page's scripts are code (minified JS says "password:!0" all day); its text is prose.
    let prose = text;
    for (const m of text.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const inner = scanText(m[2] ?? "", `${path}.js`, opts);
      for (const r of inner.reasons) h.add(r, ...inner.values);
    }
    prose = prose.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
    const rest = scanText(prose.replace(/<[^>]+>/g, " "), `${path}.md`, opts);
    for (const r of rest.reasons) h.add(r, ...rest.values);
    return { reasons: [...h.reasons], values: [...h.values] };
  }
  // Prose: every rule, on folded text (other scripts' digits, fullwidth forms). A .env block pasted
  // into a note counts too.
  const folded = foldText(text);
  const extra = EXTRA_WORDS.test(folded);
  const plines = folded.split(/\r?\n/);
  if (text.includes("|")) scanTables(plines, h);
  let credHeading = false;
  let blank = 0;
  let fenced = false;
  for (let i = 0; i < plines.length && !h.done; i++) {
    const line = plines[i] ?? "";
    h.line = i + 1;
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!line.trim()) {
      if (++blank >= 2) credHeading = false;
      continue;
    }
    blank = 0;
    if (/^\s*#{1,6}\s/.test(line) || /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$/.test(line)) {
      credHeading = CRED_HEADING.test(line);
      continue;
    }
    if (line.length > LONG_LINE) {
      // A transcript or export line (often megabytes of JSON): only the windows around a
      // credential word or a value-shaped anchor are read with the prose rules.
      for (const win of anchorWindows(line)) scanProseLine(spokenToDigits(win), undefined, false, h);
      continue;
    }
    if (!credHeading && !proseTrigger(line, extra) && !mayHoldPair(line)) continue;
    const chunks = [line];
    let next: string | undefined;
    for (let j = i + 1; j < plines.length && j <= i + 2; j++)
      if ((plines[j] ?? "").trim()) {
        next = plines[j];
        break;
      }
    for (const chunk of chunks) {
      const norm = spokenToDigits(chunk);
      scanEnvLine(norm, h);
      scanProseLine(norm, next, credHeading && !fenced, h);
    }
    if (CRED_LIST_OPENER.test(line)) credHeading = true; // "Passwords:" on its own line opens a list
  }
  return { reasons: [...h.reasons], values: [...h.values] };
}

// ── the reply guard's own net ───────────────────────────────────────────────
// scanText decides which FILES close, so it must not close half the vault. The reply guard only
// decides which SENTENCES of one reply are withheld, so it can be much looser, and it must not
// share scanText's blind spots: it has its own trigger words and its own notion of a value, and a
// dictionary (the caller's) to tell a password from a word. Values stay in memory, per turn.

/** Words after which a word the dictionary does not know is a value: passwords and network keys
 *  in any language, logins, seeds and recovery phrases. */
const GUARD_WORD_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_$])(?:${MASTER_WORDS}|${RECOVERY_WORDS}|${PASSWORD_WORDS}|pass|wi-?fi|wlan|ssid|network\s+key|clave|chiave|credentials?|creds|logins?|keys?(?=[^\S\n]*[:=]))(?![\p{L}\p{N}_])|${CJK_PASSWORD}`,
  "giu",
);
/** Words near which a number is a value: codes, PINs, combinations and what they open. */
const GUARD_CODE_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}._/$-])(?:codes?|codice|c[óo]digos?|pins?|pincodes?|[a-z]{3,}codes?|digicodes?|combos?|combinations?|secrets?|cvv2?|cvc2?|csc|security\s+codes?|passcodes?|${ACCESS_NEAR_WORDS})(?![\p{L}\p{N}_]|[-./][\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:[وفبلك]|لل|ال|بال|وال|فال|كال)?(?:رمز|كود|رقم\s+(?:ال)?سري|باب|بواب[ةه]|قفل|خزن[ةه]|[إا]نذار)(?![\p{L}\p{N}])`,
  "giu",
);
/** What may stand between a trigger word and its value. */
const GUARD_SEP = /(?:[:=→]+|->|>>+|=>|\?|\||[—–-](?=[^\S\n])|\/|\(|['’]s(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:is|was|are|es|est|ist|è|é|lautet|c['’]est|هو|هي)(?![\p{L}\p{N}])|是)[^\S\n]*(?:(?:it['’]s|that['’]s|c['’]est|now|still|just|currently)[^\S\n]+)?/giu;
const GUARD_TOKEN = /^[^\S\n]*[*_]*["'«“‘`]?([^\s"'»”’`|,;:()/?*]{3,64})/u;
const GUARD_PAIR = /^[^\S\n]*\/[^\S\n]*["'«“‘`]?([^\s"'»”’`|,;:()/?*]{3,64})/u;
const GUARD_PHRASE = /phrase|seed|mnemonic|words|master|recovery|backup/i;
/** Everyday words /usr/share/dict/words (1934) does not know. */
const GUARD_KNOWN = new Set(
  "email emails e-mail username usernames login logins logout signup signin online offline website websites webpage app apps api apis ui ux url urls sso oauth otp 2fa mfa wifi wi-fi iphone ipad android ios macos laptop smartphone gmail google whatsapp instagram linkedin notion slack github password passwords passcode dashboard backend frontend database startup okay ok".split(" "),
);
const ARABIC_CHAR = /[\u0600-\u06ff]/;

/** A value that is itself a trigger word ("wifi pw: …": "pw" is not the value). */
const GUARD_TRIGGER_WORD = new RegExp(String.raw`^(?:${GUARD_WORD_RE.source}|${GUARD_CODE_RE.source})$`, "iu");

/** One line's clauses: split at a sentence end (a "?" stays: "NAS password? X"). */
function guardClauses(line: string): string[] {
  return line.split(/(?<=[.!;])[^\S\n]+/);
}

/** The reply guard's own values in `text` (the retrieved notes, or what a lookup read): after a
 *  password word, the first word after a separator (and anything secret-shaped right after it)
 *  that `isWord` does not know; around a code word, any code-shaped number; a value named after
 *  it ("X — that's the NAS password", "X (password)"). Numbers said in words count; `isWord`
 *  defaults to knowing no word, which only makes the net wider. In memory only. */
export function looseSecretValues(text: string, isWord: (w: string) => boolean = () => false): string[] {
  const out = new Set<string>();
  if (!text) return [];
  const norm = spokenToDigits(foldText(text));
  const unknown = (raw: string): string | null => {
    const t = trimEdges(raw);
    const low = t.toLowerCase();
    if (t.length < 3 || t.length > 64 || STOP_WORDS.has(low) || LABEL_STOP.has(low) || WIFI_STATE.has(low) || PLACEHOLDER_TEXT.test(t)) return null;
    if (/^(?:https?:|~\/|\/)/i.test(t) || /^[\p{L}]+\.(?:md|txt|json|pdf|com|ai|io|dev)$/iu.test(t) || GUARD_TRIGGER_WORD.test(t)) return null;
    if (/^\d+$/.test(t)) return t.length >= 3 ? t : null;
    if (isSecretShaped(t)) return t;
    return /\p{L}/u.test(t) && !GUARD_KNOWN.has(low) && !isWord(low) && !isWord(t) ? t : null;
  };
  /** Adjacent with no separator, a value must look like one: secret-shaped, or an unknown word in
   *  lowercase ("NAS pw hunter22", "Home Wi-Fi password purplewalrus"), never a Name. */
  const adjacent = (raw: string): string | null => {
    const t = unknown(raw);
    return t && (isSecretShaped(t) || /^\d+$/.test(t) || t === t.toLowerCase()) ? t : null;
  };
  for (const line of norm.split("\n")) {
    if (!line.trim()) continue;
    for (const clause of guardClauses(line)) {
      for (const m of clause.matchAll(GUARD_WORD_RE)) {
        const rest = clause.slice(m.index + m[0].length, m.index + m[0].length + 160);
        // A login names its fields ("The login page has 3 fields: email, password"): only a pair's
        // second half or a secret-shaped word is a value after it.
        const loginWord = /^(?:logins?|credentials?|creds)$/i.test(m[0]);
        const unknownHere = (raw: string): string | null => {
          const t = unknown(raw);
          return t && (!loginWord || isSecretShaped(t)) ? t : null;
        };
        // Right after the word: "NAS pw hunter22"; "Wifi HomeNet / purplewalrus" is a pair.
        const adj = GUARD_TOKEN.exec(rest);
        if (adj && /^[^\S\n]/.test(rest)) {
          const pair = GUARD_PAIR.exec(rest.slice(adj[0].length));
          const v = pair ? unknown(pair[1] ?? "") : adjacent(adj[1] ?? "");
          if (v && (pair || !loginWord || isSecretShaped(v))) out.add(v);
        }
        // After each separator in the clause (the first three): "wifi pw: X", "the password I
        // use is X", "Password (the long one …): X", "c'est X", "lautet X", "هي X".
        let seps = 0;
        for (const s of rest.matchAll(GUARD_SEP)) {
          if (++seps > 3) break;
          // A colon may sit far along the clause ("Password for the NAS box … router: X"); any other
          // separator belongs to the word only close by, and "(" only right after it ("pw (X)").
          const sep = s[0].trim().charAt(0);
          if (sep === "(" ? s.index > 3 : !/[:=>|]/.test(sep) && s.index > 40) continue;
          const after = rest.slice(s.index + s[0].length);
          const tok = GUARD_TOKEN.exec(after);
          const pair = tok ? GUARD_PAIR.exec(after.slice(tok[0].length)) : null;
          const pv = pair ? unknown(pair[1] ?? "") : null;
          const v = tok ? (pv ? unknown(tok[1] ?? "") : unknownHere(tok[1] ?? "")) : null;
          if (v && !(loginWord && pv)) out.add(v);
          if (pv) out.add(pv);
          // A phrase: every unknown word of a seed or passphrase ("abandon ability able …",
          // "correct horse battery staple": its first word may be an everyday one).
          let words = 0;
          if (GUARD_PHRASE.test(m[0])) {
            const ws = after.split(/[^\S\n]+/).slice(0, 24);
            for (const w of ws) {
              const x = unknown(w);
              if (x) out.add(x);
              if (x) words++;
            }
            const phrase = ws.map((w) => trimEdges(w)).filter((w) => /^\p{L}+$/u.test(w));
            if (phrase.length >= 4 && phrase.length === ws.filter(Boolean).length) {
              out.add(phrase.join(" ")); // "orbit lemon canyon velvet …": BIP39 words are all dictionary words
              words++;
            }
          }
          if ((v || words) && !s[0].startsWith("|")) break; // a table row: every cell
        }
        // Inside Arabic text, a Latin-script word is the value: "باسوورد الواي فاي purplewalrus".
        if (ARABIC_CHAR.test(m[0]))
          for (const x of rest.matchAll(LATIN_IN_ARABIC)) {
            const t = trimEdges(x[0]);
            const v = LATIN_LABEL.test(t) ? null : unknown(t);
            if (v) out.add(v);
          }
      }
      // A password manager's code, however it is labelled (every word of an emphasised value).
      if (MANAGER_NAME.test(clause))
        for (const m of clause.matchAll(MANAGER_LABEL_RE)) {
          for (const w of [m[2] ?? "", ...(m[1] ? (m[3] ?? "").split(/[\s,;]+/) : [])]) {
            const t = trimEdges(w);
            if (t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()) && !LABEL_STOP.has(t.toLowerCase()) && !CODE_CHARS.test(t)) out.add(t);
          }
        }
      // A login pair with no credential word: "iCloud: steph@example.com / GreenTea42".
      for (const m of clause.matchAll(/[\w.%+-]{1,64}@[\w-]+(?:\.[\w-]+)+[^\S\n]*\/[^\S\n]*["'«]?([^\s"'»|,;]{3,64})/gu)) {
        const v = unknown(m[1] ?? "");
        if (v) out.add(v);
      }
      // The value first: "X — that's the NAS password", "X is my gym password", "X _(password)_".
      for (const re of [REVERSE_RE, PAREN_AFTER_RE])
        for (const m of clause.matchAll(re)) {
          const v = unknown(m[1] ?? "");
          if (v) out.add(v);
        }
      // Numbers around a code word, and a value right after its separator ("Security code on
      // the back: 123", "Gate: 1990#").
      for (const m of clause.matchAll(GUARD_CODE_RE)) {
        if (/^SAFEs?$/.test(m[0])) continue;
        const start = m.index;
        const end = m.index + m[0].length;
        const left = clause.slice(Math.max(0, start - 60), start);
        const right = clause.slice(end, end + 60);
        for (const v of [...codeNumbers(left, false), ...codeNumbers(right, false)]) out.add(v);
        const s = /^(?:(?:[^\S\n]+[^\s:=.,;!?]+){1,3}?[^\S\n]*(?:[:=]|[^\S\n](?:is|was|es|est|ist|è|é|هو|هي)(?![\p{L}\p{N}]))|[^\S\n]*(?:[:=→#]+|->|>>|[—–-]|\(|(?:is|was|es|est|ist|è|é|هو|هي)(?![\p{L}\p{N}]))?)[^\S\n]*(?:(?:le|la|el|il|the)[^\S\n]+)?["'«(]?(\d{1,4}(?:[^\S\n]*[- ][^\S\n]*\d{1,4})+(?![\p{L}\p{N}])|\S+)/iu.exec(right);
        const raw = trimEdges(s?.[1] ?? "");
        if (s && UNIT_AFTER.test(right.slice(s.index + s[0].length))) continue; // "Unlock 5000 credits"
        const joined = /^\d{1,4}(?:[^\S\n]*[- ][^\S\n]*\d{1,4})+$/.test(raw) ? raw.replace(/\D+/g, "") : "";
        if (joined.length >= 4 && !DATE_LIKE.test(raw)) out.add(joined); // "code 88 21"
        else if (/^\d{3,}[#*A-Za-z]?$/.test(raw) && (!/^(?:19|20)\d\d$/.test(raw) || /^[^\S\n]*[:=]/.test(right))) out.add(raw.replace(/\D+$/, ""));
        else if (/^(?=(?:\D*\d){2})[A-Za-z0-9]{3,8}$/.test(raw) && /[A-Za-z]/.test(raw)) out.add(raw); // "4B21"
        else if (raw && isSecretShaped(raw)) out.add(raw);
      }
    }
  }
  return [...out];
}

// ── deep mode: the excluded files as CLI deny rules ─────────────────────────

/** A `Read(//abs/path)` rule for one excluded file. The CLI's rules are gitignore-style globs, so
 *  every glob or rule-syntax character (* ? [ ] \ ! ( ) { } #) becomes `?` (any one character: a
 *  rule may then also deny a same-shaped sibling, never miss the file). */
export function denyRuleForPath(abs: string): string {
  const safe = abs.replace(/[*?[\]\\!(){}#]/g, "?");
  return `Read(/${safe})`;
}

/** Deny rules for every excluded file, in both Unicode forms macOS can hand back (a name typed
 *  with "é" is NFC; the same name read from disk is NFD). */
export function excludedDenyRules(paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) for (const form of [p.normalize("NFC"), p.normalize("NFD")]) out.add(denyRuleForPath(form));
  return [...out];
}

/** The case- and Unicode-insensitive key the tripwire compares paths by (the Mac's disk ignores
 *  case; a model can type a path in any case). */
export function pathKey(abs: string): string {
  return abs.normalize("NFC").toLowerCase().replace(/\/+$/, "");
}

// ── what the scanner never walks (and so deep mode never reads) ─────────────

/** Dependency, build-output and cache folders: not his notes, far too big to vet, and build output
 *  can inline real secrets (a Next.js server bundle with its env baked in). Never scanned, so
 *  never readable: deep mode gets a deny rule for each, the tripwire refuses them too. */
export const UNSCANNED_DIRS: readonly string[] = [
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".turbo",
  ".cache",
  "vendor",
  ".gradle",
  ".terraform",
  "Pods",
  "DerivedData",
  ".pnpm-store",
  ".yarn",
  ".parcel-cache",
  "coverage",
  ".trash", // Obsidian's deleted notes
  ".Trash",
];
/** Raw machine logs and transcripts (session .jsonl, server .log): gigabytes, full of pasted
 *  output, and no voice question is answered from them. Never scanned, never readable. */
export const UNSCANNED_EXTS: readonly string[] = [".jsonl", ".log"];
const UNSCANNED_SET = new Set(UNSCANNED_DIRS.map((d) => d.toLowerCase()));

/** A folder name the scanner skips ("node_modules", and iCloud's "node_modules.nosync" too). */
export function isUnscannedDirName(name: string): boolean {
  const n = name.toLowerCase();
  return UNSCANNED_SET.has(n) || (n.endsWith(".nosync") && UNSCANNED_SET.has(n.slice(0, -7)));
}

/** A file name the scanner skips (a .jsonl transcript, a .log). */
export function isUnscannedFileName(name: string): boolean {
  return UNSCANNED_EXTS.includes(extname(name).toLowerCase());
}

/** True for a path the scanner never vets: inside a skipped folder, or a skipped kind of file. */
export function isUnscannedPath(abs: string): boolean {
  const parts = abs.split(/[\\/]+/).filter(Boolean);
  return parts.slice(0, -1).some(isUnscannedDirName) || isUnscannedDirName(parts.at(-1) ?? "") || isUnscannedFileName(parts.at(-1) ?? "");
}

/** The CLI deny rules for the skipped folders (case variants: the CLI's globs are case-sensitive). */
export function unscannedDenyRules(): string[] {
  const out = new Set<string>();
  for (const d of UNSCANNED_DIRS) for (const v of [d, d.toLowerCase(), d.toUpperCase(), d.charAt(0).toUpperCase() + d.slice(1)]) for (const s of [v, `${v}.nosync`]) out.add(`Read(//**/${s}/**)`);
  for (const e of UNSCANNED_EXTS) for (const v of [e, e.toUpperCase()]) out.add(`Read(//**/*${v})`);
  return [...out];
}
