// "skills" (Round 8 H3, School tab added later): makes the skill system visible.
//   - Agent panel section "Skills used": what this session fired/typed/was offered, from
//     snapshot extras ("skills.recent"), WS pushes, and a lazy per-session fetch for agents
//     not covered by the recent window — same shape as todos.ts's fetchList/ingest.
//   - Feature panel "skills" (three tabs: Top used / Graveyard / School), opened from the
//     palette ("Skills…") and a Settings-menu HUD button. The third tab's id stays
//     "candidates" (only its label changed) so old deep links keep working. It was labelled
//     "Institute" until the memory buildings became the Institute of Truth (wake-recall).
// Skill names/descriptions and transcript-derived data are untrusted: every value here is
// rendered via textContent (the `h` helper), never innerHTML.

import "./skills.css";
import type {
  DarwinRoundSummary,
  ImprovementSnapshot,
  InstituteSnapshot,
  SkillCandidate,
  SkillEvent,
  SkillFailureModeRow,
  SkillsBackfillProgress,
  SkillsOpenEditorRequest,
  SkillsOpenEditorResult,
  SkillsSessionResult,
  SkillsSnapshot,
  SkillsSnapshotResult,
  SkillUsageRow,
} from "../../../shared/features/skills";
import { coverageLine, coverageSourcesLine, parseTripwireCoverage, parseTripwireHits, TRIPWIRES_COVERAGE_KEY, TRIPWIRES_HIT_CAP, TRIPWIRES_HITS_KEY, type TripwireCoverage, type TripwireHit } from "../../../shared/features/tripwires";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import { relativeTime } from "../ui/fuzzy";
import {
  bucketBySession,
  candidateEmptyReason,
  graveyardWindowLabel,
  INSTITUTE_TAB_ID,
  mergeEvents,
  pairsLine,
  parseSkillEvents,
  repeatingLessons,
  residentSkillsLine,
  revisionsLine,
  skillKindLabel,
  SKILLS_TABS,
  type SkillsTabId,
} from "./skills-lib";
import type { ClientContext, ClientFeature, ClientPanel } from "./registry";

const PANEL_ID = "skills";
const SLOT = "fx-skills";
const RECENT_EXTRAS_KEY = "skills.recent";

/** The School tab's "lessons that keep repeating" block reads this straight from the world
 *  snapshot's extras (the tripwires feature owns it) rather than a round trip of its own — see
 *  onSnapshot below. It only ever replaces wholesale (a snapshot carries the server's whole
 *  kept list), same as the tripwires client feature's own ingest. */
let tripwireHits: TripwireHit[] = [];
/** "N lessons written, 12 guarded" (server-counted), null until the server counted once. */
let tripwireCoverage: TripwireCoverage | null = null;

// ---------------------------------------------------------------- agent panel section

const sessionEvents = new Map<string, SkillEvent[]>();
const requestedSessions = new Set<string>();

function fetchSessionEvents(ctx: ClientContext, agentId: string): void {
  if (requestedSessions.has(agentId)) return;
  requestedSessions.add(agentId);
  void ctx.api.getJson<SkillsSessionResult>(`/api/skills/session/${encodeURIComponent(agentId)}`).then((res) => {
    const events = res?.ok ? parseSkillEvents(res.events) : [];
    if (events.length === 0) return;
    sessionEvents.set(agentId, mergeEvents(sessionEvents.get(agentId) ?? [], events));
    refreshAgentPanel(SLOT, (id, slot) => renderAgentPanel(id, slot, ctx));
  });
}

function ingestEvents(events: SkillEvent[], ctx: ClientContext): void {
  if (events.length === 0) return;
  for (const [sessionId, evs] of bucketBySession(events)) sessionEvents.set(sessionId, mergeEvents(sessionEvents.get(sessionId) ?? [], evs));
  refreshAgentPanel(SLOT, (id, slot) => renderAgentPanel(id, slot, ctx));
}

