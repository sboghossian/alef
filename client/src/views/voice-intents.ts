// Pure logic for the 🎙️ Voice view ("talk to Alef"): utterance → intent, the spoken
// approval-confirmation state machine, and the sentences Alef speaks back. No DOM, no
// audio, no network, so every branch is unit-tested (voice-intents.test.ts) and the typed
// fallback box in the view goes through exactly the same routing as the microphone.
//
// Safety rules encoded here (and tested):
// - An approval is NEVER decided by a single utterance. "approve" only arms a confirmation;
//   a separate utterance that is exactly "confirm" executes it, for the same approval id,
//   while it is still pending and on screen, within CONFIRM_TTL_MS.
// - A dispatch only fills the prompt box. The view never sends it.

import type { DailyReport } from "../../../shared/features/replay";
import { routeUtterance, STOP_WORD_RE } from "../features/voice-logic";

// ---------------------------------------------------------------- intents

export type ViewTarget = { id: string; name: string };

export type VoiceIntent =
  | { kind: "inbox" }
  | { kind: "today" }
  | { kind: "find"; query: string }
  | { kind: "focus"; agentQuery: string }
  | { kind: "open-view"; viewId: string }
  | { kind: "automations" }
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "dispatch"; city: string | null; prompt: string }
  | { kind: "music" }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "unknown"; text: string };

/** Spoken/written names → view ids from docs/VIEWS.md. Unknown ids fall back to Orbit in the shell. */
const VIEW_ALIASES: Record<string, string> = {
  orbit: "orbit",
  planet: "orbit",
  world: "orbit",
  globe: "orbit",
  district: "district",
  districts: "district",
  city: "district",
  room: "room",
  rooms: "room",
  "agent room": "room",
  courier: "courier",
  canvas: "canvas",
  board: "board",
  kanban: "board",
  voice: "voice",
  code: "code",
  editor: "code",
  brain: "brain",
  notes: "brain",
  vault: "brain",
};

/** Examples Alef offers when it can't do something. Every one routes to a real capability. */
export const SUGGESTIONS: readonly string[] = [
  "Who's waiting on me?",
  "What happened today?",
  "Find the session about pricing",
  "Open the board",
  "Play Claude FM",
];

function clean(text: string): string {
  return text
    .trim()
    .replace(/^(?:hey|yo|ok|okay)\s+(?:alef|jev)[,!.\s]*/i, "")
    .replace(/^(?:alef|jev)[,!.\s]+/i, "")
    .replace(/^[,.!\s]+/, "")
    .replace(/^(?:please|can you|could you)\s+/i, "")
    .replace(/[?!.\s]+$/g, "")
    .trim();
}

