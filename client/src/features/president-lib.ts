// Pure rendering for the Inbox's "Jev proposes" section (round 10), plus the toasts its
// Dismiss shows. No DOM, no ctx — a board in, an HTML string out — so every row shape is
// covered by president-lib.test.ts without a browser. `client/src/features/inbox.ts` (the
// existing Inbox tab) calls this and appends the result below its own waiting-list markup; `client/src/features/president.ts` owns the fetch,
// the actions (Launch/Dismiss/Merge/Undo) and the Settings row.

import { escapeHtml } from "../ui/fuzzy";
import {
  DISMISS_COOLDOWN_MS,
  type CommencementAction,
  type PresidentActionResult,
  type PresidentBoard,
  type PresidentCommencementProposal,
  type PresidentMergeProposal,
  type PresidentOrigin,
  type PresidentRecord,
  type PresidentSessionProposal,
} from "../../../shared/features/president";

/** Where a proposal came from, as the meta line says it. "treatment" answers open sickness cases;
 *  "new tripwire" drafts a rule for a disease that keeps recurring. */
const ORIGIN_LABEL: Readonly<Record<PresidentOrigin, string>> = { loop: "open loop", stale: "stale todo", health: "health check", treat: "treatment", research: "new tripwire" };

function originText(p: PresidentSessionProposal): string {
  if (!p.origin) return "";
  const cases = p.caseIds?.length ? ` (${p.caseIds.length} case${p.caseIds.length === 1 ? "" : "s"})` : "";
  return ` · ${ORIGIN_LABEL[p.origin]}${cases}`;
}

/** The in-flight key a proposal's launch runs under (launch-result.ts runLaunchOnce). */
export function presidentLaunchKey(id: string): string {
  return `president:${id}`;
}

function sessionRowHtml(p: PresidentSessionProposal, launching: boolean): string {
  const launch = launching
    ? `<button type="button" class="pres-btn pres-btn-primary" data-launch="${escapeHtml(p.id)}" disabled aria-busy="true">Starting…</button>`
    : `<button type="button" class="pres-btn pres-btn-primary" data-launch="${escapeHtml(p.id)}">Launch</button>`;
  return `<li class="pres-row" data-kind="session">
    <div class="pres-main">
      <span class="pres-task">${escapeHtml(p.task)}</span>
      <span class="pres-meta">${escapeHtml(p.city)} · ${escapeHtml(p.model)}${escapeHtml(originText(p))}</span>
      <span class="pres-why">${escapeHtml(p.why)}</span>
    </div>
    <div class="pres-actions">
      ${launch}
      <button type="button" class="pres-btn" data-dismiss="${escapeHtml(p.id)}">Dismiss</button>
    </div>
  </li>`;
}

function mergeRowHtml(p: PresidentMergeProposal): string {
  return `<li class="pres-row" data-kind="merge">
    <div class="pres-main">
      <span class="pres-task">Merge ${p.districts.length} districts into ${escapeHtml(p.into)}</span>
      <span class="pres-meta">${escapeHtml(p.districts.join(", "))}</span>
      <span class="pres-why">${escapeHtml(p.why)}</span>
    </div>
    <div class="pres-actions">
      <button type="button" class="pres-btn pres-btn-primary" data-merge="${escapeHtml(p.id)}">Merge</button>
      <button type="button" class="pres-btn" data-dismiss="${escapeHtml(p.id)}">Dismiss</button>
    </div>
  </li>`;
}

/** What each commencement action does when clicked, said on the card itself. */
const ACTION_META: Readonly<Record<CommencementAction, string>> = {
  schedule: "schedule · a plan-mode session drafts the routine; nothing is loaded",
  retire: "retire · only changes what Alef shows",
  hire: "first job · plan mode, in the loop's folder",
  hook: "lesson → hook · a plan-mode session drafts it; nothing is installed",
};

/** An unload-only card (a retired worker whose routine launchd still runs). */
const UNLOAD_META = "unload · a plan-mode session shows the routine; it unloads only after you confirm there";

/** Retire's confirm: what the click writes, and what it never touches. */
export function retireConfirmText(subject: string): string {
  return `Retire ${subject}? This only changes what Alef shows (data/careers.json): nothing is written to launchd, skills or transcripts. Un-retire in the Tower undoes it.`;
}

