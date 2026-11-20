// Pure helpers for the "chat" feature (server/features/chat.ts): the `claude -p` argv, the
// stream-json line splitter + parser, attachment validation, the stream-json user message, and
// the end-of-turn verdict (a headless claude can exit 0 having done nothing when a tool was
// denied — that must show in the panel, never as a silent success).
//
// Verified against Claude Code 2.1.281 (`claude --help`) and code.claude.com/docs/en/headless.md,
// agent-sdk/streaming-vs-single-mode.md and agent-sdk/cost-tracking.md on 2026-09-26:
//   - `--output-format stream-json` with `-p` REQUIRES `--verbose` (tested: exits 1 without it).
//   - `--include-partial-messages` adds `stream_event` lines (text_delta tokens).
//   - `--permission-mode` accepts default | plan | acceptEdits (tested, all start).
//   - `--permission-prompts none`: anything that would prompt is denied unless a PermissionRequest
//     hook allows it (Alef's hook still runs); denials arrive as `permission_denied` system lines
//     and in result.permission_denials.
//   - images: a stream-json user message content block {type:"image", source:{type:"base64", media_type, data}}.
//   - result.usage covers that call only; result.total_cost_usd is the session's running total.

import { redactSecrets } from "../heuristics.js";
import { isRecord } from "../http.js";
import {
  CHAT_MAX_ATTACHMENT_BYTES,
  type ChatAttachmentUpload,
  type ChatEvent,
  type ChatMode,
  type ChatModel,
  type ChatUsage,
} from "../../shared/features/chat.js";

// ── argv ──────────────────────────────────────────────────────────────────

const MODE_FLAG: Record<ChatMode, string> = { normal: "default", plan: "plan", acceptEdits: "acceptEdits" };

export interface ClaudeArgsInput {
  sessionId: string;
  /** true: the session exists on disk → --resume it. false: a brand-new chat → --session-id. */
  resume: boolean;
  /** Continue on a new session id (the original is open elsewhere). Only with resume. */
  fork: boolean;
  model: ChatModel;
  mode: ChatMode;
}

/** argv for one headless turn (never a shell string). */
export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    i.model,
    "--permission-mode",
    MODE_FLAG[i.mode],
    "--permission-prompts",
    "none",
  ];
  if (i.resume) {
    args.push("--resume", i.sessionId);
    if (i.fork) args.push("--fork-session");
  } else {
    args.push("--session-id", i.sessionId);
  }
  return args;
}

// ── stream-json lines ─────────────────────────────────────────────────────

/** Splits a byte stream into complete lines; a partial tail waits for the next chunk. */
export class LineSplitter {
  private buf = "";
  constructor(private readonly maxLine = 8 * 1024 * 1024) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    // A runaway line with no newline would grow forever: drop it (it can't be valid JSON we want).
    if (this.buf.length > this.maxLine) this.buf = "";
    return parts.map((l) => l.trim()).filter((l) => l.length > 0);
  }

  /** The unterminated tail at end of stream. */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}

const EMPTY_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseUsage(v: unknown): ChatUsage {
  if (!isRecord(v)) return { ...EMPTY_USAGE };
  return {
    inputTokens: num(v.input_tokens),
    outputTokens: num(v.output_tokens),
    cacheReadTokens: num(v.cache_read_input_tokens),
    cacheCreationTokens: num(v.cache_creation_input_tokens),
  };
}

export function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

