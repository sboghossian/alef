// Pure half of the "tripwires" feature (no fs, no network): compile the rule definitions
// (tripwires-defs.ts), normalize a shell command so a rule sees commands and not text that merely
// mentions them, evaluate one tool call, and keep the per-session dedupe + "did it happen earlier
// in this session" memory. server/features/tripwires.ts feeds it the indexer's new lines.
//
// Everything here reads untrusted transcript text. It is matched against regexes, never executed.

import { posix } from "node:path";
import { isTripwireHit, TRIPWIRES_HIT_CAP, type LessonSourceCount, type LessonSourceId, type TripwireCoverage, type TripwireHit, type TripwireRuleView, type TripwireSeverity } from "../../shared/features/tripwires.js";
import { redactCommand } from "../activity.js";
import { parseLine, type ToolUse } from "../jsonl-events.js";

/** One lesson, as a rule. Regexes are JS regex sources; see tripwires-defs.ts for the house style. */
export interface TripwireDef {
  /** Stable, kebab-case. Part of the dedupe key. */
  id: string;
  /** One line a person reads: what the lesson is. */
  lesson: string;
  /** Where the lesson was learned (file + date). */
  source: string;
  /** Day the lesson was recorded (YYYY-MM-DD); hits before it predate the lesson. */
  since: string;
  severity: TripwireSeverity;
  /** Regex over the tool name, e.g. "^Bash$". */
  tool: string;
  /** Input field matched (default "command"); "*" matches the input as JSON. */
  field?: string;
  /** Regexes over the normalized text; the first that matches is the hit. */
  match: readonly string[];
  /** Flags for `match` and `allow` (default ""). Never "g" or "y": the matcher adds what it needs. */
  flags?: string;
  /** Regexes tested against the matched text (through to the end of its simple command); any
   *  match drops the hit (e.g. an `rtk proxy` prefix). */
  allow?: readonly string[];
  /** Only the command line as typed: never the body of a `bash -c '…'` / `sh -c "…"` it runs. For
   *  lessons about the RTK hook's rewrite, which never reaches inside such a body. */
  topLevelOnly?: boolean;
  /** Regex over the directory the matched command runs in, as "~/…" (last `cd`, `git -C`, or the
   *  session cwd). The rule only fires when this matches; an unresolvable dir ("$VAR") never does. */
  inDirs?: string;
  /** The hit is dropped when an EARLIER tool call or user message in the same session matched one. */
  unlessEarlier?: readonly EarlierRule[];
}

/** Evidence earlier in the session that makes a hit moot (e.g. a review before a merge). */
export interface EarlierRule {
  /** Regex over an earlier tool call's name. */
  tool?: string;
  /** Regex (case-insensitive) over that call's input as JSON. */
  input?: string;
  /** Regex (case-insensitive) over an earlier prompt Alex typed (see `userLineKind`: never a
   *  skill body, a relayed message, a task notification or a subagent's prompt). */
  userText?: string;
  /** When the evidence stops counting (default: the rest of the session). Either way it ends at a
   *  new run (a scheduled turn or a slash command, see `userLineKind`).
   *  - "match": each piece of evidence covers ONE later match of this rule (one review, one merge);
   *  - "reply": it covers every match until Alex's next prompt after one of them ("merge both"
   *    covers both merges; "??" before any merge keeps it). */
  until?: "match" | "reply";
}

export interface CompiledTripwire {
  def: TripwireDef;
  tool: RegExp;
  field: string;
  match: RegExp[];
  allow: RegExp[];
  inDirs: RegExp | null;
  earlier: Array<{ tool: RegExp | null; input: RegExp | null; userText: RegExp | null; until: EarlierRule["until"] | null }>;
}

