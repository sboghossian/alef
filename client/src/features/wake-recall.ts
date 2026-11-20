// "wake-recall" (client): every session's agent panel says whether it read from the Institute of
// Truth the moment it woke up, e.g. "Woke with 8 notes from the Institute of Truth" or "Woke with
// nothing (headless run): the recall hook timed out", from GET /api/wake-recall/session/:id and
// the server's WS pushes. The vault-relative note paths are listed; note contents never reach the
// client. It also keeps the server's summary (snapshot extra + pushes) for the Explain layer's
// Institute of Truth card (explain.ts). Paths are untrusted transcript text: textContent only.
// Observe only: no buttons, no requests beyond the GET.

import "./wake-recall.css";
import {
  isWakeRecallEntry,
  isWakeRecallSummary,
  promptRecallLine,
  wakeLine,
  WAKE_RECALL_SUMMARY_KEY,
  type WakeRecallEntry,
  type WakeRecallSessionResponse,
  type WakeRecallSummary,
} from "../../../shared/features/wake-recall";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";

const SLOT = "fx-wake-recall";
const NOTES_SHOWN = 8;
const REFETCH_MS = 60_000;

let summary: WakeRecallSummary | null = null;
/** sessionId → its entry; null = the server has no record for it (e.g. no transcript on disk). */
const entries = new Map<string, WakeRecallEntry | null>();
const fetchedAt = new Map<string, number>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

/** The server's latest summary, or null before the first snapshot. */
export function wakeRecallSummary(): WakeRecallSummary | null {
  return summary;
}

/** Called whenever the summary changes; returns an unsubscribe. */
export function onWakeRecallSummary(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSummary(next: WakeRecallSummary): void {
  summary = next;
  for (const fn of listeners) fn();
}

function fetchEntry(ctx: ClientContext, agentId: string): void {
  const at = fetchedAt.get(agentId);
  if (inFlight.has(agentId) || (at !== undefined && Date.now() - at < REFETCH_MS)) return;
  inFlight.add(agentId);
  void ctx.api.getJson<WakeRecallSessionResponse>(`/api/wake-recall/session/${encodeURIComponent(agentId)}`, 8000).then((res) => {
    inFlight.delete(agentId);
    if (!isRecord(res) || res.ok !== true) return; // unreachable: try again on the next render
    const entry = isWakeRecallEntry(res.entry) ? res.entry : null;
    if (entry === null && res.ready !== true) return; // still reading transcripts: don't cache a "no record"
    fetchedAt.set(agentId, Date.now());
    entries.set(agentId, entry);
    refreshAgentPanel(SLOT, (id, slot) => renderPanel(id, slot, ctx));
  });
}

function renderPanel(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  slot.replaceChildren();
  fetchEntry(ctx, agentId);
  const e = entries.get(agentId);
  if (!e) return; // loading, or no record: say nothing rather than guess
  const line = h("div", `wr-line wr-${e.state}`, `🏛️ ${wakeLine(e)}`);
  if (e.wokeAt) line.title = `Woke ${new Date(e.wokeAt).toLocaleString()} · ${e.hook ?? "recall hook"} (${e.wakeEvent ?? "SessionStart"})`;
  slot.append(line);
  const prompt = promptRecallLine(e);
  if (prompt) slot.append(h("div", "wr-sub", prompt));
  if (e.notes.length > 0) {
    const ul = h("ul", "wr-notes");
    for (const n of e.notes.slice(0, NOTES_SHOWN)) ul.append(h("li", undefined, n));
    if (e.notes.length > NOTES_SHOWN) ul.append(h("li", "wr-more", `+${e.notes.length - NOTES_SHOWN} more`));
    slot.append(ul);
  }
}

export const wakeRecallFeature: ClientFeature = {
  id: "wake-recall",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, slot) => renderPanel(id, slot, ctx));
  },
  onSnapshot(world) {
    const s = world.extras?.[WAKE_RECALL_SUMMARY_KEY];
    if (isWakeRecallSummary(s)) setSummary(s);
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "entries" || !Array.isArray(p.entries)) return;
    const now = Date.now();
    for (const e of p.entries) {
      if (!isWakeRecallEntry(e)) continue;
      entries.set(e.sessionId, e);
      fetchedAt.set(e.sessionId, now);
    }
    if (isWakeRecallSummary(p.summary)) setSummary(p.summary);
    refreshAgentPanel(SLOT, (id, slot) => renderPanel(id, slot, ctx));
  },
};
