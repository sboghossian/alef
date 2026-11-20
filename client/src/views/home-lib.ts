// Pure helpers for the 🏠 Home view (views/home.ts): the "What happened" fact lines with the place
// each one comes from, the Automations and "Jev decided lately" row words, and the Live feed's
// paging. DOM-free, so home-lib.test.ts covers them.
//
// Every line is built from the server's counts (shared/features/home.ts). A source that has not
// loaded says so in words; its zeros are never shown as facts.

import type { RunMark } from "../../../shared/features/careers";
import type { DigestFacts, HomeAutomationRow, HomeDecisionRow } from "../../../shared/features/home";
import type { PresidentBoard, PresidentProposal } from "../../../shared/features/president";
import type { FeedItem, FeedKind } from "../shell/feed-types";
import type { RightTab } from "../shell/views";

export const HOME_VIEW_ID = "home";
export const GREETING = "Hi Steph";

/** Where a fact line (or a row) comes from: a view, a side panel, a right-sidebar tab, or Home's
 *  own Needs you now section (the Inbox: Jev's proposals live there). */
export type HomeLink =
  | { kind: "view"; view: string; label: string }
  | { kind: "panel"; panel: string; label: string }
  | { kind: "tab"; tab: RightTab; label: string }
  | { kind: "needs"; label: string };

export interface FactLine {
  id: string;
  text: string;
  /** Smaller lines under it (PR titles, busiest districts, top automations). Untrusted text. */
  sub: string[];
  /** "quiet" = not known yet (the source hasn't loaded). */
  tone: "plain" | "good" | "bad" | "quiet";
  link: HomeLink;
}

const BOARD: HomeLink = { kind: "view", view: "board", label: "Board" };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Needs you now with nothing in it says so calmly, then what is running without you. */
export function needsCalmLine(live: number): string {
  return live > 0 ? `${plural(live, "agent")} working on ${live === 1 ? "its" : "their"} own right now.` : "Nothing is running right now either.";
}

/** "a · b · c" of the parts whose count is above 0 (the first one always shows). */
function parts(list: readonly [number, string][]): string {
  const kept = list.filter(([n], i) => n > 0 || i === 0);
  return kept.map(([n, w]) => `${n} ${w}`).join(" · ");
}