/** Compiles every rule; throws on a bad regex or a duplicate id (the defs test runs this). */
export function compileTripwires(defs: readonly TripwireDef[]): CompiledTripwire[] {
  const ids = new Set<string>();
  return defs.map((def) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) throw new Error(`tripwire id must be kebab-case: ${def.id}`);
    if (ids.has(def.id)) throw new Error(`duplicate tripwire id: ${def.id}`);
    ids.add(def.id);
    const flags = (def.flags ?? "").replace(/[gy]/g, "");
    if (def.match.length === 0) throw new Error(`tripwire ${def.id} has no match rule`);
    return {
      def,
      tool: new RegExp(def.tool),
      field: def.field ?? "command",
      match: def.match.map((s) => new RegExp(s, flags)),
      allow: (def.allow ?? []).map((s) => new RegExp(s, flags)),
      inDirs: def.inDirs ? new RegExp(def.inDirs) : null,
      earlier: (def.unlessEarlier ?? []).map((e) => ({
        tool: e.tool ? new RegExp(e.tool) : null,
        input: e.input ? new RegExp(e.input, "i") : null,
        userText: e.userText ? new RegExp(e.userText, "i") : null,
        until: e.until ?? null,
      })),
    };
  });
}

export function ruleViews(tws: readonly CompiledTripwire[]): TripwireRuleView[] {
  return tws.map(({ def }) => ({ id: def.id, lesson: def.lesson, severity: def.severity, source: def.source }));
}

// ── Shell text normalization ────────────────────────────────────────────────────────────────

const HEREDOC_OP = /^<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/;

/** Index of the newline that ends heredoc `delim`'s closing line, the body starting at `from`
 *  (the end of the text when it is never closed). */
function heredocEnd(cmd: string, from: number, delim: string, tabs: boolean): number {
  let i = from;
  while (i < cmd.length) {
    const next = cmd.indexOf("\n", i);
    const line = cmd.slice(i, next === -1 ? cmd.length : next);
    if ((tabs ? line.replace(/^\t+/, "") : line).trimEnd() === delim) return next === -1 ? cmd.length : next;
    if (next === -1) break;
    i = next + 1;
  }
  return cmd.length;
}

/** Drops heredoc bodies (`<<'EOF' … EOF`): text written INTO a file or a script is not a command
 *  this shell runs. The `<<EOF` operator and the rest of its line stay. Only a real operator opens
 *  one: not a `<<<` here-string, and not a `<<EOF` inside quotes or a `#` comment (a commit message
 *  that mentions heredocs). Quotes are tracked like maskShell does, so the usual
 *  `"$(cat <<'EOF' … EOF\n)"` commit message is still a heredoc. Several on one line run in order. */
export function stripHeredocs(cmd: string): string {
  const stack: Array<"s" | "d" | "sub" | "par"> = [];
  const pending: Array<{ delim: string; tabs: boolean }> = [];
  let out = "";
  let pos = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const cur = stack[stack.length - 1];
    if (cur === "s") {
      if (c === "'") stack.pop();
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (cur === "d") {
      if (c === '"') stack.pop();
      else if (c === "$" && cmd[i + 1] === "(") {
        stack.push("sub");
        i++;
      }
      continue;
    }
    if (c === "'") stack.push("s");
    else if (c === '"') stack.push("d");
    else if (c === "$" && cmd[i + 1] === "(") {
      stack.push("sub");
      i++;
    } else if (c === "(") stack.push("par");
    else if (c === ")") {
      if (cur === "sub" || cur === "par") stack.pop();
    } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]!))) {
      const nl = cmd.indexOf("\n", i);
      i = (nl === -1 ? cmd.length : nl) - 1;
    } else if (c === "<" && cmd[i + 1] === "<") {
      if (cmd[i + 2] === "<") {
        i += 2; // `<<<` here-string: no body
        continue;
      }
      const m = HEREDOC_OP.exec(cmd.slice(i, i + 256));
      if (m) {
        pending.push({ delim: m[3]!, tabs: m[1] === "-" });
        i += m[0].length - 1;
      } else i++;
    } else if (c === "\n" && pending.length) {
      let end = i;
      for (const h of pending.splice(0)) end = heredocEnd(cmd, end + 1, h.delim, h.tabs);
      out += cmd.slice(pos, i);
      pos = end;
      i = end - 1;
    }
  }
  return out + cmd.slice(pos);
}

/** Same length as `cmd`: shell structure inside quotes (`\n ; & | ( )`) and whole `#` comments
 *  become spaces, and so does the `&` of `2>&1` / `&>`. A `$(…)` inside double quotes is a real
 *  command again, so its structure is kept. A rule's "one simple command" class (`[^\n;&|]`) and
 *  its command-position anchor therefore only ever see real shell structure. */
