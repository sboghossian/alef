// Pure half of the "sickness" feature (no fs, no network, no model): three deterministic
// detectors over one transcript line at a time, and the case book that folds their events into
// one persisted record per minion + disease. server/features/sickness-scan.ts feeds it bytes.
//
// Everything here reads untrusted transcript text. It is matched against regexes, never executed.
//
// SECRET INVARIANT: a key value never leaves findKeys(). A KeyHit carries the provider, a 10-hex
// sha256 prefix and the provider's fixed prefix ("sk-or-v1-..."), nothing of the random body.
// Every other string that leaves this file (targets, hosts) goes through scrubKeys() and
// redactCommand() first.

import { createHash } from "node:crypto";
import {
  isSicknessTreatment,
  openEntries,
  STEERING_LABEL,
  SICK_STATES,
  SICKNESS_KINDS,
  SICKNESS_STATES,
  type HostFlag,
  type LeakVector,
  type SicknessCase,
  type SicknessCounts,
  type SicknessKind,
  type SicknessSource,
  type SicknessState,
  type SicknessTreatment,
} from "../../shared/features/sickness.js";
import { redactCommand } from "../activity.js";
import { maskShell, stripHeredocs } from "./tripwires-lib.js";

/** Bump when a regex bank, a placeholder rule or a marker changes: every transcript is rescanned. */
export const SICKNESS_BANK_VERSION = 1;
/** Kinds that are detected and persisted but never served (precision below 50% on the hand check).
 *  Flip a kind out of here to serve it: its cases are already on disk, no rescan needed.
 *  steering-page: 0 of 28 real cases (2026-09-28). The vendored ai-defence bank fires on ordinary
 *  pages: "aim" (rh_004, case-insensitive "AIM"), "without limitation" (rh_007), news about
 *  jailbreaks (rh_006), and zero-width spaces, BOMs and Arabic bidi marks (hu_001). No page hit an
 *  instruction_override, output_exfiltration or tag-character pattern. */
export const DISABLED_KINDS: ReadonlySet<SicknessKind> = new Set<SicknessKind>(["steering-page"]);
/** Lines longer than this are skipped unread (and counted). */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** Build failure markers are looked for in this many trailing characters of the output. */
export const RESULT_TAIL_CHARS = 20 * 1024;
/** A failing build case turns chronic once its transcript has written nothing for this long. */
export const CHRONIC_QUIET_MS = 2 * 60 * 60 * 1000;
/** A fetched page is scanned for steering text up to this many characters. */
export const WEB_SCAN_MAX_CHARS = 1_000_000;
/** Remembered tool calls per transcript (pairs a tool_result with its tool_use). */
export const CALLS_CAP = 64;
const TARGET_MAX = 120;

// ── Shared helpers ───────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Stable case id: kind + agent + the thing (never a secret: callers pass hash10, a class or a host). */
export function caseId(kind: SicknessKind, sessionId: string, subagentId: string | null, thing: string): string {
  return `${kind}:${sha256Hex([kind, sessionId, subagentId ?? "", thing].join("\u0000")).slice(0, 16)}`;
}

// ── (1) Leaked keys ──────────────────────────────────────────────────────────────────────────

interface KeyRule {
  provider: string;
  /** Global regex over the text; group 1 (when present) is the provider prefix shown masked. */
  re: RegExp;
  /** Fixed prefix shown in place of the key (never a character of its random body). */
  masked(m: RegExpExecArray): string;
  /** The random part, for the placeholder rules. */
  body(m: RegExpExecArray): string;
}

const ANY_PREFIX = (m: RegExpExecArray): string => `${m[1] ?? ""}...`;

/** Fixed regex bank. Tight on purpose: each shape is the provider's real format, so text that
 *  merely mentions a prefix ("sk-", "task-…", a regex source) never matches. */
