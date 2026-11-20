// "jobs": each minion's job (lawyer / hacker / learner / builder / gatherer, or "no job evidence")
// with the signal behind it, computed by the server (server/features/jobs.ts). Two surfaces, both
// read-only:
//   - the agent panel: a "Job" row right under "Role" (the role stays; the job sits beside it);
//   - the drone (subagent) panel: the same row, via jobFactRow() from subagents.ts.
// Session verdicts arrive whole from GET /api/jobs/by-agent on every snapshot and in each WS push; a
// subagent's is fetched from GET /api/jobs/:id when its panel opens. Reasons are rendered with
// textContent only.

import "./jobs.css";
import { JOBS_BY_AGENT_PATH, parseJobsByAgent, parseJobsMessage, type JobVerdict } from "../../../shared/features/jobs";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import { chipView, JobCache, verdictFromEntry } from "./jobs-lib";
import { lateExtra, type LateExtra } from "./late-extra";
import type { ClientContext, ClientFeature } from "./registry";

const SLOT = "fx-jobs";
const ROW = "fx-job-row";
/** The agent panel's own row (removed and redrawn on every refresh). */
const AGENT_ROW = "fx-job-agent";

const cache = new JobCache();
const inflight = new Map<string, Promise<JobVerdict | null>>();
let byAgentLoad: LateExtra | null = null;

function load(ctx: ClientContext, id: string): Promise<JobVerdict | null> {
  let p = inflight.get(id);
  if (!p) {
    p = ctx.api.getJson<unknown>(`/api/jobs/${encodeURIComponent(id)}`).then((body) => {
      inflight.delete(id);
      const v = verdictFromEntry(body);
      if (v) cache.put(id, v, Date.now());
      return v;
    });
    inflight.set(id, p);
  }
  return p;
}

function fill(el: HTMLElement, v: JobVerdict | null): void {
  const view = chipView(v);
  const chip = h("span", `job-chip job-${view.kind}`, view.label);
  chip.title = view.title;
  el.replaceChildren(chip);
  if (view.reason) el.append(h("span", "job-reason", view.reason));
}

/** The job chip + its reason for one minion (a session or a subagent id). */
export function jobBadge(ctx: ClientContext, id: string): HTMLElement {
  const el = h("span", "job-badge");
  const known = cache.get(id, Date.now());
  if (known !== undefined) fill(el, known);
  else {
    el.append(h("span", "job-reason", "job: checking…"));
    void load(ctx, id).then((v) => fill(el, v));
  }
  return el;
}

/** A "Job" <dt>/<dd> pair for a facts list (the drone panel's). */
export function jobFactRow(ctx: ClientContext, id: string, cls = ROW): HTMLElement[] {
  const dd = h("dd", cls);
  dd.append(jobBadge(ctx, id));
  return [h("dt", cls, "Job"), dd];
}

/** The agent panel's "Role" <dd>, if the panel shows one. */
function roleDd(content: Element): Element | null {
  for (const dt of content.querySelectorAll("dl > dt")) {
    if (dt.textContent !== "Role") continue;
    const dd = dt.nextElementSibling;
    return dd?.tagName === "DD" ? dd : null;
  }
  return null;
}

function renderAgent(ctx: ClientContext, agentId: string, slot: HTMLElement): void {
  const content = slot.parentElement;
  content?.querySelectorAll(`.${AGENT_ROW}`).forEach((n) => n.remove());
  slot.replaceChildren();
  const row = jobFactRow(ctx, agentId, `${ROW} ${AGENT_ROW}`);
  const role = content ? roleDd(content) : null;
  if (role) role.after(...row);
  else {
    const dl = h("dl", "job-dl");
    dl.append(...row);
    slot.append(dl);
  }
}

export const jobsFeature: ClientFeature = {
  id: "jobs",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, slot) => renderAgent(ctx, id, slot));
    byAgentLoad = lateExtra(
      () => ctx.api.getJson<unknown>(JOBS_BY_AGENT_PATH),
      (body) => {
        cache.setSessions(parseJobsByAgent(isRecord(body) ? body.byAgent : null));
        refreshAgentPanel(SLOT, (id, slot) => renderAgent(ctx, id, slot));
      },
    );
  },
  onSnapshot() {
    byAgentLoad?.refresh();
  },
  onMessage(msg, ctx) {
    const m = parseJobsMessage(msg.payload);
    if (!m) return;
    const apply = (): void => {
      cache.setSessions(m.byAgent);
      refreshAgentPanel(SLOT, (id, slot) => renderAgent(ctx, id, slot));
    };
    // A push is the whole map: an answer still in flight is older, so it is dropped.
    if (byAgentLoad) byAgentLoad.push("replace", apply);
    else apply();
  },
};