export function maskShell(cmd: string): string {
  const out = cmd.split("");
  // "s" single quotes, "d" double quotes, "sub" $( … ), "par" a ( … ) subshell.
  const stack: Array<"s" | "d" | "sub" | "par"> = [];
  const QUOTED = "\n;&|()";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const cur = stack[stack.length - 1];
    if (cur === "s") {
      if (c === "'") stack.pop();
      else if (QUOTED.includes(c)) out[i] = " ";
      continue;
    }
    if (c === "\\") {
      // An escaped char is never structure: `\|` inside a grep pattern, a `\⏎` continuation.
      if (QUOTED.includes(cmd[i + 1] ?? "")) out[i + 1] = " ";
      i++;
      continue;
    }
    if (cur === "d") {
      if (c === '"') stack.pop();
      else if (c === "$" && cmd[i + 1] === "(") {
        stack.push("sub");
        i++;
      } else if (QUOTED.includes(c)) out[i] = " ";
      continue;
    }
    if (c === "'") stack.push("s");
    else if (c === '"') stack.push("d");
    else if (c === "$" && cmd[i + 1] === "(") {
      stack.push("sub");
      i++;
    } else if (c === "(") stack.push("par");
    else if (c === ")") {
      if (cur === "sub" || cur === "par") stack.pop();
    } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]!))) {
      while (i < cmd.length && cmd[i] !== "\n") out[i++] = " ";
      i--;
    } else if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) out[i] = " ";
  }
  return out.join("");
}

// ── Where a command runs ────────────────────────────────────────────────────────────────────

const CD_RE = /(?:^|[\n;&|(])\s*(?:cd|pushd)\s+/g;

function readWord(text: string, at: number): string {
  const c = text[at];
  if (c === '"' || c === "'") {
    const end = text.indexOf(c, at + 1);
    return end === -1 ? text.slice(at + 1) : text.slice(at + 1, end);
  }
  const m = /^[^\s;&|)]+/.exec(text.slice(at));
  return m ? m[0] : "";
}

