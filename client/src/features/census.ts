// "census" feature: one panel where every number Alex's Alef vision post quotes is
// computed, shown with its formula, its window and its source — never invented, never a bare
// number without where it came from. See shared/features/census.ts for the wire contract and
// client/src/features/census-lib.ts for the pure formatting/diffing this file wires to the DOM.
//
//  - "Sessions that lived here" = agents.length + the archive feature's own fossil total,
//    recomputed CLIENT-side from every snapshot — this feature never trusts a server-computed
//    grand total for it, and shows "archive not scanned yet" (never a bare 267) until the
//    archive summary has landed at least once.
//  - "Sub-minions born" is server/features/census.ts's `generations` block (subagents.db),
//    fetched from GET /api/census when the panel opens (it is not in the snapshot extra, which
//    stays small: just the merged-PR summary). null (never a bare 0) until the subagents
//    feature's first pass has published — shown as "Subagents not indexed yet.".
//  - "Upgrades merged into Alef" is that same summary's `merged` half, live from the snapshot
//    extra + WS pushes. A genuinely new merge's Feed item comes from the SERVER (a gov:census
//    item, server/features/census.ts → client/src/features/feed-bridge.ts), once per merge for
//    every page and the Logs tab, never pushed from here.
//  - "Vision ledger" is GET /api/vision (server/features/vision.ts): the post's claims as data,
//    each with its status, its evidence and where the status comes from ("audited <date>", or
//    "probe ✓ <time>" when a probe re-checked it), and the % with its formula next to it.

import { isArchiveSummary } from "../../../shared/features/archive";
import {
  CENSUS_SUMMARY_KEY,
  isCensusMergedSummary,
  parseCensusMessage,
  parseCensusResponse,
  type CensusMergedSummary,
} from "../../../shared/features/census";
import { parseVisionResponse, type VisionClaim, type VisionResponse, type VisionStatus } from "../../../shared/features/vision";
import { computeSessionsTotal, generationChain, prUrl, visionGroups, visionHeadline, visionLabel, type SessionsTotal } from "./census-lib";
import { h } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import "./census.css";
import type { CouncilResult } from "../../../shared/features/council";
import { councilHistoryOf, governanceCounts, mergeGovernanceParts } from "./census-governance-lib";

type CensusPr = CensusMergedSummary["recent"][number];

const PANEL_ID = "census";
const CHIP_ID = "hud-f-census-chip";

let chipEl: HTMLElement | null = null;
let lastSessions: SessionsTotal = { known: false };
let lastMerged: CensusMergedSummary | null = null;

function paintChip(): void {
  chipEl ??= document.getElementById(CHIP_ID);
  if (!chipEl) return;
  const sessions = lastSessions.known ? lastSessions.total.toLocaleString() : "…";
  const upgrades = lastMerged?.fetchedAt ? lastMerged.total.toLocaleString() : "…";
  chipEl.textContent = `${sessions} sessions · ${upgrades} upgrades`;
}

/** Folds in a freshly-observed merged summary (from a snapshot extra or a WS push). */
function applyMerged(summary: CensusMergedSummary): void {
  lastMerged = summary;
  paintChip();
}

function prLink(repo: string, pr: CensusPr, history: readonly CouncilResult[] | null): HTMLElement {
  const li = h("li", "census-pr-row");
  const a = document.createElement("a");
  a.href = prUrl(repo, pr.number);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `#${pr.number} ${pr.title}`; // untrusted GitHub title: textContent only, never innerHTML
  // Council link, review on the merged SHA, President pick: text only (the pick id is PR body text).
  li.append(a, h("div", "census-pr-gov", mergeGovernanceParts(pr, history).join(" · ")));
  return li;
}