function renderAgentPanel(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  slot.replaceChildren();
  const events = sessionEvents.get(agentId);
  if (events === undefined) {
    fetchSessionEvents(ctx, agentId);
    return;
  }
  if (events.length === 0) return;
  const recent = [...events].reverse().slice(0, 20);
  slot.append(h("h3", "sk-head", `Skills (${events.length})`));
  const ul = h("ul", "sk-used-list");
  for (const e of recent) {
    const li = h("li");
    li.append(h("span", "sk-used-name", e.skillName), h("span", "sk-used-badge", `${skillKindLabel(e.kind)} · ${relativeTime(e.at)}`));
    ul.appendChild(li);
  }
  slot.append(ul);
}

// ---------------------------------------------------------------- feature panel (3 tabs)

interface PanelHost {
  el: HTMLElement;
  ctx: ClientContext;
}

let host: PanelHost | null = null;
let activeTab: SkillsTabId = "top";
let snapshot: SkillsSnapshot | null = null;

function renderSkillsPanel(el: HTMLElement, ctx: ClientContext): void {
  host = { el, ctx };
  snapshot = null;
  el.replaceChildren(h("p", "sk-sub", "Loading skills…"));
  void loadSnapshot();
}

async function loadSnapshot(): Promise<void> {
  const h0 = host;
  if (!h0) return;
  const res = await h0.ctx.api.getJson<SkillsSnapshotResult>("/api/skills/snapshot", 15_000);
  if (host !== h0) return; // panel closed/reopened while this was in flight
  if (!res?.ok) {
    h0.el.replaceChildren(h("p", "sk-sub", "Couldn't load the skills snapshot from the world server."));
    return;
  }
  snapshot = res;
  drawPanel();
}

function drawPanel(): void {
  const h0 = host;
  if (!h0 || !snapshot) return;
  const wrap = h("div", "sk-panel");
  const tabsEl = h("div", "sk-tabs");
  const counts: Record<SkillsTabId, number> = { top: snapshot.topUsed.length, graveyard: snapshot.graveyard.length, candidates: snapshot.candidates.length };
  for (const t of SKILLS_TABS) {
    const tabBtn = h("button", `comic-btn small sk-tab${t.id === activeTab ? " sk-active" : ""}`, `${t.label} (${counts[t.id]})`);
    tabBtn.type = "button";
    tabBtn.addEventListener("click", () => {
      activeTab = t.id;
      drawPanel();
    });
    tabsEl.appendChild(tabBtn);
  }
  const bp = snapshot.backfillProgress;
  const subLine = `${snapshot.installedCount} skills installed · scanned ${relativeTime(snapshot.scannedAt)}` + (bp.done ? "" : ` · still reading history (${bp.percent}%)`);
  wrap.append(tabsEl, h("p", "sk-sub", subLine));
  const section =
    activeTab === "top"
      ? topUsedSection(snapshot.topUsed)
      : activeTab === "graveyard"
        ? graveyardTab(snapshot.graveyard, bp, snapshot.historyStartAt)
        : instituteSection(snapshot, h0.ctx);
  wrap.append(section);
  h0.el.replaceChildren(wrap);
}

/** While the historical backfill hasn't finished, "0 fires" can't be trusted — a skill last
 *  used months ago and one truly never touched look identical until every transcript has
 *  been read. Show progress instead of the (possibly wrong) list. */
function graveyardTab(rows: readonly SkillUsageRow[], bp: SkillsBackfillProgress, historyStartAt: string | null): HTMLElement {
  if (!bp.done) {
    return h(
      "p",
      "sk-empty",
      bp.filesTotal === 0
        ? "Still reading history (0%) — starting the historical scan…"
        : `Still reading history (${bp.percent}%) — ${bp.filesDone}/${bp.filesTotal} transcripts read so far. The graveyard is unreliable until this finishes (a skill could just look unused because its history hasn't been read yet).`,
    );
  }
  return graveyardSection(rows, historyStartAt);
}

function usageRow(row: SkillUsageRow, meta: string): HTMLElement {
  const li = h("li", "sk-row");
  const top = h("div", "sk-row-top");
  top.append(h("span", "sk-name", row.installed?.name ?? row.slug), h("span", "sk-meta", row.installed?.origin ?? "not currently installed"));
  li.append(top);
  if (row.installed?.description) li.append(h("p", "sk-desc", row.installed.description));
  li.append(h("p", "sk-meta", meta));
  return li;
}