/** A path word as an absolute path; null when it depends on a variable (or on an unknown `base`). */
function absDir(word: string, base: string | null, home: string): string | null {
  let p = word.trim();
  if (!p || p === "-") return null;
  p = p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (/[$`*?]/.test(p) || p.startsWith("~")) return null;
  if (!posix.isAbsolute(p)) {
    if (base === null || !posix.isAbsolute(base)) return null;
    p = posix.join(base, p);
  }
  return posix.normalize(p).replace(/\/+$/, "") || "/";
}

function homeRelative(p: string, home: string): string {
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** A path word as "~/…" (home-relative) or absolute; null when it depends on a variable. */
export function resolveDir(word: string, cwd: string, home: string): string | null {
  const p = absDir(word, cwd, home);
  return p === null ? null : homeRelative(p, home);
}

/** The directory the command at `index` runs in: its own `git -C <dir>`, else the session cwd as
 *  moved by every `cd` / `pushd` before it that is still in effect. A `cd` inside a `( … )` or
 *  `$( … )` that closed before `index` no longer is, and a relative target resolves against where
 *  the previous `cd` left the shell. `masked` locates structure, `text` supplies the words. */
export function effectiveDir(text: string, masked: string, index: number, matched: string, cwd: string, home: string): string | null {
  const cds: number[] = [];
  CD_RE.lastIndex = 0;
  const before = masked.slice(0, index);
  let m: RegExpExecArray | null;
  while ((m = CD_RE.exec(before)) !== null) cds.push(m.index + m[0].length);
  let dir = absDir(cwd, "/", home);
  const saved: Array<string | null> = [];
  for (let i = 0, k = 0; i < index; i++) {
    const c = masked[i];
    if (c === "(") saved.push(dir);
    else if (c === ")" && saved.length) dir = saved.pop()!;
    if (cds[k] === i) {
      dir = absDir(readWord(text, i), dir, home);
      k++;
    }
  }
  const gitC = /\bgit\s+-C\s+/.exec(masked.slice(index, index + matched.length));
  if (gitC) dir = absDir(readWord(text, index + gitC.index + gitC[0].length), dir, home);
  return dir === null ? null : homeRelative(dir, home);
}

// ── Snippets ────────────────────────────────────────────────────────────────────────────────

export const SNIPPET_MAX = 120;

/** One safe line for the UI / journal: control chars gone, whitespace collapsed, secrets
 *  redacted (named credentials, auth headers, opaque tokens), capped at SNIPPET_MAX. */
export function sanitizeSnippet(raw: string, max = SNIPPET_MAX): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const red = redactCommand(flat).trim();
  return red.length > max ? `${red.slice(0, max - 1).trimEnd()}…` : red;
}

/** The matched command, from its first real character to the end of the simple command it
 *  started in (capped), taken from the unmasked text so quotes read as typed. */
function snippetAt(text: string, masked: string, index: number, length: number): string {
  let start = index;
  while (start < index + length && /[\s\n;&|(]/.test(masked[start] ?? "")) start++;
  let end = index + length;
  while (end < masked.length && end - start < SNIPPET_MAX * 2 && !"\n;&|".includes(masked[end]!)) end++;
  return sanitizeSnippet(text.slice(start, end));
}

// ── Evaluation ──────────────────────────────────────────────────────────────────────────────

/** Per-session "earlier" evidence, one entry per unlessEarlier rule seen. */
export interface SessionMemory {
  /** Evidence key (`${tripwireId}#${ruleIndex}`) → how many later matches it still covers
   *  (Infinity for evidence that isn't counted). */
  credits: Map<string, number>;
  /** "reply" evidence a match has used: it ends at the next prompt. */
  spent: Set<string>;
}

export function newSessionMemory(): SessionMemory {
  return { credits: new Map(), spent: new Set() };
}

/** Text longer than this is cut before matching (after heredoc bodies are dropped): every rule
 *  runs on the event loop, so a pathological command must stay cheap. The cut changed no match
 *  over 7 days of real transcripts (47k tool calls). */
export const MAX_MATCH_CHARS = 16 * 1024;

/** What one user-text transcript line is, for "earlier in the session" evidence:
 *  - "human": a prompt Alex typed (or a headless run's prompt): it may carry a go-ahead;
 *  - "turn": a new run nobody typed just now (a slash command's `<command-…>` wrapper, a
 *    scheduled /loop iteration): it ends all scoped evidence and carries none itself;
 *  - "other": text injected into a turn (a skill body or other isMeta line, a message another
 *    session sent, a task notification, command output, a compaction summary): never evidence.
 *  Newer transcripts say it outright (`turnOrigin`); older ones are read from the text. */
export type UserLineKind = "human" | "turn" | "other";

const INJECTED_PREFIXES = ["Another Claude session sent a message", "Base directory for this skill", "This session is being continued", "Caveat:", "[Request interrupted", "# /"];

export function userLineKind(raw: string, text: string): UserLineKind {
  if (raw.includes('"isMeta":true')) return "other";
  const t = text.trimStart();
  if (/^<(?:command-(?:name|message|args)|scheduled-task)\b/.test(t)) return "turn";
  const origin = /"turnOrigin":"([a-z_]+)"/.exec(raw)?.[1];
  if (origin === "human" || origin === "sdk") return "human";
  if (origin === "scheduled") return "turn";
  if (origin) return "other"; // peer, task_notification, system, …
  if (t.startsWith("<") && !t.startsWith("<pasted_content")) return "other"; // <task-notification>, <local-command-stdout>, …
  return INJECTED_PREFIXES.some((p) => t.startsWith(p)) ? "other" : "human";
}

function fieldText(use: ToolUse, field: string): string | null {
  if (field === "*") {
    try {
      return JSON.stringify(use.input);
    } catch {
      return null;
    }
  }
  const v = use.input[field];
  return typeof v === "string" ? v : null;
}

const key = (tw: CompiledTripwire, i: number): string => `${tw.def.id}#${i}`;

/** Records what this tool call proves for later calls (call AFTER evaluating it). */
export function noteToolUse(tws: readonly CompiledTripwire[], memory: SessionMemory, use: ToolUse): void {
  let json: string | null = null;
  for (const tw of tws) {
    tw.earlier.forEach((e, i) => {
      if (!e.tool || !e.tool.test(use.name)) return;
      if (e.input) {
        json ??= JSON.stringify(use.input);
        if (!e.input.test(json)) return;
      }
      addCredit(memory, key(tw, i), e.until);
    });
  }
}

function addCredit(memory: SessionMemory, k: string, until: EarlierRule["until"] | null): void {
  memory.credits.set(k, until === "match" ? (memory.credits.get(k) ?? 0) + 1 : Infinity);
  memory.spent.delete(k);
}

function forget(memory: SessionMemory, k: string): void {
  memory.credits.delete(k);
  memory.spent.delete(k);
}

/** Records one user-text line (see `userLineKind`): a new run ends all scoped evidence, a prompt
 *  ends "reply" evidence a match already used, and only a prompt can add evidence. */
export function noteUserText(tws: readonly CompiledTripwire[], memory: SessionMemory, text: string, kind: UserLineKind = "human"): void {
  if (kind === "other") return;
  for (const tw of tws) {
    tw.earlier.forEach((e, i) => {
      const k = key(tw, i);
      if (e.until && (kind === "turn" || memory.spent.has(k))) forget(memory, k);
      if (kind === "human" && e.userText && !e.tool && e.userText.test(text)) addCredit(memory, k, e.until);
    });
  }
}

export interface ToolMatch {
  tripwire: CompiledTripwire;
  snippet: string;
}

interface Prepared {
  text: string;
  masked: string;
}

function prepare(raw: string, shell: boolean): Prepared {
  const text = (shell ? stripHeredocs(raw) : raw).slice(0, MAX_MATCH_CHARS);
  return { text, masked: shell ? maskShell(text) : text };
}

/** `bash -c '…'`, `sh -c "…"`, `zsh -lc …` at a command start: the quoted body is a script too. */
const SHELL_C_RE = /(?:^|[\n;&|(]|\$\()\s*(?:(?:nohup|exec|command|time|sudo|env(?:\s+\w+=\S*)*)\s+|[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()"'])*[ \t]+)*(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*c[a-zA-Z]*\s+(?=['"])/g;
const MAX_BODIES = 8;

/** The body of the quoted word starting at `q`, unquoted as the shell would; null if unclosed. */
function quotedBody(text: string, q: number): string | null {
  if (text[q] === "'") {
    const end = text.indexOf("'", q + 1);
    return end === -1 ? null : text.slice(q + 1, end);
  }
  let out = "";
  for (let i = q + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return out;
    if (c === "\\" && i + 1 < text.length) {
      const n = text[++i]!;
      out += '"\\$`'.includes(n) ? n : n === "\n" ? "" : c + n;
    } else out += c;
  }
  return null;
}

/** Each `bash -c` body in a command, with the absolute directory it starts in ("" = unknown). */
function shellBodies(p: Prepared, cwd: string, home: string): Array<Prepared & { cwd: string }> {
  const out: Array<Prepared & { cwd: string }> = [];
  SHELL_C_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < MAX_BODIES && (m = SHELL_C_RE.exec(p.masked)) !== null) {
    const body = quotedBody(p.text, m.index + m[0].length);
    if (!body) continue;
    const dir = effectiveDir(p.text, p.masked, m.index, m[0], cwd, home);
    out.push({ ...prepare(body, true), cwd: dir === null ? "" : dir.replace(/^~(?=\/|$)/, home) });
  }
  return out;
}

/** One tool call through a session's memory: evaluates every tripwire that could matter, returns
 *  the hits (only when `live`), then updates the memory: a match an earlier piece of evidence
 *  excused uses it up (see `EarlierRule.until`), and this call's own evidence is added. Older lines
 *  still go through here so the memory stays right. */
export function stepToolUse(tws: readonly CompiledTripwire[], memory: SessionMemory, use: ToolUse, cwd: string, home: string, live: boolean): ToolMatch[] {
  const hits: ToolMatch[] = [];
  const fired: CompiledTripwire[] = [];
  const shell = use.name === "Bash";
  const prepared = new Map<string, Prepared | null>();
  let bodies: Array<Prepared & { cwd: string }> | null = null;
  for (const tw of tws) {
    if (!tw.tool.test(use.name)) continue;
    const excused = tw.earlier.some((_, i) => (memory.credits.get(key(tw, i)) ?? 0) > 0);
    const spends = excused && tw.earlier.some((e) => e.until);
    if (live ? excused && !spends : !spends) continue;
    let p = prepared.get(tw.field);
    if (p === undefined) {
      const raw = fieldText(use, tw.field);
      p = raw === null ? null : prepare(raw, shell);
      prepared.set(tw.field, p);
    }
    if (!p) continue;
    let snippet = firstMatch(tw, p, cwd, home);
    if (snippet === null && shell && !tw.def.topLevelOnly) {
      bodies ??= shellBodies(p, cwd, home);
      for (const b of bodies) if ((snippet = firstMatch(tw, b, b.cwd, home)) !== null) break;
    }
    if (snippet === null) continue;
    fired.push(tw);
    if (live && !excused) hits.push({ tripwire: tw, snippet });
  }
  for (const tw of fired) spendEvidence(tw, memory);
  noteToolUse(tws, memory, use);
  return hits;
}

/** A match an earlier piece of evidence excused: uncounted evidence covers it (a used "reply" one
 *  ends at the next prompt), else one counted credit is spent. */
function spendEvidence(tw: CompiledTripwire, memory: SessionMemory): void {
  const held = tw.earlier.map((e, i) => ({ e, k: key(tw, i), n: memory.credits.get(key(tw, i)) ?? 0 })).filter((x) => x.n > 0);
  const open = held.filter((x) => x.n === Infinity);
  if (open.length) {
    for (const x of open) if (x.e.until === "reply") memory.spent.add(x.k);
    return;
  }
  const counted = held[0];
  if (counted) memory.credits.set(counted.k, counted.n - 1);
}

/** Every tripwire this one tool call trips. `memory` is only read (see stepToolUse). */
export function matchToolUse(tws: readonly CompiledTripwire[], use: ToolUse, cwd: string, home: string, memory: SessionMemory = newSessionMemory()): ToolMatch[] {
  return stepToolUse(tws, { credits: new Map(memory.credits), spent: new Set(memory.spent) }, use, cwd, home, true);
}

function firstMatch(tw: CompiledTripwire, p: Prepared, cwd: string, home: string): string | null {
  for (const re of tw.match) {
    const found = firstAllowed(re, tw, p.text, p.masked, cwd, home);
    if (found !== null) return found;
  }
  return null;
}

/** First occurrence of `re` that survives the allowlist and the directory scope, as a snippet. */
function firstAllowed(re: RegExp, tw: CompiledTripwire, text: string, masked: string, cwd: string, home: string): string | null {
  const g = new RegExp(re.source, `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(masked)) !== null) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    // The allowlist sees the match through to the end of the simple command it ends in, so a
    // rule can allow on what follows the match too (a `[x]` grep pattern after `grep -c`).
    let end = m.index + m[0].length;
    while (end < masked.length && !"\n;&|".includes(masked[end]!)) end++;
    const scope = text.slice(m.index, end);
    if (tw.allow.some((a) => a.test(scope))) continue;
    if (tw.inDirs) {
      const dir = effectiveDir(text, masked, m.index, m[0], cwd, home);
      if (dir === null || !tw.inDirs.test(dir)) continue;
    }
    return snippetAt(text, masked, m.index, m[0].length);
  }
  return null;
}

// ── Tracker: new transcript lines in, deduped hits out ──────────────────────────────────────

export const LIVE_WINDOW_MS = 15 * 60_000;
const MAX_SESSIONS = 1000;
const MAX_SEEN = 20_000;

export interface IngestContext {
  /** The session's cwd from the index (a line's own cwd wins when present). */
  cwd: string;
  district: string | null;
  nowMs: number;
  /** The lines are a subagent's (its id): hits go to the parent session, and the subagent's
   *  "user" lines (its parent agent's prompt) never count as Alex's go-ahead. */
  subagentId?: string;
}

export interface TrackerOptions {
  home: string;
  cap?: number;
  /** Only tool calls this recent (vs `nowMs`) become hits; older lines still feed the memory. */
  liveWindowMs?: number;
}

/** Holds the dedupe set and per-session memory, and the newest-first list of hits. */
export class TripwireTracker {
  private readonly seen = new Set<string>();
  private readonly memory = new Map<string, SessionMemory>();
  private list: TripwireHit[] = [];
  private readonly cap: number;
  private readonly liveWindowMs: number;

  constructor(
    private readonly tws: readonly CompiledTripwire[],
    private readonly opts: TrackerOptions,
  ) {
    this.cap = opts.cap ?? TRIPWIRES_HIT_CAP;
    this.liveWindowMs = opts.liveWindowMs ?? LIVE_WINDOW_MS;
  }

  private sessionMemory(sessionId: string): SessionMemory {
    let m = this.memory.get(sessionId);
    if (!m) {
      if (this.memory.size >= MAX_SESSIONS) {
        const oldest = this.memory.keys().next().value;
        if (oldest !== undefined) this.memory.delete(oldest);
      }
      m = newSessionMemory();
      this.memory.set(sessionId, m);
    }
    return m;
  }

  /** Raw jsonl lines of one session, oldest first. Returns only the hits that are new. */
  ingest(sessionId: string, rawLines: readonly string[], ctx: IngestContext): TripwireHit[] {
    const fresh: TripwireHit[] = [];
    const memory = this.sessionMemory(sessionId);
    for (const raw of rawLines) {
      const mightMatter = raw.includes('"tool_use"') || raw.includes('"type":"user"');
      if (!mightMatter) continue;
      const line = parseLine(raw);
      if (!line) continue;
      if (line.isUserText && line.userText) {
        if (!ctx.subagentId) noteUserText(this.tws, memory, line.userText, userLineKind(raw, line.userText));
        continue;
      }
      if (!line.isAssistant || line.toolUses.length === 0) continue;
      const atMs = Date.parse(line.timestamp ?? "");
      const live = Number.isFinite(atMs) && ctx.nowMs - atMs <= this.liveWindowMs && atMs - ctx.nowMs <= 5 * 60_000;
      const cwd = line.cwd ?? ctx.cwd;
      for (const use of line.toolUses) {
        for (const { tripwire, snippet } of stepToolUse(this.tws, memory, use, cwd, this.opts.home, live)) {
          const id = `${sessionId}:${tripwire.def.id}`;
          if (this.seen.has(id)) continue;
          this.seen.add(id);
          fresh.push({
            id,
            sessionId,
            subagentId: ctx.subagentId ?? null,
            district: ctx.district,
            tripwireId: tripwire.def.id,
            lesson: tripwire.def.lesson,
            severity: tripwire.def.severity,
            source: tripwire.def.source,
            tool: use.name,
            snippet,
            at: new Date(atMs).toISOString(),
          });
        }
      }
    }
    if (fresh.length) this.list = [...[...fresh].reverse(), ...this.list].slice(0, this.cap);
    this.pruneSeen();
    return fresh;
  }

  /** Folds hits read back from the log (oldest first, in the order they were appended) into the
   *  tracker, deduped exactly like `ingest`: one hit per `${sessionId}:${tripwireId}`, the first
   *  one wins, and an id this tracker already holds is skipped. Restored hits are older than any
   *  hit found since boot, so they go after those in the newest-first list. Returns the hits it
   *  kept (oldest first). Emits nothing and touches no session memory. */
  restore(oldestFirst: readonly TripwireHit[]): TripwireHit[] {
    const kept: TripwireHit[] = [];
    for (const hit of oldestFirst) {
      if (!isTripwireHit(hit) || this.seen.has(hit.id)) continue;
      this.seen.add(hit.id);
      kept.push(hit);
    }
    if (kept.length) this.list = [...this.list, ...[...kept].reverse()].slice(0, this.cap);
    this.pruneSeen();
    return kept;
  }

  private pruneSeen(): void {
    if (this.seen.size > MAX_SEEN) for (const k of [...this.seen].slice(0, this.seen.size - MAX_SEEN)) this.seen.delete(k);
  }

  /** Newest first. */
  hits(): TripwireHit[] {
    return [...this.list];
  }
}

// ── The hit log (data/tripwires.jsonl): pure halves of the fold ─────────────────────────────

/** One JSON hit per line, as tripwires-store.ts appends them. A torn, hand-edited or invalid line
 *  is skipped, never thrown on, and only the hit's own fields are kept. Oldest first (file order). */
export function parseHitLines(text: string): TripwireHit[] {
  const out: TripwireHit[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isTripwireHit(v)) continue;
    const { id, sessionId, subagentId, district, tripwireId, lesson, severity, source, tool, snippet, at } = v;
    out.push({ id, sessionId, subagentId, district, tripwireId, lesson, severity, source, tool, snippet, at });
  }
  return out;
}

// ── Lesson coverage: counts only ────────────────────────────────────────────────────────────
// "N lessons written, 12 guarded": every number is a count read from a file with a fixed rule
// (below), and "guarded" is the number of rules. Nothing here reads a lesson's words to decide
// whether it is guarded, and nothing ever turns a lesson into a regex.

/** A journal line that records a lesson: "Lesson: …" or "Lesson (09-28): …". */
const JOURNAL_LESSON_RE = /\bLesson(?:\s*\([^)\n]{0,40}\))?:/;
/** The MEMORY.md section whose bullets are the standing warnings. */
const STANDING_HEADING_RE = /^##\s.*\bStanding warnings\b/;
const FEEDBACK_FILE_RE = /^feedback_.+\.md$/;
const CONDUCT_CASE_RE = /^###\s+Case\b/;

export function countJournalLessons(text: string): number {
  return text.split("\n").filter((l) => JOURNAL_LESSON_RE.test(l)).length;
}

/** Top-level bullets under the "## … Standing warnings …" heading, up to the next "## " heading. */
export function countStandingWarnings(memoryIndex: string): number {
  let inside = false;
  let n = 0;
  for (const line of memoryIndex.split("\n")) {
    if (line.startsWith("## ")) {
      inside = STANDING_HEADING_RE.test(line);
      continue;
    }
    if (inside && line.startsWith("- ")) n++;
  }
  return n;
}

export function countFeedbackMemories(fileNames: readonly string[]): number {
  return fileNames.filter((n) => FEEDBACK_FILE_RE.test(n)).length;
}

export function countConductCases(text: string): number {
  return text.split("\n").filter((l) => CONDUCT_CASE_RE.test(l)).length;
}

export interface LessonSourceSpec {
  id: LessonSourceId;
  label: string;
  how: string;
  /** Matched against each rule's own `source` field: does the rule cite this source? */
  cites: RegExp;
}

export const LESSON_SOURCE_SPECS: readonly LessonSourceSpec[] = [
  { id: "journal", label: "loop journal", how: "lines with `Lesson:` (or `Lesson (date):`)", cites: /\bjournal\b/i },
  { id: "standing-warnings", label: "standing warnings", how: "bullets under MEMORY.md's Standing warnings heading", cites: /\bMEMORY\.md\b/ },
  { id: "feedback-memories", label: "feedback memories", how: "feedback_*.md files in the memory folder", cites: /\bfeedback_[a-z0-9_]+/i },
  { id: "conduct-cases", label: "conduct cases", how: "`### Case` headings", cites: /\bCASES\.md\b|\bagent-conduct\b/ },
];

/** What was read for one source (`path` home-relative, for display): a count, or why not. */
export type LessonCountResult = { path: string } & ({ ok: true; lessons: number } | { ok: false; error: string });

export function buildCoverage(counts: Readonly<Record<LessonSourceId, LessonCountResult>>, rules: readonly Pick<TripwireDef, "source">[], countedAt: string): TripwireCoverage {
  const sources: LessonSourceCount[] = LESSON_SOURCE_SPECS.map((spec) => {
    const r = counts[spec.id];
    const base = { id: spec.id, label: spec.label, path: r.path, how: spec.how, citedByRules: rules.filter((d) => spec.cites.test(d.source)).length };
    return r.ok ? { ...base, lessons: r.lessons } : { ...base, lessons: null, error: r.error };
  });
  return { lessonsWritten: sources.reduce((a, s) => a + (s.lessons ?? 0), 0), guarded: rules.length, sources, countedAt };
}