/** "Last 10 merges: council-linked … · review recorded … · President pick …", with its window. */
function governanceLine(recent: readonly CensusPr[], history: readonly CouncilResult[] | null): HTMLElement[] {
  const c = governanceCounts(recent, history);
  const linked =
    c.councilLinked !== null
      ? c.councilLinked.toLocaleString()
      : history === null
        ? "unknown (council history unavailable)"
        : `unknown (${c.councilUnknown} of ${c.merges} name a council that can't be checked)`;
  return [
    h("p", "census-line", `Last ${c.merges} merges: council-linked ${linked} · review recorded ${c.reviewRecorded} · President pick ${c.presidentPicked}`),
    h(
      "p",
      "census-note",
      "Council-linked = the PR body has a \"Council: <id>\" line (copied from scripts/council-round.ts) naming a loop-round council that picked the PR's branch before the merge, checked against the last 20 councils (GET /api/council/history). No line reads \"no loop council\". A named council those 20 no longer hold reads \"council unknown\", never \"no loop council\". Review = a PR comment \"alef-review: MERGE|BLOCK <sha> <model>\" on the merged SHA, posted before the merge (scripts/post-review.ts). President pick = a \"President pick: <id>\" line in the PR body (scripts/president-pick.ts).",
    ),
  ];
}

function renderMergedSection(frag: DocumentFragment, merged: CensusMergedSummary | null, history: readonly CouncilResult[] | null): void {
  frag.append(h("h4", "census-h", "Upgrades merged into Alef"));
  if (!merged || !merged.fetchedAt) {
    frag.append(h("p", "census-empty", "Not fetched yet."));
    if (merged?.error) frag.append(h("p", "census-error", `gh error: ${merged.error}`));
    return;
  }
  frag.append(h("p", "census-line", `${merged.total.toLocaleString()} · review recorded on the merged SHA: ${merged.reviewRecorded.toLocaleString()} · loop-marked: ${merged.loopMarked.toLocaleString()}`));
  frag.append(h("p", "census-note", `As of ${new Date(merged.fetchedAt).toLocaleString()} (gh pr list --state merged on ${merged.repo ?? "this repo"})`));
  if (merged.error) frag.append(h("p", "census-error", `Stale — showing the last good list. gh error: ${merged.error}`));
  if (merged.repo && merged.recent.length > 0) {
    const repo = merged.repo;
    const recent = merged.recent.slice(0, 10);
    frag.append(...governanceLine(recent, history));
    const list = h("ul", "census-pr-list");
    for (const pr of recent) list.append(prLink(repo, pr, history));
    frag.append(list);
  }
}

const STATUS_HEADING: Readonly<Record<VisionStatus, string>> = {
  real: "Real",
  partial: "Partial",
  missing: "Missing",
  metaphor: "Metaphors (never scored, never a number)",
};

const shortTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function visionRow(c: VisionClaim): HTMLElement {
  const li = h("li", `census-vision-row census-vision-${c.effective}`);
  const head = h("div", "census-vision-head");
  head.append(h("span", "census-vision-text", `#${c.n} ${c.text}`), h("span", "census-vision-label", c.effective === "metaphor" ? `metaphor · audited ${c.auditedAt}` : `${c.effective} · ${visionLabel(c, shortTime)}`));
  li.append(head, h("div", "census-pr-gov", c.evidence));
  if (c.probeResult && c.probeResult.state !== "pass") li.append(h("div", "census-pr-gov", `probe ${c.probeResult.state}: ${c.probeResult.detail}`));
  else if (c.probeResult) li.append(h("div", "census-pr-gov", `probe: ${c.probeResult.detail}`));
  if (c.notYet) li.append(h("div", "census-pr-gov", `not yet: ${c.notYet}`));
  return li;
}

function renderVisionSection(frag: DocumentFragment, ledger: VisionResponse | null): void {
  frag.append(h("h4", "census-h", "Vision ledger: how much of the post runs today"));
  if (!ledger) {
    frag.append(h("p", "census-error", "The vision ledger is unavailable (GET /api/vision failed)."));
    return;
  }
  const { counts } = ledger;
  frag.append(
    h("p", "census-line", visionHeadline(ledger.pct, ledger.strictPct)),
    h("p", "census-note", ledger.formula),
    h("p", "census-note", ledger.strictFormula),
    h(
      "p",
      "census-note",
      `${counts.real} real · ${counts.partial} partial · ${counts.missing} missing · ${counts.metaphor} metaphors. A claim is real when it is true today as the post says it (or with the corrected number its evidence gives), partial when only part of it is. A failed probe lowers its claim one step; a probe never raises one.${ledger.probedAt ? ` Probes ran at ${shortTime(ledger.probedAt)}.` : ""}`,
    ),
  );
  const groups = visionGroups(ledger.claims);
  for (const status of ["real", "partial", "missing", "metaphor"] as const) {
    const rows = groups[status];
    if (rows.length === 0) continue;
    const details = document.createElement("details");
    details.className = "census-vision-group";
    details.open = status !== "real" && status !== "metaphor";
    details.append(h("summary", "census-vision-summary", `${STATUS_HEADING[status]} · ${rows.length}`));
    const list = h("ul", "census-vision-list");
    for (const c of rows) list.append(visionRow(c));
    details.append(list);
    frag.append(details);
  }
}

