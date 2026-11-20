// Pure helpers for the Room chat panel (chat.ts): the fork-warning rule, attachment pre-checks,
// number formatting, event validation, and a tiny "markdown-ish" splitter that turns reply text
// into plain segments (code fences, inline code, bold) the panel renders with textContent only.

import {
  CHAT_MAX_ATTACHMENT_BYTES,
  CHAT_MAX_ATTACHMENTS,
  CHAT_MODELS,
  type ChatEvent,
  type ChatModel,
  type ChatUsage,
  type ChatView,
} from "../../../../shared/features/chat";

/** Show "continuing here creates a fork" before the first send of a chat whose session is open elsewhere. */
export function needsForkWarning(i: { liveElsewhere: boolean; turns: number; forked: boolean; acknowledged: boolean }): boolean {
  return i.liveElsewhere && i.turns === 0 && !i.forked && !i.acknowledged;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|toml|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|ini|cfg|conf)$/i;

/** Client-side pre-check (the server re-validates by content). Returns an error line or null. */
export function attachmentProblem(f: { name: string; size: number; type: string }, alreadyAttached: number): string | null {
  if (alreadyAttached >= CHAT_MAX_ATTACHMENTS) return `At most ${CHAT_MAX_ATTACHMENTS} attachments per message.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.size > CHAT_MAX_ATTACHMENT_BYTES) return `${f.name} is over ${CHAT_MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
  if (f.type.startsWith("image/")) return IMAGE_TYPES.has(f.type) ? null : `${f.name}: only PNG, JPEG, GIF or WebP images.`;
  if (f.type.startsWith("text/") || f.type === "application/json" || TEXT_EXT.test(f.name)) return null;
  return `${f.name}: only images and text files.`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsd(v: number | null): string {
  if (v === null) return "–";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function totalTokens(u: ChatUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

export function isChatModel(v: unknown): v is ChatModel {
  return typeof v === "string" && (CHAT_MODELS as readonly string[]).includes(v);
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates a ChatView off the wire (null when malformed). */
export function parseChatView(v: unknown): ChatView | null {
  if (!isRec(v) || typeof v.id !== "string" || typeof v.cwd !== "string" || typeof v.islandId !== "string") return null;
  if (typeof v.running !== "boolean" || typeof v.turns !== "number" || !isRec(v.usage)) return null;
  return v as unknown as ChatView;
}

const EVENT_KINDS = new Set(["user", "init", "text-delta", "assistant-text", "tool", "tool-result", "denied", "retry", "result", "notice"]);

/** Validates a ChatEvent off the wire: a known kind with the string fields the panel reads. */
export function parseChatEvent(v: unknown): ChatEvent | null {
  if (!isRec(v) || typeof v.kind !== "string" || !EVENT_KINDS.has(v.kind)) return null;
  switch (v.kind) {
    case "user":
      return typeof v.text === "string" && Array.isArray(v.attachments) ? (v as unknown as ChatEvent) : null;
    case "text-delta":
    case "assistant-text":
    case "notice":
      return typeof v.text === "string" ? (v as unknown as ChatEvent) : null;
    case "tool":
      return isRec(v.tool) && typeof v.tool.name === "string" && typeof v.tool.summary === "string" ? (v as unknown as ChatEvent) : null;
    case "result":
      return isRec(v.usage) && typeof v.ok === "boolean" && Array.isArray(v.denials) ? (v as unknown as ChatEvent) : null;
    case "denied":
      return typeof v.toolName === "string" && typeof v.reason === "string" ? (v as unknown as ChatEvent) : null;
    default:
      return v as unknown as ChatEvent;
  }
}

export type Segment = { kind: "text" | "bold" | "code"; text: string } | { kind: "block"; lang: string; text: string };

/** Splits reply text into plain segments: ``` fences, `inline code`, **bold**. Never produces HTML. */
export function segments(src: string): Segment[] {
  const out: Segment[] = [];
  const fence = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m = fence.exec(src); m; m = fence.exec(src)) {
    if (m.index > last) out.push(...inline(src.slice(last, m.index)));
    out.push({ kind: "block", lang: m[1] ?? "", text: (m[2] ?? "").replace(/\n$/, "") });
    last = fence.lastIndex;
    if (m[0].length === 0) break;
  }
  if (last < src.length) out.push(...inline(src.slice(last)));
  return out;
}

function inline(src: string): Segment[] {
  const out: Segment[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else out.push({ kind: "bold", text: m[2] ?? "" });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}
