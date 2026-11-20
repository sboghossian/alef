// Pure rendering for the Alef resident (no DOM, no ctx): a ResidentState in, an HTML string out,
// so every section is covered by resident-lib.test.ts without a browser. Everything the resident
// wrote (goals, journal, skills, proposal text, audit reasons) came from a model that read fleet
// titles: untrusted, so every string goes through escapeHtml.

import type { ResidentProposal, ResidentState } from "../../../shared/features/resident";
import { escapeHtml, relativeTime } from "../ui/fuzzy";

const KIND_LABEL: Record<ResidentProposal["kind"], string> = { session: "Session", skill: "Skill", memory: "Memory", note: "Note" };

// ── Mark approved / Put in prompt box (round: broken-fixes) ────────────────
// Approve only ever rewrote the proposal's status (0 spawns) — the button read like an action.
// These labels are honest about that; "Put in prompt box" is the one real, opt-in effect a
// "session" proposal can have, and even that never sends anything by itself.
export const APPROVE_BUTTON_LABEL = "Mark approved";
export const APPROVE_BUTTON_TITLE = "Records your OK. Nothing runs by itself.";
export const APPROVE_TOAST = "Marked approved. Nothing runs by itself.";
export const DRAFT_BUTTON_LABEL = "Put in prompt box";
export const DRAFT_TOAST = "In the prompt box. Pick a city and press Dispatch to run it.";
export const RESIDENT_SAVING_LABEL = "Saving… (the resident may be thinking, up to a minute)";
/** Approve/dismiss run inside the resident's own serial chain, right behind an up-to-90s
 *  reflection (server resident.ts's REFLECT_TIMEOUT_MS) — the default ~20s client timeout could
 *  read "timed out" while the write still lands a moment later. */
export const RESIDENT_MUTATION_TIMEOUT_MS = 100_000;

/** The prompt a "Put in prompt box" click fills: the proposal's own title, a blank line, then
 *  its why. Both came from a model that read fleet titles — untrusted — but this only ever
 *  reaches a plain `<textarea>.value`, never markup, so no escaping is needed here. */
export function draftPrompt(p: Pick<ResidentProposal, "title" | "why">): string {
  return `${p.title}\n\n${p.why}`;
}

function when(iso: string | null, now: number): string {
  return iso ? relativeTime(iso, now) : "never";
}

function proposalRow(p: ResidentProposal): string {
  const open = p.status === "open";
  const draftBtn =
    open && p.kind === "session" ? `<button type="button" class="res-btn" data-res-draft="${escapeHtml(p.id)}">${escapeHtml(DRAFT_BUTTON_LABEL)}</button>` : "";
  const actions = open
    ? `<div class="res-actions">
        <button type="button" class="res-btn res-btn-primary" data-res-approve="${escapeHtml(p.id)}" title="${escapeHtml(APPROVE_BUTTON_TITLE)}">${escapeHtml(APPROVE_BUTTON_LABEL)}</button>
        ${draftBtn}
        <button type="button" class="res-btn" data-res-dismiss="${escapeHtml(p.id)}">Dismiss</button>
      </div>`
    : `<span class="res-status">${p.status}</span>`;
  return `<li class="res-row${open ? "" : " res-row-done"}" data-kind="${p.kind}">
    <span class="res-meta">${KIND_LABEL[p.kind]}</span>
    <span class="res-title">${escapeHtml(p.title)}</span>
    <span class="res-why">${escapeHtml(p.why)}</span>
    ${actions}
  </li>`;
}

/** The Inbox section: open proposals only. Empty string when there are none. */
export function renderResidentInbox(s: ResidentState): string {
  const open = s.proposals.filter((p) => p.status === "open");
  if (open.length === 0) return "";
  return `<h3 class="alef-pane-h res-h">${escapeHtml(s.name)} proposes <span class="alef-fcount">${open.length}</span></h3>
    <p class="res-note">Approving only marks it. Nothing runs; you act on it yourself.</p>
    <ul class="res-list">${open.map(proposalRow).join("")}</ul>`;
}

/** The full panel. */
export function renderResidentPanel(s: ResidentState, now = Date.now()): string {
  const pct = s.spend.capUsd > 0 ? Math.min(100, Math.round((s.spend.todayUsd / s.spend.capUsd) * 100)) : 100;
  const goals = s.goals.length ? `<ul class="res-goals">${s.goals.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>` : `<p class="res-empty">No goals yet.</p>`;
  const skills = s.skills.length ? `<div class="res-chips">${s.skills.map((k) => `<span class="res-chip">${escapeHtml(k)}</span>`).join("")}</div>` : `<p class="res-empty">No skills written yet.</p>`;
  const journal = s.journalTail.length ? `<div class="res-journal">${s.journalTail.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>` : `<p class="res-empty">Nothing in today's journal yet.</p>`;
  const proposals = s.proposals.length ? `<ul class="res-list">${s.proposals.map(proposalRow).join("")}</ul>` : `<p class="res-empty">No proposals.</p>`;
  const writes = s.recentWrites.length
    ? `<ul class="res-writes">${[...s.recentWrites]
        .reverse()
        .map((w) => `<li><span class="res-w-when">${escapeHtml(relativeTime(w.at, now))}</span> <code>${escapeHtml(w.path)}</code> <span class="res-w-bytes">${w.bytes} B</span> <span class="res-w-why">${escapeHtml(w.reason)}</span></li>`)
        .join("")}</ul>`
    : `<p class="res-empty">No writes yet.</p>`;
  return `<div class="res">
    <div class="res-head">
      <div class="res-id"><strong class="res-name">${escapeHtml(s.name)}</strong><span class="res-day">Day ${s.day}</span></div>
      <button type="button" class="res-btn res-toggle${s.enabled ? " res-on" : ""}" data-res-enabled="${s.enabled ? "false" : "true"}" aria-pressed="${s.enabled}">${s.enabled ? "On · switch off" : "Off · switch on"}</button>
    </div>
    <p class="res-note">Lives in <code>~/.alef-resident</code> and can only write there. Its models get no tools; the server validates and writes. Last look ${escapeHtml(when(s.lastTickAt, now))} · last reflection ${escapeHtml(when(s.lastReflectAt, now))}.</p>
    ${s.lastError ? `<p class="res-error" role="status">${escapeHtml(s.lastError)}</p>` : ""}
    <div class="res-spend" title="Estimated spend of today's Haiku reflections vs the daily cap">
      <div class="res-spend-bar" style="--pct:${pct}%"></div>
      <span>$${s.spend.todayUsd.toFixed(3)} of $${s.spend.capUsd.toFixed(2)} today</span>
    </div>
    <h4 class="res-sec">Goals</h4>${goals}
    <h4 class="res-sec">Skills</h4>${skills}
    <h4 class="res-sec">Journal (today)</h4>${journal}
    <h4 class="res-sec">Proposals</h4>${proposals}
    <h4 class="res-sec">Recent writes</h4>${writes}
  </div>`;
}
