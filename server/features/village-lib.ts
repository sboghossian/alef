// Pure logic for the "village" feature: turning raw jsonl lines into VillageMessage
// observations, and a best-effort name → session id resolver. No IO. Transcript text is
// untrusted data — parse it, never execute it (see server/jsonl-events.ts's header).

import type { VillageMessage, VillageMessageDirection } from "../../shared/features/village.js";
import type { ParsedLine } from "../jsonl-events.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** First non-blank line, whitespace-collapsed, cut to `max` chars with an ellipsis. */
export function firstLine(text: string, max = 140): string {
  const line =
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .find((l) => l.trim().length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, Math.max(0, max - 1))}…` : collapsed;
}

/** SendMessage's `message` param is either plain text or one of the legacy protocol objects
 *  (shutdown/plan-approval); a one-line label either way. */
export function messagePreview(message: unknown): string {
  if (typeof message === "string") return message ? firstLine(message) : "(empty message)";
  if (isRecord(message) && typeof message.type === "string") {
    switch (message.type) {
      case "shutdown_request":
        return "[shutdown request]";
      case "shutdown_response":
        return `[shutdown ${message.approve === true ? "approved" : "declined"}]`;
      case "plan_approval_response":
        return `[plan ${message.approve === true ? "approved" : "sent back"}]`;
      default:
        return `[${message.type}]`;
    }
  }
  return "(message)";
}

/** One line of an assistant turn → its SendMessage calls, if any. Pass the already-`parseLine`d
 *  line (village.ts does one parse per line and shares it with the timestamp lookup). */
export function sendMessagesOnLine(parsed: ParsedLine | null): { toRaw: string; preview: string }[] {
  if (!parsed || !parsed.isAssistant) return [];
  const out: { toRaw: string; preview: string }[] = [];
  for (const use of parsed.toolUses) {
    if (use.name !== "SendMessage") continue;
    const to = typeof use.input.to === "string" ? use.input.to.trim() : "";
    if (!to) continue;
    out.push({ toRaw: to, preview: messagePreview(use.input.message) });
  }
  return out;
}

/** All "text" content blocks of a user turn, concatenated (parseLine's own extractText only
 *  keeps the FIRST block, which is not safe enough here: an inbound `<cross-session-message>`
 *  is not guaranteed to be the first block in a user turn that also carries tool results). */
function allUserText(raw: string): string | null {
  if (!raw.includes('"type":"user"')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== "user" || !isRecord(obj.message)) return null;
  const content = obj.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts.length ? texts.join("\n") : null;
}

const CROSS_SESSION_RE = /<(cross-session-message|agent-message)\s+from="([^"]*)">([\s\S]*?)<\/\1>/g;

/** One raw jsonl line → the `<cross-session-message from="...">` / `<agent-message from="...">`
 *  wrappers it carries, if any (a user turn on the RECEIVING session's transcript). */
export function incomingMessagesOnLine(raw: string): { fromRaw: string; preview: string }[] {
  if (!raw.includes("cross-session-message") && !raw.includes("agent-message")) return [];
  const text = allUserText(raw);
  if (!text) return [];
  const out: { fromRaw: string; preview: string }[] = [];
  for (const m of text.matchAll(CROSS_SESSION_RE)) {
    const from = (m[2] ?? "").trim();
    if (!from) continue;
    out.push({ fromRaw: from, preview: firstLine(m[3] ?? "") });
  }
  return out;
}

const REF_RE = /^(.*?)\s*\[([0-9a-f]{4,12})\]\s*$/i;

/** SendMessage addresses as "name" or "name [ref]" (ListAgents' short ref). */
export function parseRef(raw: string): { name: string; ref: string | null } {
  const trimmed = raw.trim();
  const m = REF_RE.exec(trimmed);
  if (!m) return { name: trimmed, ref: null };
  return { name: (m[1] ?? "").trim(), ref: (m[2] ?? "").toLowerCase() };
}

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export interface NameCandidate {
  id: string;
  title: string;
  cwd: string;
}

/**
 * Best-effort name → session id. Claude Code's cross-session address space (teammate names,
 * `ListAgents` refs) is NOT part of WorldAgent — a session has no stored "name" here — so this
 * is a heuristic, not ground truth:
 *   1. an id-PREFIX match on the `[ref]` (fairly strong: refs are short hex prefixes of the id);
 *   2. an exact match of the name against the agent's repo/cwd basename (sessions are often
 *      named after the project they run in);
 *   3. an exact match against the agent's title (weak: title is the first prompt, not a chosen
 *      name — only tried as a last resort).
 * Returns null (never guesses) when nothing lines up.
 */
export function resolveByName(raw: string, agents: readonly NameCandidate[]): string | null {
  const { name, ref } = parseRef(raw);
  if (ref) {
    const hit = agents.find((a) => a.id.toLowerCase().startsWith(ref));
    if (hit) return hit.id;
  }
  if (!name) return null;
  const lower = name.toLowerCase();
  const byCwd = agents.find((a) => baseName(a.cwd).toLowerCase() === lower);
  if (byCwd) return byCwd.id;
  const byTitle = agents.find((a) => a.title.trim().toLowerCase() === lower);
  return byTitle ? byTitle.id : null;
}

// ---------------------------------------------------------------- assembly

function hash(s: string): string {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function messageId(direction: VillageMessageDirection, at: string, fromRaw: string, toRaw: string, preview: string): string {
  return `${direction}:${hash(`${at}|${fromRaw}|${toRaw}|${preview}`)}`;
}

/** Builds one VillageMessage from a raw observation. `selfSessionId` is the session whose
 *  transcript we read the line from — always the known, real end of the link. */
export function buildMessage(
  direction: VillageMessageDirection,
  at: string,
  selfSessionId: string,
  raw: { toRaw: string; preview: string } | { fromRaw: string; preview: string },
  agents: readonly NameCandidate[],
): VillageMessage {
  if (direction === "sent" && "toRaw" in raw) {
    return {
      id: messageId("sent", at, selfSessionId, raw.toRaw, raw.preview),
      at,
      direction,
      fromSessionId: selfSessionId,
      fromRaw: selfSessionId,
      toSessionId: resolveByName(raw.toRaw, agents),
      toRaw: raw.toRaw,
      preview: raw.preview,
    };
  }
  const fromRaw = "fromRaw" in raw ? raw.fromRaw : "";
  return {
    id: messageId("received", at, fromRaw, selfSessionId, raw.preview),
    at,
    direction: "received",
    fromSessionId: resolveByName(fromRaw, agents),
    fromRaw,
    toSessionId: selfSessionId,
    toRaw: selfSessionId,
    preview: raw.preview,
  };
}

/** Newest-first, de-duplicated by id (last write wins), older-than-`maxAgeMs` dropped, capped. */
export function pruneMessages(messages: readonly VillageMessage[], nowMs: number, maxAgeMs: number, cap: number): VillageMessage[] {
  const cutoff = nowMs - maxAgeMs;
  const byId = new Map<string, VillageMessage>();
  for (const m of messages) {
    const t = Date.parse(m.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, cap);
}