async function renderPanel(el: HTMLElement, ctx: ClientContext): Promise<void> {
  el.replaceChildren(h("p", "census-loading", "Loading…"));
  const [censusRaw, councilRaw, visionRaw] = await Promise.all([
    ctx.api.getJson<unknown>("/api/census"),
    ctx.api.getJson<unknown>("/api/council/history"),
    ctx.api.getJson<unknown>("/api/vision"),
  ]);
  const parsed = parseCensusResponse(censusRaw);
  const frag = document.createDocumentFragment();

  frag.append(h("h4", "census-h", "Sessions that lived here"));
  if (lastSessions.known) {
    frag.append(h("p", "census-line", `${lastSessions.total.toLocaleString()} = ${lastSessions.indexed.toLocaleString()} indexed + ${lastSessions.fossils.toLocaleString()} fossils`));
    frag.append(h("p", "census-note", "agents.length + the archive summary's total (vault 10-Sessions/claude-code). Sessions pruned before the exporter ran are unknown."));
  } else {
    frag.append(h("p", "census-empty", "Archive not scanned yet."));
  }

  frag.append(h("h4", "census-h", "Sub-minions born"));
  const gen = parsed?.generations;
  if (gen === null) {
    // The subagents feature hasn't finished its first pass yet — distinct from a genuine 0, so
    // this never shows as "no subagent records" while subagents.db actually holds thousands.
    frag.append(h("p", "census-empty", "Subagents not indexed yet."));
  } else if (gen && gen.total > 0) {
    frag.append(h("p", "census-line", `${gen.total.toLocaleString()} since ${gen.since ? new Date(gen.since).toLocaleDateString() : "unknown"} (subagents.db)`));
    frag.append(h("p", "census-note", `${gen.generations} generation${gen.generations === 1 ? "" : "s"}: ${generationChain(gen).join(" → ")}`));
  } else {
    frag.append(h("p", "census-empty", "No subagent records yet."));
  }

  renderMergedSection(frag, parsed?.merged ?? lastMerged, councilHistoryOf(councilRaw));
  renderVisionSection(frag, parseVisionResponse(visionRaw));
  el.replaceChildren(frag);
}

export const censusFeature: ClientFeature = {
  id: "census",
  mount() {
    chipEl = document.getElementById(CHIP_ID);
    paintChip();
  },
  onSnapshot(world) {
    const archiveRaw = world.extras?.["archive.summary"];
    lastSessions = computeSessionsTotal(world.agents.length, isArchiveSummary(archiveRaw) ? archiveRaw : null);
    const mergedRaw = world.extras?.[CENSUS_SUMMARY_KEY];
    if (isCensusMergedSummary(mergedRaw)) applyMerged(mergedRaw);
    paintChip();
  },
  onMessage(msg) {
    const parsed = parseCensusMessage(msg.payload);
    if (parsed) applyMerged(parsed.merged);
  },
  hudButtons: [
    {
      id: "chip",
      label: "… sessions · … upgrades",
      title: "Census: sessions that lived here, sub-minions born, upgrades merged (click for the full breakdown with sources)",
      placement: "status",
      onClick: (ctx) => ctx.openPanel(PANEL_ID),
    },
  ],
  panels: [
    {
      id: PANEL_ID,
      title: "Census",
      render(el, ctx) {
        void renderPanel(el, ctx);
      },
    },
  ],
};