export function factLines(f: DigestFacts): FactLine[] {
  const s = f.sessions;
  const lines: FactLine[] = [
    {
      id: "sessions",
      text: `${plural(s.active, "session")} active · ${s.started} started · ${s.ended} ended${s.liveNow ? ` · ${s.liveNow} running now` : ""}${s.waitingNow ? ` · ${s.waitingNow} waiting on you` : ""}`,
      sub: s.topDistricts.length ? [`Busiest: ${s.topDistricts.map((d) => `${d.name} ${d.sessions}`).join(" · ")}`] : [],
      tone: "plain",
      link: BOARD,
    },
  ];

  const o = f.outcomes;
  lines.push(
    o.ready
      ? {
          id: "outcomes",
          text: `Of the ${plural(s.ended, "session")} that ended: ${parts([
            [o.shipped, "shipped"],
            [o.delivered, "delivered"],
            [o.finished, "finished"],
            [o.failed, "failed"],
            [o.stopped, "stopped"],
            [o.abandoned, "abandoned"],
            [o.noEvidence, "no outcome evidence"],
            [o.unjudged, "no verdict yet"],
          ])}`,
          sub: [],
          tone: o.failed + o.abandoned > 0 ? "bad" : o.shipped + o.delivered > 0 ? "good" : "plain",
          link: BOARD,
        }
      : { id: "outcomes", text: "Session verdicts: not known yet (the outcomes scan has no records).", sub: [], tone: "quiet", link: BOARD },
  );

  const m = f.mergedPrs;
  lines.push(
    m.ready
      ? {
          id: "merged",
          text: `${plural(m.total, "PR")} merged from your sessions`,
          sub: m.byRepo.length ? [m.byRepo.slice(0, 4).map((r) => `${r.repo} ${r.count}`).join(" · ")] : [],
          tone: m.total > 0 ? "good" : "plain",
          link: BOARD,
        }
      : { id: "merged", text: "Merged PRs: not known yet (the outcomes scan has no records).", sub: [], tone: "quiet", link: BOARD },
  );

  const a = f.alefUpgrades;
  const census: HomeLink = { kind: "panel", panel: "census", label: "Census" };
  lines.push(
    a.ready
      ? {
          id: "alef",
          text: `${plural(a.total, "upgrade")} merged into Alef${a.error ? ` (the last GitHub check failed: ${a.error})` : ""}`,
          sub: a.latestPrs.map((p) => `#${p.number} ${p.title}`),
          tone: a.total > 0 ? "good" : "plain",
          link: census,
        }
      : { id: "alef", text: a.error ? `Alef upgrades: GitHub couldn't be asked (${a.error}).` : "Alef upgrades: not fetched from GitHub yet.", sub: [], tone: "quiet", link: census },
  );

  const k = f.sickness;
  const clinic: HomeLink = { kind: "panel", panel: "clinic", label: "Clinic" };
  lines.push(
    k.ready
      ? {
          id: "sickness",
          text: `${plural(k.opened, "sickness case")} opened · ${k.healed} healed · ${k.openNow} still sick now`,
          sub: k.openedByKind.length ? [k.openedByKind.map((x) => `${x.kind} ${x.count}`).join(" · ")] : [],
          tone: k.opened > k.healed ? "bad" : "plain",
          link: clinic,
        }
      : { id: "sickness", text: "Sickness: the scan hasn't read every transcript yet.", sub: [], tone: "quiet", link: clinic },
  );

  const u = f.automations;
  const tower: HomeLink = { kind: "panel", panel: "careers", label: "Tower" };
  lines.push(
    u.ready
      ? {
          id: "automations",
          text: `${plural(u.runs, "automation run")}: ${parts([
            [u.clean, "clean"],
            [u.wrote, "only wrote"],
            [u.bad, "bad"],
            [u.unknown, "no verdict"],
          ])}`,
          sub: u.topWorkers.length ? [u.topWorkers.slice(0, 5).map((w) => `${w.key} ${w.runs}${w.bad ? ` (${w.bad} bad)` : ""}`).join(" · ")] : [],
          tone: u.bad > 0 ? "bad" : u.clean > 0 ? "good" : "plain",
          link: tower,
        }
      : { id: "automations", text: "Automation runs: not known yet (the outcomes scan has no records).", sub: [], tone: "quiet", link: tower },
  );

  const j = f.jev;
  const inbox: HomeLink = { kind: "needs", label: "Needs you now" };
  lines.push(
    j.ready
      ? {
          id: "jev",
          text: `Jev's board: ${plural(j.shown, "proposal")} shown · ${j.launched} launched · ${j.dismissed} dismissed${j.merged ? ` · ${j.merged} merges approved` : ""}${j.retired ? ` · ${j.retired} retired` : ""}`,
          sub: [],
          tone: "plain",
          link: inbox,
        }
      : { id: "jev", text: "Jev's board: the president's ledger isn't loaded yet.", sub: [], tone: "quiet", link: inbox },
  );
  return lines;
}

// ---------------------------------------------------------------- Automations rows

export const MARK_LABEL: Readonly<Record<RunMark, string>> = {
  clean: "✓ clean",
  wrote: "✎ only wrote",
  failed: "✗ failed",
  stopped: "⏸ stopped",
  abandoned: "✗ abandoned",
  empty: "∅ did nothing",
  unknown: "? no verdict",
};

export const STATE_LABEL: Readonly<Record<string, string>> = {
  trusted: "🎓 trusted",
  probation: "↩ probation",
  enrolled: "enrolled",
  lapsed: "💤 lapsed",
  returned: "↺ returned",
  retired: "retired",
};

/** "5m ago" / "3h ago" / "2d ago"; a day-only date stays a date. */
export function ago(iso: string, nowMs: number): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const diff = nowMs - Date.parse(iso);
  if (!Number.isFinite(diff)) return "unknown";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "in 3h 12m" / "in 45m" / "due now". */
export function until(iso: string, nowMs: number): string {
  const diff = Date.parse(iso) - nowMs;
  if (!Number.isFinite(diff)) return "unknown";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "due now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return mins % 60 ? `in ${hours}h ${mins % 60}m` : `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export interface AutomationWords {
  name: string;
  state: string | null;
  last: string;
  next: string | null;
  /** The last run or exit was bad. */
  bad: boolean;
}

export function automationWords(r: HomeAutomationRow, nowMs: number): AutomationWords {
  let last: string;
  let bad = false;
  if (r.kind === "worker") {
    last = r.lastRunAt ? `last run ${ago(r.lastRunAt, nowMs)}${r.lastMark ? ` · ${MARK_LABEL[r.lastMark]}` : ""}` : "no dated run";
    bad = r.lastMark === "failed" || r.lastMark === "abandoned" || r.lastMark === "empty" || r.lastMark === "stopped";
  } else {
    last = r.lastExit === null ? "launchd has no exit status for it yet" : `last exit ${r.lastExit}${r.lastExit === 0 ? " (not proof it did anything)" : ""}`;
    bad = r.lastExit !== null && r.lastExit !== 0;
  }
  if (r.running) last = `running now · ${last}`;
  const next = r.nextRunAt ? `next ${until(r.nextRunAt, nowMs)}${r.schedule ? ` · ${r.schedule}` : ""}` : r.schedule;
  return { name: r.name, state: r.state ? (STATE_LABEL[r.state] ?? r.state) : r.kind === "routine" ? "⏰ routine" : null, last, next, bad };
}