function launchButton(id: string, label: string, launching: boolean, primary: boolean): string {
  const cls = primary ? "pres-btn pres-btn-primary" : "pres-btn";
  return launching
    ? `<button type="button" class="${cls}" data-launch="${escapeHtml(id)}" disabled aria-busy="true">Starting…</button>`
    : `<button type="button" class="${cls}" data-launch="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
}

function commencementRowHtml(p: PresidentCommencementProposal, launching: boolean): string {
  let actions: string;
  if (p.action === "retire") {
    const unload = p.unloadStartedAs
      ? `<span class="pres-note">Unload session started: ${escapeHtml(p.unloadStartedAs)}</span>`
      : p.routine
        ? launchButton(p.id, `Unload ${p.routine}… (plan mode)`, launching, false)
        : "";
    const retire = p.retired ? "" : `<button type="button" class="pres-btn pres-btn-primary" data-retire="${escapeHtml(p.id)}" data-subject="${escapeHtml(p.subject)}">Retire…</button>`;
    actions = `${retire}${unload}`;
  } else {
    actions = launchButton(p.id, "Launch (plan mode)", launching, true);
  }
  const task = p.task
    ? `<details class="pres-task-text"><summary>${p.action === "retire" ? "The unload session's task" : "The task it starts with"}</summary><pre>${escapeHtml(p.task)}</pre></details>`
    : "";
  return `<li class="pres-row pres-comm" data-kind="commencement" data-action="${escapeHtml(p.action)}">
    <div class="pres-main">
      <span class="pres-task">${escapeHtml(p.title)}</span>
      <span class="pres-meta">${escapeHtml(p.retired ? UNLOAD_META : ACTION_META[p.action])}</span>
      <span class="pres-why">${escapeHtml(p.why)}</span>
      ${task}
    </div>
    <div class="pres-actions">
      ${actions}
      <button type="button" class="pres-btn" data-dismiss="${escapeHtml(p.id)}">Dismiss</button>
    </div>
  </li>`;
}

/** The record line, from the server's ledger (shared/features/president.ts PresidentRecord). The
 *  line itself is the three counts; the hover title says what else the ledger knows. */
export function recordLineHtml(r: PresidentRecord, nowMs: number = Date.now()): string {
  const since = r.since ? r.since.slice(0, 10) : null;
  const detail = [
    `${r.dismissed} dismissed`,
    `${r.launched} launched, ${r.linked} of them with a session Alef could follow to its outcome`,
    ...(r.rulesShown > 0 ? [`${r.rulesShown} more shown by the rules fallback while Jev gave no answer (not counted)`] : []),
    since ? `record kept since ${since}` : "no record yet",
  ].join(" · ");
  const young = since && nowMs - Date.parse(r.since ?? "") < r.days * 86_400_000 ? ` (record since ${since})` : "";
  return `<p class="pres-record" title="${escapeHtml(detail)}">Jev's proposals, ${r.days} days: ${r.shown} shown · ${r.actedOn} acted on · ${r.shipped} shipped${escapeHtml(young)}</p>`;
}

/** Empty string (renders nothing) when Jev has no proposals right now and no record to report —
 *  the Inbox never shows an empty "Jev proposes" shell. Commencement proposals get their own block
 *  under the session/merge list, and the record line closes the section. */
export function renderProposalsSection(board: PresidentBoard, launching: (id: string) => boolean = () => false, nowMs: number = Date.now()): string {
  const record = board.record;
  if (board.proposals.length === 0) return record && record.shown > 0 ? recordLineHtml(record, nowMs) : "";
  const main = board.proposals.flatMap((p) => (p.kind === "session" ? [sessionRowHtml(p, launching(p.id))] : p.kind === "merge" ? [mergeRowHtml(p)] : []));
  const commencement = board.proposals.flatMap((p) => (p.kind === "commencement" ? [commencementRowHtml(p, launching(p.id))] : []));
  const mainHtml = main.length ? `<ul class="pres-list">${main.join("")}</ul>` : "";
  const commencementHtml = commencement.length
    ? `<h4 class="pres-sub">🎓 Commencement <span class="alef-fcount">${commencement.length}</span></h4><ul class="pres-list">${commencement.join("")}</ul>`
    : "";
  return `<h3 class="alef-pane-h pres-h">Jev proposes <span class="alef-fcount">${board.proposals.length}</span></h3>${mainHtml}${commencementHtml}${record ? recordLineHtml(record, nowMs) : ""}`;
}

/** Retire's toast. */
export function retireToast(r: PresidentActionResult): { text: string; kind: "info" | "error" } {
  if (!r.ok) return { text: `Couldn't retire: ${r.error ?? "unknown error"}`, kind: "error" };
  return { text: "Retired. The Tower lists it as retired now (display only; Un-retire there undoes it).", kind: "info" };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "for 7 days" for a whole number of days or hours; "for a while" for anything else. */
export function cooldownText(ms: number): string {
  if (ms > 0 && ms % DAY_MS === 0) return `for ${ms / DAY_MS} day${ms === DAY_MS ? "" : "s"}`;
  if (ms > 0 && ms % HOUR_MS === 0) return `for ${ms / HOUR_MS} hour${ms === HOUR_MS ? "" : "s"}`;
  return "for a while";
}

/** Dismiss's toast. The server's cooldown is shared/features/president.ts DISMISS_COOLDOWN_MS. */
export function dismissToast(r: PresidentActionResult, cooldownMs = DISMISS_COOLDOWN_MS): { text: string; kind: "info" | "error" } {
  if (!r.ok) return { text: `Couldn't dismiss: ${r.error ?? "unknown error"}`, kind: "error" };
  return { text: `Dismissed. Jev won't suggest it again ${cooldownText(cooldownMs)}.`, kind: "info" };
}