function topUsedSection(rows: readonly SkillUsageRow[]): HTMLElement {
  if (rows.length === 0) return h("p", "sk-empty", "No skill has fired since this feature started tracking (it only sees activity going forward, not history).");
  const ul = h("ul", "sk-rows");
  for (const row of rows) {
    const meta = `${row.fired30d} in 30d · ${row.fired90d} in 90d · ${row.firedTotal} total${row.suggestedTotal ? ` · ${row.suggestedTotal} suggested` : ""}${
      row.lastFiredAt ? ` · last ${relativeTime(row.lastFiredAt)}` : ""
    }`;
    ul.appendChild(usageRow(row, meta));
  }
  return ul;
}

function graveyardSection(rows: readonly SkillUsageRow[], historyStartAt: string | null): HTMLElement {
  if (rows.length === 0) return h("p", "sk-empty", "Nothing installed has gone quiet — every installed skill fired in the last 90 days (or tracking only just started).");
  const windowLabel = graveyardWindowLabel(historyStartAt, Date.now());
  const ul = h("ul", "sk-rows");
  for (const row of rows) {
    const age = row.installed?.updatedAt ? `SKILL.md last touched ${relativeTime(row.installed.updatedAt)}` : "age unknown";
    ul.appendChild(usageRow(row, `${windowLabel} · ${age}`));
  }
  return ul;
}

// ---------------------------------------------------------------- School tab
// Six blocks, in order: the study pipeline's own status, the candidate queue it feeds (with a
// real reason when it's empty), each skill's Darwin self-review rounds, skills already patched
// with an auto-logged failure mode, lessons a live session keeps re-tripping, and "Getting
// better?" (measured change only: SKILL.md revisions, failure mode → later revision pairs, the
// resident's own skills). Everything here is untrusted transcript/log/file text — every value
// goes through `h` (textContent).