// ---------------------------------------------------------------- "Jev decided lately"

const ORIGIN_WORDS: Readonly<Record<string, string>> = {
  loop: "from an open loop",
  stale: "from a stale todo",
  health: "from a Health check",
  treat: "treat a sick lineage",
  research: "research a new rule",
};

/** "Session idea (treat a sick lineage)" / "District merge" / "Graduation: retire". The origin comes
 *  from the ledger id's own prefix (president-lib builds "loop-…", "stale-…", "treat-…"). */
export function decisionLabel(r: Pick<HomeDecisionRow, "id" | "kind" | "action">): string {
  if (r.kind === "merge") return "District merge";
  if (r.kind === "commencement") return `Graduation: ${r.action}`;
  const origin = /^([a-z]+)-/.exec(r.id)?.[1];
  const words = origin ? ORIGIN_WORDS[origin] : undefined;
  return words ? `Session idea (${words})` : "Session idea";
}

export function decisionStatus(r: Pick<HomeDecisionRow, "status" | "outcome">): { text: string; tone: "good" | "bad" | "wait" | "quiet" } {
  if (r.status === "clicked") return { text: r.outcome === "merged" ? "you approved it" : r.outcome === "retired" ? "you retired it" : "you launched it", tone: "good" };
  if (r.status === "dismissed") return { text: "you dismissed it", tone: "bad" };
  if (r.status === "pending") return { text: "pending on the board", tone: "wait" };
  return { text: "left the board unclicked", tone: "quiet" };
}

function proposalText(p: PresidentProposal): string {
  if (p.kind === "session") return `${p.task} (${p.city})`;
  if (p.kind === "merge") return `${plural(p.districts.length, "district")} into ${p.into}`;
  return p.title;
}

/** The words of a ledger entry: the board's own proposal while it is on the board, else the detail
 *  of the gov:click Feed item its click produced (`srv:gov:click:president:<id>:<outcome>:<at>`,
 *  governance-lib presidentClickItem), else null (the ledger itself keeps no text). */
export function decisionText(r: Pick<HomeDecisionRow, "id" | "outcome">, board: PresidentBoard | null, feed: readonly FeedItem[]): string | null {
  const p = board?.proposals.find((x) => x.id === r.id);
  if (p) return proposalText(p);
  if (!r.outcome) return null;
  const prefix = `srv:gov:click:president:${r.id}:${r.outcome}:`;
  const item = feed.find((i) => i.id.startsWith(prefix));
  if (!item?.detail) return null;
  const cut = item.detail.indexOf(" · ranked by ");
  return cut > 0 ? item.detail.slice(0, cut) : item.detail;
}

export interface JevEntry {
  key: string;
  at: number;
  /** A ledger row, or Jev's ranking of the board (a gov:jev Feed item). */
  row: HomeDecisionRow | null;
  ranking: FeedItem | null;
}

/** Ledger rows and Jev's rankings (gov:jev items the Feed holds), newest first. */
export function jevTimeline(rows: readonly HomeDecisionRow[], feed: readonly FeedItem[]): JevEntry[] {
  const out: JevEntry[] = rows.map((r) => ({ key: `row:${r.id}:${r.actedAt ?? r.proposedAt}`, at: Date.parse(r.actedAt ?? r.proposedAt) || 0, row: r, ranking: null }));
  for (const i of feed) if (i.id.startsWith("srv:gov:jev:")) out.push({ key: i.id, at: i.at, row: null, ranking: i });
  return out.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------- Live feed

/** The Feed kinds the Live feed shows by default: everything but the raw activity and caption
 *  lines (one per tool call or thought). "Everything" shows those too. */
export const HIGHLIGHT_KINDS: readonly FeedKind[] = ["approval", "awaiting", "tripwire", "decision", "graduation", "routine", "report", "system"];

export const FEED_PAGE = 25;

/** The next page size: one more page, never past what the Feed holds. */
export function nextShown(shown: number, total: number, page = FEED_PAGE): number {
  return Math.min(total, shown + page);
}