const CONFIRM_RE = /^(?:yes[,\s]+)?confirm(?:ed)?$/i;
const CANCEL_RE = /^(?:cancel|no|nope|never ?mind|don'?t|abort)$/i;
const APPROVE_RE = /^(?:approve|allow|accept|yes,? approve|let it (?:run|go))(?:\s+(?:it|that|this|the (?:request|approval|command)))?$/i;
const DENY_RE = /^(?:deny|reject|decline|block|refuse)(?:\s+(?:it|that|this|the (?:request|approval|command)))?$/i;
const INBOX_RE = /\b(?:who(?:'s| is| are)? (?:waiting|blocked) (?:on|for) me|who needs me|my inbox|open (?:the |my )?inbox|anyone waiting)\b/i;
const TODAY_RE = /\b(?:what happened today|today'?s (?:report|numbers|recap)|daily (?:report|recap)|how was today|recap (?:of )?today)\b/i;
const FIND_RE = /^(?:find|search(?: for)?|look for|look up|where(?:'s| is)|which session)\s+(?:me\s+)?(?:the\s+|a\s+)?(?:sessions?|notes?|agents?|conversation|work)?\s*(?:about|on|for|with|that|where)?\s*(.+)$/i;
const WHO_WORKED_RE = /^who (?:worked|was working|is working|works) on\s+(.+)$/i;
const FOCUS_RE = /^(?:focus|zoom|lock)\s+(?:on|in on|onto)\s+(.+)$/i;
const OPEN_RE = /^(?:open|show(?: me)?|go to|switch to|take me to)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:view|page|tab))?$/i;
const MUSIC_RE = /\b(?:claude ?fm|play (?:some )?music|pause (?:the )?music|stop (?:the )?music)\b/i;
const HELP_RE = /^(?:help|what can (?:you|i) (?:do|say)|what do you do|commands)$/i;
const DISPATCH_COLON_RE = /^(?:dispatch|send)\s+(?:to\s+)?([^:]+?)\s*:\s*(.+)$/i;
const DISPATCH_RE = /^(?:dispatch|build|tell)\b/i;

function matchCity(name: string, cityNames: readonly string[]): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  return cityNames.find((c) => c.toLowerCase() === n) ?? cityNames.find((c) => c.toLowerCase().includes(n) || n.includes(c.toLowerCase())) ?? null;
}

/** Utterance (spoken or typed) → one intent. Pure; `cityNames` are the known city display names. */
export function parseIntent(raw: string, cityNames: readonly string[] = []): VoiceIntent {
  const text = clean(raw);
  if (!text) return { kind: "unknown", text: "" };
  if (CONFIRM_RE.test(text)) return { kind: "confirm" };
  if (CANCEL_RE.test(text)) return { kind: "cancel" };
  if (STOP_WORD_RE.test(text)) return { kind: "stop" };
  if (APPROVE_RE.test(text)) return { kind: "approve" };
  if (DENY_RE.test(text)) return { kind: "deny" };
  if (HELP_RE.test(text)) return { kind: "help" };
  if (INBOX_RE.test(text)) return { kind: "inbox" };
  if (TODAY_RE.test(text)) return { kind: "today" };
  if (MUSIC_RE.test(text)) return { kind: "music" };

  const colon = DISPATCH_COLON_RE.exec(text);
  if (colon?.[1] && colon[2]) {
    return { kind: "dispatch", city: matchCity(colon[1], cityNames), prompt: colon[2].trim() };
  }
  if (DISPATCH_RE.test(text)) {
    const r = routeUtterance(text, cityNames);
    if (r.kind === "dispatch" && r.prompt) return { kind: "dispatch", city: r.city, prompt: r.prompt };
  }

  const focus = FOCUS_RE.exec(text);
  if (focus?.[1]) return { kind: "focus", agentQuery: focus[1].trim() };

  const who = WHO_WORKED_RE.exec(text);
  if (who?.[1]) return { kind: "find", query: who[1].trim() };
  const find = FIND_RE.exec(text);
  if (find?.[1] && find[1].trim().length > 1) return { kind: "find", query: find[1].trim() };

  const open = OPEN_RE.exec(text);
  if (open?.[1]) {
    const target = open[1].trim().toLowerCase();
    if (/^(?:automations?|quick prompts?|routines?)$/.test(target)) return { kind: "automations" };
    const viewId = VIEW_ALIASES[target];
    if (viewId) return { kind: "open-view", viewId };
  }
  return { kind: "unknown", text };
}

// ---------------------------------------------------------------- agent lookup

export interface AgentRef {
  id: string;
  title: string;
  /** Claude Code's own name (the user's /rename or its AI title): matched as well as the first prompt. */
  displayName?: string | null;
  islandId: string;
  lastActive: string;
}

/** Both names a session answers to, lowercased: its Claude Code name and its first prompt. */
function spokenNames(a: AgentRef): string[] {
  return [a.displayName ?? "", a.title].filter(Boolean).map((n) => n.toLowerCase());
}

/** Best agent for "focus on <query>": exact name, then name/city contains, most recent wins. */
export function resolveAgent(query: string, agents: readonly AgentRef[]): AgentRef | null {
  const q = query.trim().toLowerCase().replace(/^(?:the\s+)?(?:agent\s+)?/, "").replace(/\s+(?:agent|session)$/, "");
  if (!q) return null;
  const recent = [...agents].sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  return (
    recent.find((a) => spokenNames(a).includes(q) || a.id === query.trim()) ??
    recent.find((a) => spokenNames(a).some((n) => n.includes(q))) ??
    recent.find((a) => a.islandId.toLowerCase() === q) ??
    recent.find((a) => q.split(/\s+/).every((w) => `${spokenNames(a).join(" ")} ${a.islandId}`.toLowerCase().includes(w))) ??
    null
  );
}

// ---------------------------------------------------------------- spoken confirmation

export const CONFIRM_TTL_MS = 20_000;

/** The approval card currently on screen in the Voice view (the oldest pending one). */
export interface VisibleApproval {
  id: string;
  toolName: string;
  /** One line: the command / file / URL, already sanitized by the server. */
  summary: string;
}

export type ConfirmState =
  | { kind: "idle" }
  | { kind: "armed"; behavior: "allow" | "deny"; approvalId: string; toolName: string; summary: string; expiresAt: number };

export type ConfirmEffect =
  | { kind: "none" }
  | { kind: "say"; text: string }
  | { kind: "decide"; approvalId: string; behavior: "allow" | "deny"; text: string };

export interface ConfirmStep {
  state: ConfirmState;
  effect: ConfirmEffect;
  /** True when the machine consumed the intent; false = route it normally. */
  handled: boolean;
}

export const IDLE: ConfirmState = { kind: "idle" };

function shortSummary(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 90 ? `${one.slice(0, 89)}…` : one;
}

/**
 * Feed every intent through here first. approve/deny ARM (never decide); only a later,
 * separate "confirm" for the same, still-visible approval decides it. Anything else while
 * armed disarms (so a stray "confirm" much later can't approve something).
 */
export function stepConfirm(state: ConfirmState, intent: VoiceIntent, now: number, visible: VisibleApproval | null): ConfirmStep {
  const live: ConfirmState = state.kind === "armed" && now > state.expiresAt ? IDLE : state;
  const expired = state.kind === "armed" && live.kind === "idle";

  if (intent.kind === "approve" || intent.kind === "deny") {
    if (!visible) {
      return { state: IDLE, effect: { kind: "say", text: "There's no approval on screen to answer." }, handled: true };
    }
    const behavior = intent.kind === "approve" ? "allow" : "deny";
    const verb = behavior === "allow" ? "approve" : "deny";
    return {
      state: { kind: "armed", behavior, approvalId: visible.id, toolName: visible.toolName, summary: visible.summary, expiresAt: now + CONFIRM_TTL_MS },
      effect: { kind: "say", text: `Say "confirm" to ${verb} ${visible.toolName}: ${shortSummary(visible.summary)}. Or say "cancel".` },
      handled: true,
    };
  }

  if (intent.kind === "confirm") {
    if (live.kind !== "armed") {
      const text = expired ? "That confirmation timed out. Say approve or deny again." : "There's nothing to confirm.";
      return { state: IDLE, effect: { kind: "say", text }, handled: true };
    }
    if (!visible || visible.id !== live.approvalId) {
      return { state: IDLE, effect: { kind: "say", text: "That approval isn't on screen anymore, so I did nothing." }, handled: true };
    }
    const done = live.behavior === "allow" ? "Approved" : "Denied";
    return { state: IDLE, effect: { kind: "decide", approvalId: live.approvalId, behavior: live.behavior, text: `${done} ${live.toolName}.` }, handled: true };
  }

  if (intent.kind === "cancel") {
    if (live.kind === "armed") return { state: IDLE, effect: { kind: "say", text: "Cancelled. Nothing was sent." }, handled: true };
    return { state: IDLE, effect: { kind: "none" }, handled: false };
  }

  // Any other intent disarms and is routed normally.
  return { state: IDLE, effect: { kind: "none" }, handled: false };
}

// ---------------------------------------------------------------- what Alef says

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface WaitingAgent {
  title: string;
  city: string;
}

export function inboxAnswer(waiting: readonly WaitingAgent[]): string {
  if (waiting.length === 0) return "Nobody is waiting on you. Inbox zero.";
  const top = waiting.slice(0, 3).map((a) => `${a.title} in ${a.city}`);
  const more = waiting.length > 3 ? `, plus ${waiting.length - 3} more` : "";
  const who = waiting.length === 1 ? "One agent is" : `${waiting.length} agents are`;
  return `${who} waiting on you: ${list(top)}${more}.`;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function todayAnswer(report: DailyReport): string {
  if (report.sessions === 0 && report.events === 0) return "Nothing has happened yet today.";
  const cities = report.perCity.length;
  const parts = [`Today: ${fmt(report.sessions)} ${report.sessions === 1 ? "session" : "sessions"}, ${fmt(report.events)} events across ${cities} ${cities === 1 ? "city" : "cities"}`];
  const busiest = [...report.perCity].sort((a, b) => b.events - a.events)[0];
  if (busiest) parts.push(`busiest was ${busiest.name} with ${fmt(busiest.events)} events`);
  const tool = report.topTools[0];
  if (tool) parts.push(`top tool ${tool.name}, used ${fmt(tool.count)} times`);
  return `${parts.join("; ")}.`;
}

export function unknownAnswer(): string {
  return `I can't do that yet. Try: ${SUGGESTIONS.slice(0, 3).map((s) => `"${s}"`).join(", ")}.`;
}

export function helpAnswer(): string {
  return "I can tell you who's waiting on you, what happened today, find a session, focus on an agent, open a view, fill a dispatch for you to send, play Claude FM, and answer an approval on screen after you confirm.";
}