const KEY_RULES: readonly KeyRule[] = [
  // Anthropic: sk-ant-api03-<~95 base64url>, sk-ant-admin01-<…>. Real keys are 100+ chars.
  { provider: "Anthropic", re: /\b(sk-ant-(?:api|admin)\d{2}-)([A-Za-z0-9_-]{80,})/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // OpenRouter: sk-or-v1-<64 hex>.
  { provider: "OpenRouter", re: /\b(sk-or-v1-)([0-9a-f]{64})(?![0-9A-Za-z])/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // OpenAI project / service-account / admin keys.
  { provider: "OpenAI", re: /\b(sk-(?:proj|svcacct|admin)-)([A-Za-z0-9_-]{40,})/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // OpenAI legacy: sk-<48 alnum>, no hyphen in the body (so sk-ant-/sk-or-/slugs never match).
  { provider: "OpenAI", re: /\b(sk-)([A-Za-z0-9]{32,})(?![A-Za-z0-9_-])/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // GitHub classic tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36 alnum.
  { provider: "GitHub", re: /\b(gh[pousr]_)([A-Za-z0-9]{36})(?![A-Za-z0-9_])/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // GitHub fine-grained PAT: github_pat_<22>_<59>.
  { provider: "GitHub", re: /\b(github_pat_)([A-Za-z0-9_]{70,})/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // AWS access key id: AKIA + 16 base32 characters (A-Z, 2-7), the real format.
  { provider: "AWS", re: /\b(AKIA)([A-Z2-7]{16})(?![0-9A-Za-z])/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // Slack: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-.
  { provider: "Slack", re: /\b(xox[baprs]-)([A-Za-z0-9-]{10,})/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // Google API key: AIza + 35 (may end in "-", so a lookahead instead of \b).
  { provider: "Google", re: /\b(AIza)([0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // Stripe live secret / restricted keys.
  { provider: "Stripe", re: /\b((?:sk|rk)_live_)([0-9A-Za-z]{20,})/g, masked: ANY_PREFIX, body: (m) => m[2] ?? "" },
  // PEM private key block with a real body (64+ base64 chars; literal "\n" escapes allowed).
  {
    provider: "Private key",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----([A-Za-z0-9+/=\s\\]{64,}?)-----END \1PRIVATE KEY-----/g,
    masked: (m) => `-----BEGIN ${m[1] ?? ""}PRIVATE KEY-----...`,
    body: (m) => (m[2] ?? "").replace(/\\n/g, "").replace(/\s+/g, ""),
  },
];

/** Cheap substrings: a line containing none of them holds no key and is never decoded for keys. */
export const KEY_PREFILTER: readonly string[] = ["sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "AKIA", "xox", "AIza", "_live_", "PRIVATE KEY"];

/** Why a key-shaped match is a placeholder, not a key (null = treat it as real). Documented rules:
 *  - a marker word in the value: FAKE, EXAMPLE, XXXX, dummy, your (your_key, your-token…),
 *    placeholder, redacted, sample (case-insensitive);
 *  - a run of "***" touching the value (a masked display such as "AKIA1234…****");
 *  - an angle-bracket template: "<value>", or the value followed by "<name>" ("sk-proj-abc<your-key>").
 *    A value inside an XML element ("<string>value</string>", a LaunchAgent plist) is NOT a template;
 *  - a body that is one repeated character ("sk-or-v1-000…0");
 *  - a body with a sequential run of 8+ ("abcdefgh", "AbCdEfGh", "23456789"): a hand-made fixture
 *    (the probes that test secret scanners build keys like "AIzaSy" + "…AbCdEfGhI"), never random. */
export function placeholderReason(value: string, body: string, before: string, after: string): string | null {
  if (/fake|example|xxxx|dummy|your|placeholder|redacted|sample/i.test(value)) return "marker word";
  if (/\*\*\*$/.test(before) || /^\*\*\*/.test(after)) return "masked stars";
  if ((before.endsWith("<") && after.startsWith(">")) || /^<[A-Za-z_]/.test(after)) return "angle-bracket template";
  if (body.length > 0 && /^(.)\1*$/s.test(body)) return "one repeated character";
  if (longestSequentialRun(body) >= 8) return "sequential run";
  return null;
}

/** Longest run of consecutive ascending letters or digits, case-insensitive ("xAbCd" → 4). */
export function longestSequentialRun(s: string): number {
  const t = s.toLowerCase();
  let best = t.length > 0 ? 1 : 0;
  let run = 1;
  for (let i = 1; i < t.length; i++) {
    const a = t.charCodeAt(i - 1);
    const b = t.charCodeAt(i);
    const alnum = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    run = alnum(a) && alnum(b) && b === a + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

export interface KeyHit {
  provider: string;
  /** sha256(value) first 10 hex. */
  hash10: string;
  /** The provider prefix only, e.g. "sk-or-v1-...". */
  masked: string;
}

/** Every distinct real key in `text` (placeholders dropped), deduped by hash. Never returns a value. */
export function findKeys(text: string): KeyHit[] {
  const out: KeyHit[] = [];
  const seen = new Set<string>();
  for (const rule of KEY_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m !== null; m = rule.re.exec(text)) {
      const value = m[0];
      const before = text.slice(Math.max(0, m.index - 3), m.index);
      const after = text.slice(m.index + value.length, m.index + value.length + 3);
      const body = rule.body(m);
      if (placeholderReason(value, body, before, after) !== null) continue;
      const hash10 = sha256Hex(rule.provider === "Private key" ? body : value).slice(0, 10);
      if (seen.has(hash10)) continue;
      seen.add(hash10);
      out.push({ provider: rule.provider, hash10, masked: rule.masked(m) });
    }
  }
  return out;
}

/** Replaces every key-shaped match (placeholder or not) with its masked prefix. */
export function scrubKeys(text: string): string {
  let t = text;
  for (const rule of KEY_RULES) {
    rule.re.lastIndex = 0;
    let out = "";
    let last = 0;
    for (let m = rule.re.exec(t); m !== null; m = rule.re.exec(t)) {
      out += t.slice(last, m.index) + rule.masked(m);
      last = m.index + m[0].length;
    }
    t = out + t.slice(last);
  }
  return t;
}

// ── Targets (what the source line shows) ─────────────────────────────────────────────────────

/** One safe line: control chars gone, whitespace collapsed, home → "~", keys masked, named and
 *  opaque credentials redacted, capped. */
export function safeTarget(raw: string, home: string, max = TARGET_MAX): string {
  let t = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (home.length > 1) t = t.split(home).join("~");
  t = redactCommand(scrubKeys(t)).trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** A tool name off the transcript, safe to show: word characters, dots, colons and dashes, ≤ 80. */
export function safeToolName(raw: string): string {
  return raw.replace(/[^\w.:-]+/g, "_").slice(0, 80) || "unknown";
}

/** The redacted path / command / url of a tool call ("" when it has none). */
export function callTarget(name: string, input: Record<string, unknown>, home: string): string {
  const raw = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? str(input.url) ?? (name === "Bash" ? str(input.command) : null) ?? "";
  return raw ? safeTarget(raw.slice(0, 4000), home) : "";
}

// ── (2) Broken builds ────────────────────────────────────────────────────────────────────────

// A build/test class only counts at the start of a simple command (line start, or after
// ; & | ( && ||), after optional NAME=value assignments and an optional `rtk ` / `rtk proxy `.
const CMD_START = String.raw`(?:^|[\n;&|(])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:rtk\s+(?:proxy\s+)?)?`;
const PM_FLAGS = String.raw`(?:\s+(?:-C|--prefix|--filter|--dir|-w|--workspace)\s+\S+|\s+--?[A-Za-z][\w-]*(?:=\S+)?)*`;
const RUNNER = String.raw`(?:npx\s+(?:--?[\w-]+\s+)*|bunx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+|(?:\./)?node_modules/\.bin/)?`;
const BUILD_RE = new RegExp(
  CMD_START +
    "(?:" +
    [
      String.raw`(?<pm>npm|pnpm|yarn|bun)${PM_FLAGS}\s+(?:run\s+)?(?<pmverb>build|test|typecheck|lint)\b`,
      String.raw`${RUNNER}(?<tool>tsc|vitest|jest)\b(?!\s+--?(?:version|v|help|h|init)\b)`,
      String.raw`(?:python3?\s+-m\s+)?(?<pytest>pytest)\b`,
      String.raw`${RUNNER}(?<pw>playwright)\s+test\b`,
      String.raw`${RUNNER}(?<next>next)\s+build\b`,
      String.raw`${RUNNER}(?<turbo>turbo)\s+(?:run\s+)?(?<turboverb>build|test|typecheck|lint)\b`,
      String.raw`(?<lang>cargo|go)\s+(?<langverb>build|test)\b`,
      String.raw`(?<make>make)\s+test\b`,
    ].join("|") +
    ")",
  "g",
);

/** The shell text that runs: heredoc bodies dropped, structure inside quotes and comments masked
 *  (tripwires-lib), so `echo "npm test"` or a script written through `cat <<EOF` never counts. */
function runnableShell(command: string): string {
  return maskShell(stripHeredocs(command));
}

function classOf(g: Record<string, string | undefined> | undefined): string | null {
  if (!g) return null;
  if (g.pm && g.pmverb) return `${g.pm} ${g.pmverb}`;
  if (g.tool) return g.tool;
  if (g.pytest) return "pytest";
  if (g.pw) return "playwright";
  if (g.next) return "next build";
  if (g.turbo && g.turboverb) return `turbo ${g.turboverb}`;
  if (g.lang && g.langverb) return `${g.lang} ${g.langverb}`;
  if (g.make) return "make test";
  return null;
}

/** Every build/test class a shell command runs ("tsc", "vitest", "npm test", "cargo test"…), in
 *  order, each once. */
export function buildClassesOf(command: string): string[] {
  const shell = runnableShell(command);
  const out: string[] = [];
  BUILD_RE.lastIndex = 0;
  for (let m = BUILD_RE.exec(shell); m !== null; m = BUILD_RE.exec(shell)) {
    const c = classOf(m.groups);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** The first build/test class a shell command runs, or null. */
export function buildClassOf(command: string): string | null {
  return buildClassesOf(command)[0] ?? null;
}

const TSC_FAILED = /\berror TS\d+/;
const TESTS_FAILED = /\bTests?(?: Files)?:?\s+[1-9]\d*\s+failed/;
const TEST_RUNNER = /^(?:vitest|jest|pytest|playwright|make test|(?:npm|pnpm|yarn|bun|turbo|cargo|go) test)$/;

/** Which class of a chained command failed: the one its failure text names (`error TS…` → tsc,
 *  `Tests N failed` → the test runner), else the first. `tsc | head; vitest run` failing on a
 *  test is vitest's failure, not tsc's. */
export function failingClass(classes: readonly string[], text: string): string | null {
  const tail = text.length > RESULT_TAIL_CHARS ? text.slice(-RESULT_TAIL_CHARS) : text;
  if (classes.includes("tsc") && TSC_FAILED.test(tail)) return "tsc";
  if (TESTS_FAILED.test(tail)) {
    const runner = classes.find((c) => TEST_RUNNER.test(c));
    if (runner) return runner;
  }
  return classes[0] ?? null;
}

/** Failure text a build prints even when its exit code is masked by a pipe. `EXIT=<n>` is the
 *  house `…; echo EXIT=$?` convention (LOOP.md rule 3), added to the spec's list: without it a
 *  redirected, failing tsc reads as a pass and would falsely heal its case. */
const FAILURE_MARKERS: readonly RegExp[] = [
  /Failed tasks:/,
  /\berror TS\d+/,
  /npm ERR!/,
  /ELIFECYCLE/,
  /exited with code [1-9]/,
  /Build failed/,
  /Command failed/,
  /\bEXIT=[1-9]\d*\b/,
];

/** A tool_result that is the harness speaking, not the command: a denial, an interrupt, a
 *  backgrounded or timed-out run. Its outcome is unknown, so it neither fails nor heals a build. */
const NOT_A_RUN =
  /^(?:\s*(?:The user doesn't want to proceed|User rejected|\[Request interrupted|Permission to use \S+ .*?(?:has been )?denied|Command running in background with ID|Command did not complete within|Command timed out|Tool permission request failed|Hook \S+ (?:denied|blocked)|PreToolUse:\S+ hook))/i;

export type BuildOutcome = "pass" | "fail";

const TEST_SUMMARY = /\bTests?(?: Files)?:?\s+(\d+)\s+(failed|passed)\b/g;

/** `Tests <n> failed`, judged on the LAST test summary in the output: a retry loop that prints
 *  "Tests 1 failed | 1750 passed" and then "Tests 1751 passed" ended green. */
export function lastTestSummaryFailed(tail: string): boolean {
  let last: RegExpExecArray | null = null;
  TEST_SUMMARY.lastIndex = 0;
  for (let m = TEST_SUMMARY.exec(tail); m !== null; m = TEST_SUMMARY.exec(tail)) last = m;
  return last !== null && last[2] === "failed" && Number(last[1]) > 0;
}

/** The build saying it passed. With no failure marker next to it, an is_error result belongs to a
 *  command AFTER the build: `vitest run > log; grep -E "Tests " log; grep FAIL log` exits 1 when
 *  the last grep finds no FAIL line (measured: 3 of 10 hand-checked chronic cases were this). */
const PASS_EVIDENCE: readonly RegExp[] = [/\bTests?(?: Files)?:?\s+\d+\s+passed\b/, /\bNo errors found\b/, /\bexit(?:\s+code)?\s*[:=]?\s*0\b/i];

/** fail: a failure marker in the last 20 KB of the output, or is_error without the build's own
 *  pass evidence; pass otherwise; null when the harness answered instead of the command (denied,
 *  interrupted, backgrounded, timed out). */
export function buildOutcome(isError: boolean, text: string, denied: boolean): BuildOutcome | null {
  if (denied || NOT_A_RUN.test(text.slice(0, 400))) return null;
  const tail = text.length > RESULT_TAIL_CHARS ? text.slice(-RESULT_TAIL_CHARS) : text;
  if (FAILURE_MARKERS.some((re) => re.test(tail)) || lastTestSummaryFailed(tail)) return "fail";
  if (isError) return PASS_EVIDENCE.some((re) => re.test(tail)) ? "pass" : "fail";
  return "pass";
}

// ── (3) Steering pages ───────────────────────────────────────────────────────────────────────

interface SteeringPattern {
  id: string;
  re: RegExp;
}

// VENDORED from ~/.claude/skills/ai-defence/scan.js (read 2026-09-28): the instruction_override,
// role_hijack, hidden_unicode and output_exfiltration patterns, ids and regexes verbatim. The
// encoded_payload and pii_leakage categories are left out on purpose.
const STEERING_PATTERNS: readonly SteeringPattern[] = [
  // 1. instruction_override
  { id: "io_001", re: /ignore\s+(all\s+|the\s+)?(previous|prior|above|preceding|earlier)\s+(instructions?|prompts?|rules?|directives?|context)/i },
  { id: "io_002", re: /disregard\s+(all\s+|the\s+)?(previous|prior|above|preceding|earlier)/i },
  { id: "io_003", re: /forget\s+(everything|all|previous|what\s+i\s+(told|said))/i },
  { id: "io_004", re: /(new|updated|revised)\s+(instructions?|directives?|rules?|system\s+prompt)/i },
  { id: "io_005", re: /do\s+not\s+follow\s+(the\s+)?(previous|above|prior|earlier)/i },
  { id: "io_006", re: /override\s+(default|prior|the)\s+(behavi(?:o|ou)r|risk\s+posture|instructions?|rules?)/i },
  { id: "io_007", re: /(^|\n)\s*(?:---+\s*)?(SYSTEM|system)\s*[:>]\s*(?!.*example)/m },
  { id: "io_008", re: /<\|?system\|?>|<\/?system>|\[system\]|\{system\}/i },
  { id: "io_009", re: /(reveal|show|print|output|leak)\s+(your|the)\s+(system\s+)?(prompt|instructions?|directives?)/i },
  { id: "io_010", re: /\b(pre[- ]?cleared|fast[- ]?track\s+approval|already\s+approved|skip\s+(the\s+)?(audit|review|check))/i },
  // 2. role_hijack
  { id: "rh_001", re: /you\s+are\s+now\s+(?!going|about|ready|in)/i },
  { id: "rh_002", re: /act\s+as\s+(if\s+you\s+(are|were)\s+)?a?\s*(different|new|another|unrestricted)/i },
  { id: "rh_003", re: /pretend\s+(to\s+be|you\s+are|that\s+you('re|\s+are))/i },
  { id: "rh_004", re: /\b(DAN|do\s+anything\s+now|STAN|AIM|BetterDAN|DUDE)\b/i },
  { id: "rh_005", re: /\b(developer|dev|debug|god|admin|sudo|root)\s+mode\b/i },
  { id: "rh_006", re: /\b(jailbreak|bypass\s+(your\s+)?(restrictions?|limitations?|filters?|safety)|disable\s+(your\s+)?(safety|content)\s+filter)\b/i },
  { id: "rh_007", re: /without\s+(any\s+)?(restrictions?|limitations?|rules?|filters?|guidelines?)/i },
  // 6. output_exfiltration
  { id: "oe_001", re: /(send|post|exfiltrate|upload|transmit)\s+(the\s+|your\s+)?(results?|output|response|data|content)\s+to\s+(https?:|ftp:|\/\/|[a-z0-9-]+\.[a-z]{2,})/i },
  { id: "oe_002", re: /!\[[^\]]*\]\(\s*javascript:/i },
  { id: "oe_003", re: /data:text\/html[;,]/i },
  { id: "oe_004", re: /!\[[^\]]*\]\(\s*https?:\/\/[^)]*\?[^)]*=\$\{?(prompt|secret|response|api_?key)/i },
  { id: "oe_005", re: /(curl|wget|fetch)\s+[-\w]*\s*['"]?https?:\/\/[^\s'"]+\?[^=\s]+=/i },
];
// 4. hidden_unicode (scan.js scans codepoints first, then runs the rest on an NFKC copy with them
// stripped, so zero-width characters can't split a phrase past the regexes).
const HIDDEN_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/; // hu_001
const HIDDEN_UNICODE_G = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u; // hu_002
const TAG_CHARS_G = /[\u{E0000}-\u{E007F}]/gu;

/** The ai-defence pattern ids a page's text matches, in bank order (hu_* first). */
export function steeringPatternIds(text: string): string[] {
  const t = text.length > WEB_SCAN_MAX_CHARS ? text.slice(0, WEB_SCAN_MAX_CHARS) : text;
  const ids: string[] = [];
  if (HIDDEN_UNICODE.test(t)) ids.push("hu_001");
  if (TAG_CHARS.test(t)) ids.push("hu_002");
  const normalized = t.normalize("NFKC").replace(HIDDEN_UNICODE_G, "").replace(TAG_CHARS_G, "");
  for (const p of STEERING_PATTERNS) if (p.re.test(normalized)) ids.push(p.id);
  return ids;
}

/** Lowercase hostname of an http(s) URL; null for anything else or a loopback host (this Mac's
 *  own servers are not the web). */
export function hostOfUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1" || host === "0.0.0.0") return null;
  return host.length > TARGET_MAX ? host.slice(0, TARGET_MAX) : host;
}

export const WELL_KNOWN_DOMAINS: readonly string[] = [
  "github.com", "anthropic.com", "claude.ai", "google.com", "openai.com", "stripe.com", "vercel.com", "cloudflare.com",
  "linear.app", "notion.so", "acme.ai", "posthog.com", "npmjs.com", "pypi.org", "apple.com", "microsoft.com",
];
/** Real sites within edit distance 2 of a well-known domain that are not lookalikes of it. */
const KNOWN_SIBLINGS: ReadonlySet<string> = new Set(["gitlab.com"]);

/** Levenshtein distance, stopping early once it exceeds `max`. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** host → [registrable domain, its second-level label] ("docs.a.co.uk" → ["a.co.uk", "a"]). */
function registrable(host: string): [string, string] {
  const labels = host.split(".");
  const n = labels.length;
  const twoLevel = n >= 3 && (labels[n - 1] ?? "").length === 2 && /^(co|com|net|org|gov|ac|edu)$/.test(labels[n - 2] ?? "");
  const take = twoLevel ? 3 : 2;
  const dom = labels.slice(-take).join(".");
  return [dom, labels[n - take] ?? dom];
}

/** raw-ip: a literal IPv4/IPv6 host. punycode: an xn-- label. lookalike: its registrable domain is
 *  within Levenshtein 2 of a well-known domain without being it or a subdomain of it (a brand's own
 *  other TLDs, same second-level label, and KNOWN_SIBLINGS are not lookalikes). */
export function hostFlags(host: string): HostFlag[] {
  const flags: HostFlag[] = [];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) flags.push("raw-ip");
  if (host.split(".").some((l) => l.startsWith("xn--"))) flags.push("punycode");
  if (!flags.includes("raw-ip")) {
    const [dom, sld] = registrable(host);
    const own = WELL_KNOWN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    if (!own && !KNOWN_SIBLINGS.has(dom)) {
      const look = WELL_KNOWN_DOMAINS.some((d) => registrable(d)[1] !== sld && levenshtein(dom, d, 2) <= 2);
      if (look) flags.push("lookalike");
    }
  }
  return flags;
}

const CURL_RE = new RegExp(CMD_START + String.raw`(?:curl|wget)\b`);
const URL_RE = /https?:\/\/[^\s'"<>`\\)]+/;

/** A web read, when this tool call fetches a page: its host (null when the call names none,
 *  e.g. a firecrawl search). null = not a web call (or only this Mac's own servers). */
export function webCallOf(name: string, input: Record<string, unknown>, obscuraHost: string | null): { host: string | null } | null {
  const firstUrl = (): string | null => {
    const u = str(input.url);
    if (u) return u;
    for (const k of ["urls", "ids"]) {
      const arr = input[k];
      if (Array.isArray(arr) && typeof arr[0] === "string") return arr[0];
    }
    return null;
  };
  const fromUrl = (url: string | null): { host: string | null } | null => {
    if (url === null) return { host: null };
    const host = hostOfUrl(url);
    return host === null && /^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(url) ? null : { host };
  };
  if (name === "WebFetch") return fromUrl(firstUrl());
  if (name.startsWith("mcp__exa__") && /fetch|crawl/i.test(name)) return fromUrl(firstUrl());
  if (name.startsWith("mcp__firecrawl")) return fromUrl(firstUrl());
  if (name === "mcp__obscura__browser_navigate") return fromUrl(firstUrl());
  if (/^mcp__obscura__browser_(?:markdown|snapshot|extract)$/.test(name)) return { host: obscuraHost };
  if (name === "Bash") {
    const cmd = str(input.command);
    if (!cmd) return null;
    const shell = runnableShell(cmd);
    const at = shell.search(CURL_RE);
    if (at === -1) return null;
    const m = URL_RE.exec(shell.slice(at));
    if (!m) return null;
    const host = hostOfUrl(m[0]);
    return host === null ? null : { host };
  }
  return null;
}

// ── Line scanner ─────────────────────────────────────────────────────────────────────────────

/** What we remember about one tool call until its result arrives. Already redacted. */
export interface CallInfo {
  name: string;
  target: string;
  /** Set on a build/test Bash call: every class it runs, in order (cleared once its result is paired). */
  buildClasses?: string[];
  /** Set on a web read (cleared once its result is scanned). */
  web?: { host: string | null };
  /** A tool that returns third-party web content (a page, search results, a browser's network
   *  log, curl/wget to a remote host). Its result is not scanned for keys: a key-shaped string in
   *  someone else's page (a site's public Maps key) is not a leak of ours. */
  ext?: true;
}

const EXTERNAL_TOOL = /^(?:WebFetch|WebSearch|mcp__exa__|mcp__firecrawl|mcp__obscura__)/;

/** Per-transcript memory carried between lines (and ticks). */
export interface FileScanState {
  /** tool_use id → call, insertion-ordered, capped at CALLS_CAP. */
  calls: Map<string, CallInfo>;
  /** Host of the last mcp__obscura__browser_navigate (its markdown/snapshot/extract read that page). */
  obscuraHost: string | null;
}

export function newFileScanState(): FileScanState {
  return { calls: new Map(), obscuraHost: null };
}

interface EventBase {
  /** Transcript time (ISO). */
  at: string;
  /** Byte offset of the line in its transcript (idempotence: a line applies to a case once). */
  offset: number;
  source: SicknessSource;
}
export type SicknessEvent =
  | (EventBase & { kind: "leaked-key"; key: KeyHit; vector: LeakVector })
  | (EventBase & { kind: "broken-build"; cmdClass: string; outcome: BuildOutcome })
  | (EventBase & { kind: "steering-page"; host: string | null; patternIds: string[]; hostFlags: HostFlag[] });

export interface ScanOptions {
  home: string;
  /** Used when a line has no timestamp. */
  fallbackAt: string;
}

/** Text of a tool_result's content (string, or the text blocks of an array). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) if (isRecord(b) && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  return parts.join("\n");
}

/** Written-by-the-agent text of a tool call: Write content, Edit/MultiEdit new text, a Bash command. */
function writtenText(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return str(input.command) ?? "";
  if (name === "Write") return str(input.content) ?? "";
  if (name === "Edit") return str(input.new_string) ?? "";
  if (name === "NotebookEdit") return str(input.new_source) ?? "";
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.map((e) => (isRecord(e) ? (str(e.new_string) ?? "") : "")).join("\n");
  }
  return "";
}

function remember(state: FileScanState, id: string, info: CallInfo): void {
  state.calls.delete(id);
  state.calls.set(id, info);
  while (state.calls.size > CALLS_CAP) {
    const oldest = state.calls.keys().next().value;
    if (oldest === undefined) break;
    state.calls.delete(oldest);
  }
}

function hasAny(raw: string | Buffer, needles: readonly string[]): boolean {
  return needles.some((n) => raw.includes(n));
}

/** Events in one raw transcript line. Cheap substring checks run before any JSON.parse: a line
 *  is parsed only when it may carry a key, is an assistant tool call, or answers a pending build
 *  or web call. Updates `state` (remembered calls, the obscura page). */
export function scanLine(state: FileScanState, raw: string | Buffer, offset: number, opts: ScanOptions): SicknessEvent[] {
  let keyCandidate = false;
  let text: string | null = null;
  const asText = (): string => (text ??= typeof raw === "string" ? raw : raw.toString("utf8"));
  if (hasAny(raw, KEY_PREFILTER)) {
    const t = asText();
    keyCandidate = KEY_RULES.some((r) => {
      r.re.lastIndex = 0;
      return r.re.test(t);
    });
  }
  const toolUse = raw.includes('"tool_use"');
  let answersPending = false;
  if (!keyCandidate && !toolUse && raw.includes('"tool_result"')) {
    for (const [id, c] of state.calls) {
      if ((c.buildClasses || c.web) && raw.includes(id)) {
        answersPending = true;
        break;
      }
    }
  }
  if (!keyCandidate && !toolUse && !answersPending) return [];

  let obj: unknown;
  try {
    obj = JSON.parse(asText());
  } catch {
    return [];
  }
  if (!isRecord(obj) || !isRecord(obj.message) || !Array.isArray(obj.message.content)) return [];
  const at = str(obj.timestamp) ?? opts.fallbackAt;
  const blocks = obj.message.content;
  const events: SicknessEvent[] = [];
  const keyEvents = (from: string, vector: LeakVector, source: SicknessSource): void => {
    for (const key of findKeys(from)) events.push({ kind: "leaked-key", at, offset, source, key, vector });
  };

  if (obj.type === "assistant") {
    for (const b of blocks) {
      if (!isRecord(b)) continue;
      if (b.type === "tool_use" && typeof b.name === "string") {
        const input = isRecord(b.input) ? b.input : {};
        const info: CallInfo = { name: safeToolName(b.name), target: callTarget(b.name, input, opts.home) };
        if (b.name === "Bash" && input.run_in_background !== true) {
          const classes = buildClassesOf(str(input.command) ?? "");
          if (classes.length > 0) info.buildClasses = classes;
        }
        const web = webCallOf(b.name, input, state.obscuraHost);
        if (web) {
          info.web = web;
          if (b.name === "mcp__obscura__browser_navigate") state.obscuraHost = web.host;
        }
        if (web || EXTERNAL_TOOL.test(b.name)) info.ext = true;
        if (typeof b.id === "string") remember(state, b.id, info);
        if (keyCandidate) {
          const written = writtenText(b.name, input);
          if (written) keyEvents(written, "written", { tool: info.name, target: info.target });
        }
      } else if (b.type === "text" && keyCandidate && typeof b.text === "string") {
        keyEvents(b.text, "echoed", { tool: "assistant", target: "reply text" });
      }
    }
    return events;
  }

  if (obj.type !== "user") return events;
  const denied = typeof obj.toolDenialKind === "string";
  for (const b of blocks) {
    if (!isRecord(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
    const call = state.calls.get(b.tool_use_id);
    const needsText = keyCandidate || call?.buildClasses !== undefined || call?.web !== undefined;
    if (!needsText) continue;
    const content = resultText(b.content);
    const source: SicknessSource = call ? { tool: call.name, target: call.target } : { tool: "unknown", target: "" };
    if (keyCandidate && !call?.ext) keyEvents(content, "read into context", source);
    if (call?.buildClasses) {
      const outcome = buildOutcome(b.is_error === true, content, denied);
      if (outcome) {
        // A pass passes every class the command ran; a failure is charged to the one that failed.
        const classes = outcome === "fail" ? [failingClass(call.buildClasses, content)] : call.buildClasses;
        for (const cls of classes) if (cls) events.push({ kind: "broken-build", at, offset, source: { tool: call.name, target: cls }, cmdClass: cls, outcome });
      }
      delete call.buildClasses;
    }
    if (call?.web) {
      const ids = b.is_error === true ? [] : steeringPatternIds(content);
      if (ids.length > 0) {
        const host = call.web.host;
        events.push({
          kind: "steering-page",
          at,
          offset,
          source: { tool: call.name, target: host ?? "" },
          host,
          patternIds: ids,
          hostFlags: host ? hostFlags(host) : [],
        });
      }
      delete call.web;
    }
  }
  return events;
}

// ── Case book ────────────────────────────────────────────────────────────────────────────────

export interface AgentRef {
  sessionId: string;
  subagentId: string | null;
  /** The transcript the case is fed from (one case = one transcript). */
  file: string;
}

export interface Place {
  lineage: string | null;
  district: string | null;
}

/** One persisted line of data/sickness.jsonl: the case, the byte offset of the last transcript
 *  line applied to it (a replayed line at or before it is a no-op) and its transcript. */
export interface StoredCase {
  c: SicknessCase;
  o: number;
  f: string;
}

const PATTERN_IDS_CAP = 24;

function labelFor(c: Pick<SicknessCase, "kind" | "state" | "detail" | "source">): string {
  if (c.kind === "steering-page") return STEERING_LABEL;
  if (c.kind === "broken-build") {
    const cls = c.detail.cmdClass ?? "build";
    if (c.state === "healed") return `${cls} failed, then passed`;
    if (c.state === "chronic") return `${cls} still failing when the transcript went quiet`;
    return `${cls} failing`;
  }
  const who = c.detail.provider ?? "API";
  if (c.detail.vector === "echoed") return `${who} key echoed in the assistant's reply`;
  if (c.detail.vector === "written") return `${who} key written by ${c.source.tool}`;
  return c.source.tool === "unknown" ? `${who} key read into context by a tool call` : `${who} key read into context by ${c.source.tool}`;
}

function thingOf(ev: SicknessEvent): string {
  if (ev.kind === "leaked-key") return `${ev.key.hash10}\u0000${ev.vector}`;
  if (ev.kind === "broken-build") return ev.cmdClass;
  return ev.host ?? `tool:${ev.source.tool}`;
}

function union<T>(a: readonly T[] | undefined, b: readonly T[], cap: number): T[] {
  const out = [...(a ?? [])];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out.slice(0, cap);
}

/** The state a case had before a treatment covered it ("treated" is only ever derived: a leak
 *  stays open, a page stays exposed, a build was failing when it was treated). */
export function rawState(c: Pick<SicknessCase, "kind" | "state">): SicknessState {
  if (c.state !== "treated") return c.state;
  return c.kind === "steering-page" ? "exposed" : "open";
}

/** A sick case whose newest evidence is at or before its treatment is "treated"; evidence newer
 *  than the treatment reopens it. Healed stays healed (a later run passed, whatever was clicked). */
export function treatedState(raw: SicknessState, lastSeenAt: string, t: SicknessTreatment | null): SicknessState {
  if (!t || !(SICK_STATES as readonly string[]).includes(raw)) return raw;
  const seen = Date.parse(lastSeenAt);
  const at = Date.parse(t.at);
  return Number.isFinite(seen) && Number.isFinite(at) && seen <= at ? "treated" : raw;
}

/** Folds detector events into cases, one per (kind, agent, thing). Idempotent per transcript line.
 *  Treatments (Alex's "Mark treated" clicks) are kept by case id beside the cases, so they
 *  outlive a bank-version rescan: a case rebuilt from its transcript gets its treatment back. */
export class CaseBook {
  private readonly cases = new Map<string, StoredCase>();
  private readonly treatments = new Map<string, SicknessTreatment>();

  constructor(entries: Iterable<StoredCase> = []) {
    for (const e of entries) this.cases.set(e.c.id, e);
  }

  /** Every recorded treatment (for a full log rewrite). */
  treatmentEntries(): Array<[string, SicknessTreatment]> {
    return [...this.treatments.entries()];
  }

  treatmentOf(id: string): SicknessTreatment | null {
    return this.treatments.get(id) ?? null;
  }

  /** Puts a persisted treatment back (boot fold). Its case, if present, is not re-derived: the
   *  case line already carries its state as it was served. */
  restoreTreatment(id: string, t: SicknessTreatment): void {
    this.treatments.set(id, t);
  }

  /** Records a treatment (replacing an older one) and re-derives the case. Null for an unknown
   *  id. The treatment is kept even when newer evidence leaves the case sick. */
  treat(id: string, t: SicknessTreatment): SicknessCase | null {
    const s = this.cases.get(id);
    if (!s) return null;
    this.treatments.set(id, t);
    return this.put({ ...s.c, state: rawState(s.c) }, s.o, s.f);
  }

  /** Undoes treat() when its log line could not be written: puts the previous treatment (or none)
   *  back and re-derives the case as it is NOW, so an event applied meanwhile is kept. A chronic
   *  build comes back as open (sweepChronic re-marks it on the next tick). */
  untreat(id: string, prevTreatment: SicknessTreatment | null): SicknessCase | null {
    if (prevTreatment) this.treatments.set(id, prevTreatment);
    else this.treatments.delete(id);
    const s = this.cases.get(id);
    return s ? this.put({ ...s.c, state: rawState(s.c) }, s.o, s.f) : null;
  }

  get size(): number {
    return this.cases.size;
  }

  get(id: string): SicknessCase | undefined {
    return this.cases.get(id)?.c;
  }

  /** The stored form (case + last applied line offset + transcript). */
  entry(id: string): StoredCase | undefined {
    return this.cases.get(id);
  }

  /** Puts a case back as it was persisted (boot fold). */
  restore(s: StoredCase): void {
    this.cases.set(s.c.id, s);
  }

  all(): SicknessCase[] {
    return [...this.cases.values()].map((s) => s.c);
  }

  stored(): StoredCase[] {
    return [...this.cases.values()];
  }

  /** Applies one event. Returns the case when it changed (created or updated), else null. */
  apply(ev: SicknessEvent, agent: AgentRef, place: () => Place): SicknessCase | null {
    const id = caseId(ev.kind, agent.sessionId, agent.subagentId, thingOf(ev));
    const prev = this.cases.get(id);
    if (prev && ev.offset <= prev.o) return null; // this line (or an earlier one) was applied already

    if (ev.kind === "broken-build") {
      if (!prev) {
        if (ev.outcome === "pass") return null; // a pass with no failure before it: nothing is sick
        return this.put({ ...this.fresh(id, ev, agent, place()), state: "open" }, ev.offset, agent.file);
      }
      const c = { ...prev.c, state: rawState(prev.c) };
      if (ev.outcome === "fail") {
        return this.put({ ...c, state: "open", healedAt: null, occurrences: c.occurrences + 1, lastSeenAt: ev.at }, ev.offset, agent.file);
      }
      if (c.state === "open" || c.state === "chronic") return this.put({ ...c, state: "healed", healedAt: ev.at, lastSeenAt: ev.at }, ev.offset, agent.file);
      prev.o = ev.offset; // an extra pass on a healed case: no change to serve, but remember the line
      return null;
    }

    if (!prev) {
      const state: SicknessState = ev.kind === "steering-page" ? "exposed" : "open";
      return this.put({ ...this.fresh(id, ev, agent, place()), state }, ev.offset, agent.file);
    }
    const c = { ...prev.c, state: rawState(prev.c) };
    const detail = ev.kind === "steering-page" ? { ...c.detail, patternIds: union(c.detail.patternIds, ev.patternIds, PATTERN_IDS_CAP), hostFlags: union(c.detail.hostFlags, ev.hostFlags, 3) } : c.detail;
    return this.put({ ...c, detail, occurrences: c.occurrences + 1, lastSeenAt: ev.at > c.lastSeenAt ? ev.at : c.lastSeenAt }, ev.offset, agent.file);
  }

  /** open broken-build cases whose transcript is fully read and quiet for CHRONIC_QUIET_MS → chronic. */
  sweepChronic(fileOf: (path: string) => { atEof: boolean; mtimeMs: number } | null, nowMs: number): SicknessCase[] {
    const changed: SicknessCase[] = [];
    for (const s of this.cases.values()) {
      if (s.c.kind !== "broken-build" || s.c.state !== "open") continue;
      const f = fileOf(s.f);
      if (!f || !f.atEof || nowMs - f.mtimeMs < CHRONIC_QUIET_MS) continue;
      const c = this.put({ ...s.c, state: "chronic" }, s.o, s.f);
      if (c) changed.push(c);
    }
    return changed;
  }

  private fresh(id: string, ev: SicknessEvent, agent: AgentRef, place: Place): SicknessCase {
    const detail =
      ev.kind === "leaked-key"
        ? { provider: ev.key.provider, hash10: ev.key.hash10, masked: ev.key.masked, vector: ev.vector }
        : ev.kind === "broken-build"
          ? { cmdClass: ev.cmdClass }
          : { host: ev.host, patternIds: ev.patternIds.slice(0, PATTERN_IDS_CAP), hostFlags: ev.hostFlags };
    return {
      id,
      kind: ev.kind,
      state: "open",
      sessionId: agent.sessionId,
      subagentId: agent.subagentId,
      lineage: place.lineage,
      district: place.district,
      label: "",
      source: ev.source,
      detail,
      firstSeenAt: ev.at,
      lastSeenAt: ev.at,
      occurrences: 1,
      healedAt: null,
    };
  }

  /** Stores a case with its treatment attached and its state derived from it (treatedState). */
  private put(c: SicknessCase, o: number, f: string): SicknessCase {
    const treatment = this.treatments.get(c.id) ?? null;
    const state = treatedState(c.state, c.lastSeenAt, treatment);
    const derived = { ...c, state, treatment };
    const withLabel = { ...derived, label: labelFor(derived) };
    this.cases.set(c.id, { c: withLabel, o, f });
    return withLabel;
  }
}

// ── Persistence format (data/sickness.jsonl) ─────────────────────────────────────────────────

/** First line of data/sickness.jsonl. */
export interface SicknessFileHeader {
  v: number;
}

/** A "Mark treated" event line of data/sickness.jsonl, appended once per click that changed
 *  something. Never removed: a compaction rewrites every treatment the book holds. */
export interface TreatmentLine {
  t: { id: string } & SicknessTreatment;
}

export function treatmentLine(id: string, t: SicknessTreatment): TreatmentLine {
  return { t: { id, by: t.by, at: t.at } };
}

function isStoredCase(v: unknown): v is StoredCase {
  if (!isRecord(v) || typeof v.o !== "number" || typeof v.f !== "string" || !isRecord(v.c)) return false;
  const c = v.c;
  return (
    typeof c.id === "string" &&
    typeof c.kind === "string" &&
    (SICKNESS_KINDS as readonly string[]).includes(c.kind) &&
    typeof c.state === "string" &&
    (SICKNESS_STATES as readonly string[]).includes(c.state) &&
    typeof c.sessionId === "string" &&
    isRecord(c.source) &&
    isRecord(c.detail)
  );
}

/** Folds the append-only log by case id (the last line wins), and its treatment events by case
 *  id (the last one wins). Garbled lines are skipped. */
export function foldCaseLog(text: string): { version: number | null; cases: Map<string, StoredCase>; treatments: Map<string, SicknessTreatment>; garbled: number } {
  const cases = new Map<string, StoredCase>();
  const treatments = new Map<string, SicknessTreatment>();
  let version: number | null = null;
  let garbled = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      garbled++;
      continue;
    }
    if (isRecord(v) && typeof v.v === "number" && !("c" in v)) {
      if (version === null) version = v.v;
      continue;
    }
    if (isRecord(v) && isRecord(v.t) && typeof v.t.id === "string" && v.t.id.length > 0 && isSicknessTreatment(v.t)) {
      treatments.set(v.t.id, { by: v.t.by, at: v.t.at });
      continue;
    }
    if (isStoredCase(v)) cases.set(v.c.id, v);
    else garbled++;
  }
  return { version, cases, treatments, garbled };
}

// ── Views ────────────────────────────────────────────────────────────────────────────────────

/** Kinds that may be served (DISABLED_KINDS withheld). */
export function servable(c: SicknessCase, disabled: ReadonlySet<SicknessKind> = DISABLED_KINDS): boolean {
  return !disabled.has(c.kind);
}

export function isSick(c: SicknessCase): boolean {
  return (SICK_STATES as readonly string[]).includes(c.state);
}

export function newestFirst(a: SicknessCase, b: SicknessCase): number {
  return a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : a.id < b.id ? -1 : 1;
}

export function countCases(cases: readonly SicknessCase[]): SicknessCounts {
  const byKind = Object.fromEntries(SICKNESS_KINDS.map((k) => [k, 0])) as Record<SicknessKind, number>;
  const byState = Object.fromEntries(SICKNESS_STATES.map((s) => [s, 0])) as Record<SicknessState, number>;
  const byLineage: Record<string, number> = {};
  for (const c of cases) {
    byKind[c.kind]++;
    byState[c.state]++;
    const l = c.lineage ?? "(none)";
    byLineage[l] = (byLineage[l] ?? 0) + 1;
  }
  return { total: cases.length, byKind, byState, byLineage };
}

/** Sick agents for the snapshot: shared/features/sickness.ts, so the client groups its live list the same way. */
export { openEntries };