function instituteSection(snapshot: SkillsSnapshot, ctx: ClientContext): HTMLElement {
  const wrap = h("div", "sk-institute");
  wrap.append(
    studyStatusBlock(snapshot.institute),
    h("h4", "sk-inst-head", "Candidate queue"),
    candidateQueueBlock(snapshot.candidates, snapshot.institute, ctx),
    h("h4", "sk-inst-head", "Darwin study rounds"),
    darwinRoundsBlock(snapshot.institute.darwin),
    h("h4", "sk-inst-head", "Auto-logged failure modes"),
    failureModesBlock(snapshot.institute.failureModes.skills),
    h("h4", "sk-inst-head", "Lessons that keep repeating"),
    coverageBlock(tripwireCoverage),
    repeatingLessonsBlock(tripwireHits),
    h("h4", "sk-inst-head", "Getting better? (measured change only)"),
    improvementBlock(snapshot.institute.improvement),
  );
  return wrap;
}

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** SKILL.md revisions (30 days), failure mode → later revision pairs, the resident's own skills. */
function improvementBlock(imp: ImprovementSnapshot | undefined): HTMLElement {
  const wrap = h("div", "sk-improvement");
  if (!imp) {
    wrap.append(h("p", "sk-empty", "The server sent no measured-change data (an older server?)."));
    return wrap;
  }
  wrap.append(h("p", "sk-study-line", revisionsLine(imp.revisions)));
  if (imp.revisions.skills.length) {
    const ul = h("ul", "sk-rows");
    for (const r of imp.revisions.skills.slice(0, 10)) {
      const li = h("li", "sk-row");
      const top = h("div", "sk-row-top");
      top.append(h("span", "sk-name", r.slug), h("span", "sk-meta", `${r.commits} commit${r.commits === 1 ? "" : "s"} · last ${shortDay(r.lastAt)}`));
      li.append(top);
      ul.appendChild(li);
    }
    wrap.append(ul);
    if (imp.revisions.skillCount > 10) wrap.append(h("p", "sk-meta", `…and ${imp.revisions.skillCount - 10} more skills.`));
  }
  wrap.append(h("p", "sk-study-line", pairsLine(imp.pairs)));
  if (imp.pairs.entries.length) {
    const ul = h("ul", "sk-rows");
    for (const e of imp.pairs.entries) {
      const li = h("li", "sk-row");
      const top = h("div", "sk-row-top");
      const next = e.followedAt ? `next SKILL.md revision ${shortDay(e.followedAt)}` : "no SKILL.md revision since";
      top.append(h("span", "sk-name", e.slug), h("span", "sk-meta", `logged ${shortDay(e.loggedAt)} → ${next}${e.stillListed ? "" : " · no longer listed"}`));
      li.append(top, h("p", "sk-desc", e.text));
      ul.appendChild(li);
    }
    wrap.append(ul);
  }
  wrap.append(h("p", "sk-study-line", residentSkillsLine(imp.resident)));
  if (imp.resident.skills.length) {
    const ul = h("ul", "sk-rows");
    for (const r of imp.resident.skills) {
      const li = h("li", "sk-row");
      const top = h("div", "sk-row-top");
      const written = r.writtenAt ? `written ${shortDay(r.writtenAt)}` : "write time unknown";
      const cited = r.citedAt ? `named in a later ${r.citedIn ?? "entry"} ${shortDay(r.citedAt)}` : "not named since";
      top.append(h("span", "sk-name", r.name), h("span", "sk-meta", `${written} · ${cited}`));
      li.append(top);
      ul.appendChild(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

function studyStatusBlock(institute: InstituteSnapshot): HTMLElement {
  const wrap = h("div", "sk-study");
  wrap.append(h("p", "sk-study-line", institute.study.line));
  const enabled = institute.study.enabled;
  const enabledText = enabled === null ? "autopilot: enabled flag unknown (autopilot.json not found)" : `autopilot: ${enabled ? "enabled" : "disabled"}`;
  const parts = [enabledText];
  if (institute.study.logPartial) parts.push("log truncated to its last 512KB for this scan");
  wrap.append(h("p", "sk-meta", parts.join(" · ")));
  return wrap;
}

function candidateQueueBlock(rows: readonly SkillCandidate[], institute: InstituteSnapshot, ctx: ClientContext): HTMLElement {
  if (rows.length === 0) return h("p", "sk-empty", candidateEmptyReason(institute.study));
  const ul = h("ul", "sk-rows");
  for (const c of rows) {
    const li = h("li", "sk-row");
    const top = h("div", "sk-row-top");
    top.append(h("span", "sk-name", c.name), h("span", "sk-meta", c.queuedAt ? relativeTime(c.queuedAt) : "queue date unknown"));
    li.append(top);
    if (c.description) li.append(h("p", "sk-desc", c.description));
    const parts: string[] = [];
    parts.push(c.evidenceCount !== null ? `${c.evidenceCount} sample${c.evidenceCount === 1 ? "" : "s"}` : "evidence count unknown");
    if (c.confidence !== null) parts.push(`confidence ${c.confidence.toFixed(2)}`);
    li.append(h("p", "sk-meta", parts.join(" · ")));
    const openBtn = h("button", "comic-btn small", "Open in editor");
    openBtn.type = "button";
    openBtn.addEventListener("click", () => void openCandidate(c, ctx, openBtn));
    li.append(openBtn);
    ul.appendChild(li);
  }
  return ul;
}

async function openCandidate(c: SkillCandidate, ctx: ClientContext, trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  const body: SkillsOpenEditorRequest = { path: c.path };
  const res = await ctx.api.postJson<SkillsOpenEditorResult>("/api/skills/open-editor", body, (error) => ({ ok: false, error }));
  trigger.disabled = false;
  if (res.ok) ctx.toast(`Opening ${c.name}…`);
  else ctx.toast(`Couldn't open ${c.name}: ${res.error}`, "error");
}

function darwinRoundsBlock(rows: readonly DarwinRoundSummary[]): HTMLElement {
  if (rows.length === 0) return h("p", "sk-empty", "No skill has recorded a Darwin self-review round yet.");
  const ul = h("ul", "sk-rows");
  for (const r of rows) {
    const li = h("li", "sk-row");
    const top = h("div", "sk-row-top");
    top.append(h("span", "sk-name", r.slug), h("span", "sk-meta", `${r.rounds} round${r.rounds === 1 ? "" : "s"}${r.lastDate ? ` · last ${r.lastDate}` : ""}`));
    li.append(top);
    if (r.lastSuggestion) li.append(h("p", "sk-desc", r.lastSuggestion));
    ul.appendChild(li);
  }
  return ul;
}

function failureModesBlock(rows: readonly SkillFailureModeRow[]): HTMLElement {
  if (rows.length === 0) return h("p", "sk-empty", "No skill has an auto-logged failure mode yet.");
  const ul = h("ul", "sk-rows");
  for (const r of rows) {
    const li = h("li", "sk-row");
    const top = h("div", "sk-row-top");
    top.append(h("span", "sk-name", r.name), h("span", "sk-meta", `${r.entryCount} logged entr${r.entryCount === 1 ? "y" : "ies"}`));
    li.append(top);
    ul.appendChild(li);
  }
  return ul;
}

/** How many of the lessons written down a tripwire rule guards: counts only, from the server. */
function coverageBlock(c: TripwireCoverage | null): HTMLElement {
  const wrap = h("div", "sk-study");
  if (!c) {
    wrap.append(h("p", "sk-meta", "Lesson coverage not counted yet."));
    return wrap;
  }
  const line = h("p", "sk-study-line", coverageLine(c));
  line.title = c.sources.map((s) => `${s.label}: ${s.how} in ${s.path}${s.error ? ` (unreadable: ${s.error})` : ""}`).join("\n");
  wrap.append(line, h("p", "sk-meta", `${coverageSourcesLine(c)}. The sources overlap; each tripwire rule guards one lesson.`));
  return wrap;
}

function repeatingLessonsBlock(hits: readonly TripwireHit[]): HTMLElement {
  const lessons = repeatingLessons(hits);
  // The server keeps its newest TRIPWIRES_HIT_CAP hits, across restarts (data/tripwires.jsonl).
  const scope = `the ${hits.length < TRIPWIRES_HIT_CAP ? "" : `newest ${TRIPWIRES_HIT_CAP} `}hits kept across restarts`;
  if (lessons.length === 0) return h("p", "sk-empty", `No lesson was repeated by 3+ sessions in ${scope}.`);
  const wrap = h("div", "sk-repeating");
  const ul = h("ul", "sk-rows");
  for (const l of lessons) {
    const li = h("li", "sk-row");
    const top = h("div", "sk-row-top");
    top.append(h("span", "sk-name", l.lesson), h("span", "sk-meta", `${l.hitCount} sessions repeated it`));
    li.append(top);
    ul.appendChild(li);
  }
  wrap.append(ul, h("p", "sk-meta", `Counted over ${scope}.`));
  return wrap;
}

const skillsPanel: ClientPanel = { id: PANEL_ID, title: "Skills", render: renderSkillsPanel };

/** Opens the Skills panel on its School tab (the campus's School card links here). */
export function openSchoolTab(ctx: ClientContext): void {
  activeTab = INSTITUTE_TAB_ID;
  ctx.openPanel(PANEL_ID);
}

export const skillsFeature: ClientFeature = {
  id: "skills",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, slot) => renderAgentPanel(id, slot, ctx));
  },
  onSnapshot(world, ctx) {
    const raw = world.extras?.[RECENT_EXTRAS_KEY];
    ingestEvents(parseSkillEvents(raw), ctx);
    // "Lessons that keep repeating": a read-only look at the tripwires feature's own list, kept
    // fresh on each snapshot (not live-pushed — this tab isn't watched moment to moment, and
    // the tripwires feature already owns the WS push for its own live badges).
    tripwireHits = parseTripwireHits(world.extras?.[TRIPWIRES_HITS_KEY]);
    tripwireCoverage = parseTripwireCoverage(world.extras?.[TRIPWIRES_COVERAGE_KEY]);
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "events") return;
    ingestEvents(parseSkillEvents(p.events), ctx);
  },
  paletteCommands: (ctx) => [
    { id: "open", title: "Skills…", kind: "panel", keywords: ["skill", "graveyard", "candidates", "school", "study", "upskill", "darwin", "router"], run: () => ctx.openPanel(PANEL_ID) },
  ],
  hudButtons: [{ id: "open", label: "🧩", title: "Skills", text: "Skills…", placement: "menu", onClick: (ctx) => ctx.openPanel(PANEL_ID) }],
  panels: [skillsPanel],
};