function oneLine(raw: string, max: number): string {
  let t = redactSecrets(raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t;
}

/** One-line summary of a tool call's input (command, path, pattern, url…), redacted. */
export function toolSummary(name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  const pick = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill", "notebook_path"];
  for (const k of pick) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return oneLine(v, 140);
  }
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return "";
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && b.type === "text" ? str(b.text) : isRecord(b) && b.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Parses one stream-json line into zero or more normalized events. Malformed JSON, unknown
 *  types and subagent-internal lines (parent_tool_use_id set) yield []. Never throws. */
export function parseStreamLine(line: string): ChatEvent[] {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(o)) return [];
  const type = str(o.type);
  const nested = o.parent_tool_use_id !== undefined && o.parent_tool_use_id !== null;

  if (type === "stream_event") {
    if (nested) return [];
    const ev = o.event;
    if (!isRecord(ev) || ev.type !== "content_block_delta" || !isRecord(ev.delta)) return [];
    if (ev.delta.type !== "text_delta") return [];
    const text = str(ev.delta.text);
    return text ? [{ kind: "text-delta", text }] : [];
  }

  if (type === "assistant") {
    if (nested || !isRecord(o.message) || !Array.isArray(o.message.content)) return [];
    const out: ChatEvent[] = [];
    for (const b of o.message.content) {
      if (!isRecord(b)) continue;
      if (b.type === "text" && str(b.text)) out.push({ kind: "assistant-text", text: str(b.text) });
      else if (b.type === "tool_use") {
        const name = oneLine(str(b.name) || "tool", 80);
        out.push({ kind: "tool", tool: { id: str(b.id), name, summary: toolSummary(name, b.input) } });
      }
    }
    return out;
  }

  if (type === "user") {
    if (nested || !isRecord(o.message) || !Array.isArray(o.message.content)) return [];
    const out: ChatEvent[] = [];
    for (const b of o.message.content) {
      if (!isRecord(b) || b.type !== "tool_result") continue;
      out.push({ kind: "tool-result", toolUseId: str(b.tool_use_id), isError: b.is_error === true, preview: oneLine(toolResultText(b.content), 200) });
    }
    return out;
  }

  if (type === "system") {
    const sub = str(o.subtype);
    if (sub === "init") {
      const sessionId = str(o.session_id);
      return sessionId ? [{ kind: "init", sessionId, model: str(o.model) }] : [];
    }
    if (sub === "permission_denied") {
      const toolName = oneLine(str(o.tool_name) || str(o.toolName) || "a tool", 80);
      const reason = oneLine(str(o.reason) || str(o.message) || "nobody could approve it here", 200);
      return [{ kind: "denied", toolName, reason }];
    }
    if (sub === "api_retry") return [{ kind: "retry", attempt: num(o.attempt), error: oneLine(str(o.error) || "unknown", 60) }];
    return [];
  }

  if (type === "result") {
    const subtype = str(o.subtype) || "unknown";
    const denials = Array.isArray(o.permission_denials)
      ? o.permission_denials.map((d) => (isRecord(d) ? oneLine(str(d.tool_name) || str(d.toolName) || "tool", 80) : "tool"))
      : [];
    const cost = typeof o.total_cost_usd === "number" && Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : null;
    const duration = typeof o.duration_ms === "number" && Number.isFinite(o.duration_ms) ? o.duration_ms : null;
    return [
      {
        kind: "result",
        ok: subtype === "success" && o.is_error !== true,
        subtype,
        text: str(o.result),
        costUsd: cost,
        usage: parseUsage(o.usage),
        durationMs: duration,
        denials,
      },
    ];
  }
  return [];
}

// ── attachments ───────────────────────────────────────────────────────────

export type ValidAttachment =
  | { ok: true; kind: "image"; name: string; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; bytes: Buffer }
  | { ok: true; kind: "text"; name: string; mime: "text/plain"; bytes: Buffer; text: string };
export type AttachmentCheck = ValidAttachment | { ok: false; error: string };

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|toml|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|ini|cfg|conf|env\.example|gitignore|dockerfile)$/i;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Image type from magic bytes (the browser's mime is never trusted). */
export function sniffImage(b: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** File name safe to show and to store: basename only, no control/path chars, ≤80 chars. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim();
  return (clean || "file").slice(0, 80);
}

/** Validates one upload: images (png/jpeg/gif/webp by magic bytes) or UTF-8 text files, ≤ 10 MB. */
export function validateAttachment(u: unknown, maxBytes = CHAT_MAX_ATTACHMENT_BYTES): AttachmentCheck {
  if (!isRecord(u) || typeof u.name !== "string" || typeof u.dataBase64 !== "string") return { ok: false, error: "attachment needs a name and base64 data" };
  const up = u as unknown as ChatAttachmentUpload;
  const name = safeFileName(up.name);
  const b64 = up.dataBase64.replace(/\s+/g, "");
  if (!b64) return { ok: false, error: `${name}: empty file` };
  if (!B64_RE.test(b64)) return { ok: false, error: `${name}: data is not base64` };
  if (Math.floor((b64.length * 3) / 4) > maxBytes + 3) return { ok: false, error: `${name}: over ${Math.round(maxBytes / 1024 / 1024)} MB` };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) return { ok: false, error: `${name}: empty file` };
  if (bytes.length > maxBytes) return { ok: false, error: `${name}: over ${Math.round(maxBytes / 1024 / 1024)} MB` };
  const image = sniffImage(bytes);
  if (image) return { ok: true, kind: "image", name, mime: image, bytes };
  const mime = typeof up.mime === "string" ? up.mime.toLowerCase() : "";
  if (mime.startsWith("image/")) return { ok: false, error: `${name}: only PNG, JPEG, GIF or WebP images` };
  if (!mime.startsWith("text/") && mime !== "application/json" && !TEXT_EXT.test(name)) return { ok: false, error: `${name}: only images and text files` };
  if (bytes.includes(0)) return { ok: false, error: `${name}: looks binary, not text` };
  const text = bytes.toString("utf8");
  if (text.includes("�")) return { ok: false, error: `${name}: not valid UTF-8 text` };
  return { ok: true, kind: "text", name, mime: "text/plain", bytes, text };
}

/** Text attachments above this are referenced by path (Claude reads the saved copy) instead of inlined. */
export const TEXT_INLINE_MAX = 200 * 1024;

export interface StoredAttachment {
  att: ValidAttachment;
  /** Absolute path of the saved copy under data/chat-uploads/. */
  path: string;
}

/** The stream-json user message line for one turn (images as base64 blocks, text files inline or by path). */
export function buildUserMessage(text: string, stored: readonly StoredAttachment[]): string {
  const content: Record<string, unknown>[] = [];
  const notes: string[] = [];
  for (const s of stored) {
    if (s.att.kind === "image") {
      content.push({ type: "image", source: { type: "base64", media_type: s.att.mime, data: s.att.bytes.toString("base64") } });
    } else if (s.att.bytes.length <= TEXT_INLINE_MAX) {
      notes.push(`Attached file ${s.att.name} (saved at ${s.path}):\n<<<FILE\n${s.att.text}\nFILE>>>`);
    } else {
      notes.push(`Attached file ${s.att.name} is large; read it from ${s.path}.`);
    }
  }
  content.push({ type: "text", text: notes.length ? `${text}\n\n${notes.join("\n\n")}` : text });
  return JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
}

// ── end of turn ───────────────────────────────────────────────────────────

export interface TurnTrace {
  sawResult: boolean;
  resultOk: boolean;
  resultSubtype: string;
  assistantChars: number;
  toolCalls: number;
  denials: string[];
  exitCode: number | null;
  signal: string | null;
  stoppedByUser: boolean;
  stderrTail: string;
}

export function emptyTrace(): TurnTrace {
  return { sawResult: false, resultOk: false, resultSubtype: "", assistantChars: 0, toolCalls: 0, denials: [], exitCode: null, signal: null, stoppedByUser: false, stderrTail: "" };
}

/** Folds one parsed event into the trace. */
export function traceEvent(t: TurnTrace, ev: ChatEvent): void {
  if (ev.kind === "assistant-text") t.assistantChars += ev.text.trim().length;
  else if (ev.kind === "tool") t.toolCalls += 1;
  else if (ev.kind === "denied") {
    if (!t.denials.includes(ev.toolName)) t.denials.push(ev.toolName);
  } else if (ev.kind === "result") {
    t.sawResult = true;
    t.resultOk = ev.ok;
    t.resultSubtype = ev.subtype;
    for (const d of ev.denials) if (!t.denials.includes(d)) t.denials.push(d);
    if (t.assistantChars === 0 && ev.text.trim()) t.assistantChars = ev.text.trim().length;
  }
}

/** What the panel must say when the turn ends (null = a normal, successful turn). */
export function turnVerdict(t: TurnTrace): { level: "info" | "warn" | "error"; text: string } | null {
  const denied = t.denials.length ? `Blocked: ${t.denials.join(", ")} needed approval and nobody approved it here (approve it in Alef's approval card, or switch mode).` : "";
  if (t.stoppedByUser) return { level: "info", text: "Stopped." };
  if (!t.sawResult) {
    const why = t.stderrTail.trim() ? ` ${oneLine(t.stderrTail, 300)}` : "";
    const how = t.signal ? `was killed (${t.signal})` : `exited with code ${t.exitCode ?? "?"}`;
    return { level: "error", text: `claude ${how} without finishing the turn.${why}` };
  }
  if (!t.resultOk) return { level: "error", text: `The turn ended with "${t.resultSubtype}".${denied ? ` ${denied}` : ""}` };
  if (t.assistantChars === 0 && t.denials.length) return { level: "warn", text: `No reply. ${denied}` };
  if (t.assistantChars === 0 && t.toolCalls === 0) return { level: "warn", text: "claude finished without writing anything." };
  if (t.denials.length) return { level: "warn", text: denied };
  return null;
}

// ── fork rule ─────────────────────────────────────────────────────────────

/** A turn on a session that is open in a terminal / VS Code must fork (and needs the user's OK first). */
export function forkDecision(i: { liveElsewhere: boolean; alreadyForked: boolean; resume: boolean; acknowledged: boolean }): "fork" | "same" | "needs-ack" {
  if (!i.resume || i.alreadyForked || !i.liveElsewhere) return "same";
  return i.acknowledged ? "fork" : "needs-ack";
}
