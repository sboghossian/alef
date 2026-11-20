// Pure text for the Orbit's Explain layer (round 11 C): the plain-language label every kind of
// structure wears while Explain is on, and the small card a click opens (what it is / what it did
// today / live numbers). No DOM, no THREE: explain.ts gathers the real data and renders these.
// Every number shown comes from the input; a missing source says so ("no data") instead of 0.
// Unit-tested in explain-lib.test.ts.

import { STATIONS, type StationId } from "../../../shared/stations";
import type { CliStationSnapshot } from "../../../shared/features/cli-station";
import type { EpisodicStats, ProceduralStats, SemanticStats } from "../../../shared/features/memory-layers";
import { INSTITUTE_OF_TRUTH, type WakeRecallSummary, type WakeRecallTotals } from "../../../shared/features/wake-recall";
import type { Routine } from "../../../shared/features/routines";
import type { SubagentStats } from "../../../shared/features/subagents";
import type { JevDecision, JevState, WorldAgent, WorldObject } from "../../../shared/types";
import type { CareerWorker, CareersSummary } from "../../../shared/features/careers";
import type { InstituteSnapshot } from "../../../shared/features/skills";
import type { SicknessCounts } from "../../../shared/features/sickness";
import {
  FAMILY_LABELS,
  GATE_TEXT,
  LAMP_FRESH_DAYS,
  MAX_BANNERS,
  MAX_MARKS,
  SHIPPED_WINDOW_DAYS,
  modelFamilyOf,
  type ClinicLamp,
  type GateInfo,
  type Lamp,
  type PlantStat,
  type RouterHookState,
} from "./system-places-lib";
import { agentTitle } from "../../../shared/display";

export type ExplainKind =
  | "continent"
  | "district"
  | "house"
  | "car"
  | "drone"
  | "station"
  | "harness"
  | "building"
  | "moon"
  | "jev-tower"
  | "plant"
  | "gate"
  | "episodic"
  | "semantic"
  | "procedural"
  | "cli"
  | "routines"
  | "school"
  | "hall"
  | "clinic";

/** The short tag a structure wears while Explain is on. */
export const KIND_LABELS: Record<ExplainKind, string> = {
  continent: "Topic continent",
  district: "City: one project folder",
  house: "House: one Claude session",
  car: "Car: a live session at work",
  drone: "Drone: a subagent (a helper session)",
  station: "Station: the tool it is using",
  harness: "Harness City: your skills, hooks, MCPs",
  building: "Harness building",
  moon: "Moon: Jev, the director",
  "jev-tower": "Jev tower: routes every prompt",
  plant: "Power plant: a model family",
  gate: "Hook gate",
  episodic: "Episodic archive: what happened",
  semantic: "Semantic library: what's true",
  procedural: "Procedural workshop: what works",
  cli: "CLI station: agent-authored CLIs",
  routines: "Routines factory: scheduled jobs",
  school: "School: where skills are studied",
  hall: "Graduates' Hall: trusted workers",
  clinic: "Clinic: lit while a minion is sick",
};

export interface ExplainCard {
  title: string;
  /** One or two plain sentences: what this is. */
  what: string;
  /** What it did today (real events only; empty = nothing seen). */
  today: string[];
  /** Live numbers: label → value. */
  live: Array<[string, string]>;
  /** Where the numbers come from (small print). */
  source?: string;
  /** The power plant card only: "How the model was built", six stages. */
  buildStages?: readonly BuildStage[];
  /** The campus cards only: panels a button leads to (explain.ts draws them). */
  actions?: readonly CampusAction[];
}

/** Where a campus card's buttons lead: the Skills panel's School tab, the Tower, the Hall. */
export type CampusAction = "school" | "tower" | "hall";

/** The campus cards' buttons. The Hall's is left out while no "alumni" panel is registered
 *  (alumni-legacy): a button that opens nothing would be a lie. */
export function campusActions(hallPanel: boolean): CampusAction[] {
  return hallPanel ? ["school", "tower", "hall"] : ["school", "tower"];
}

/** One stage of "How the model was built" (a power plant's Explain card, round 11 C). Only the
 *  Data and Serving stages carry numbers, on purpose — see MODEL_BUILD_STAGES. */
export interface BuildStage {
  stage: string;
  text: string;
}

/** Data → Tokens → Transformer → Pre-training → Post-training → Serving. The only stages that
 *  may carry a number are Data (FineWeb ≈ 15T tokens) and Serving (a 405B model needs ~810 GB
 *  of weights at 2 bytes/param, ~80 GB per GPU): every other line is plain, numberless prose. */
export const MODEL_BUILD_STAGES: readonly BuildStage[] = [
  { stage: "Data", text: "Scrape and license a huge pile of text and code from the web — FineWeb alone is roughly 15 trillion tokens of it." },
  { stage: "Tokens", text: "Chop that text into sub-word pieces called tokens: the units the model actually reads and predicts." },
  { stage: "Transformer", text: "Stack attention layers that let every token weigh every other token before guessing the next one." },
  { stage: "Pre-training", text: "Read that tokenized text over and over, just predicting the next token, to build a general sense of language and the world." },
  { stage: "Post-training", text: "Fine-tune on human feedback and curated examples so it follows instructions and behaves like an assistant, not a raw predictor." },
  {
    stage: "Serving",
    text: "The finished weights are too big for one chip — a 405-billion-parameter model needs roughly 810 GB at 2 bytes per parameter, about 80 GB per GPU — so serving means splitting it across many GPUs that answer together.",
  },
];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function isToday(iso: string | null | undefined, sinceMs: number): boolean {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) && t >= sinceMs;
}

export function localMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Label for a place wearing its own name (gates and plants say which one). */
export function placeLabel(kind: "gate" | "plant", name: string): string {
  return kind === "gate" ? `Hook gate: ${name}` : `Power plant: ${name}`;
}

// ---------------------------------------------------------------- cards

export function districtCard(name: string, agents: readonly Pick<WorldAgent, "status" | "lastActive">[], activitySeen: number, sinceMs: number): ExplainCard {
  const live = agents.filter((a) => a.status === "live").length;
  const today = agents.filter((a) => isToday(a.lastActive, sinceMs)).length;
  return {
    title: `🏙️ ${name}`,
    what: "A city (district) is one project folder; each house in it is one Claude Code session that ran there. Cities sit inside topic continents (Website, GTM, Content…).",
    today: today > 0 ? [`${plural(today, "session")} active today`, ...(activitySeen > 0 ? [`${plural(activitySeen, "activity line")} seen since this page opened`] : [])] : [],
    live: [
      ["Live now", String(live)],
      ["Sessions", String(agents.length)],
    ],
  };
}

export function houseCard(
  agent: Pick<WorldAgent, "title" | "displayName" | "model" | "status" | "lastActive" | "messageCount" | "tokens">,
  stateLabel: string | null,
  activitySeen: number,
  subagents: number,
  sinceMs: number,
): ExplainCard {
  return {
    title: `🏠 ${agentTitle(agent) || "Untitled session"}`,
    what: "A house is one Claude Code session (one conversation). It lights up while the session runs; its car drives while it works.",
    today: [
      ...(isToday(agent.lastActive, sinceMs) ? [`Last active ${new Date(agent.lastActive).toLocaleTimeString()}`] : []),
      ...(activitySeen > 0 ? [`${plural(activitySeen, "activity line")} seen since this page opened`] : []),
    ],
    live: [
      ["State", agent.status === "live" ? (stateLabel ?? "live") : "asleep"],
      ["Model", agent.model ? FAMILY_LABELS[modelFamilyOf(agent.model)] + ` (${agent.model})` : "unknown"],
      ["Messages", String(agent.messageCount)],
      ["Tokens", agent.tokens.toLocaleString()],
      ["Subagents", String(subagents)],
    ],
  };
}

export function carCard(agentTitle: string, stateLabel: string | null): ExplainCard {
  return {
    title: `🚗 ${agentTitle || "A live session"}`,
    what: "Every live session has a car on its district's ring road. When the session uses a skill or MCP server, its car drives to that building and back.",
    today: [],
    live: [["State", stateLabel ?? "live"]],
  };
}

export function subagentsCard(stats: Pick<SubagentStats, "total" | "today" | "live" | "parents"> | null): ExplainCard {
  return {
    title: "🛸 Drones (subagents)",
    what: "A drone is a subagent: a helper session a session spawned with the Agent tool or a Workflow. Running ones fly around their parent's house, finished ones park on its roof. Click the drone itself (Explain off) for its own panel.",
    today: stats && stats.today > 0 ? [`${plural(stats.today, "subagent")} active today`] : [],
    live: stats
      ? [
          ["Flying now", String(stats.live)],
          ["All subagents", stats.total.toLocaleString()],
          ["Parent sessions", String(stats.parents)],
        ]
      : [["Subagents", "no data yet"]],
  };
}

export function stationCard(station: StationId, agentTitle: string | null, callsSeen: number): ExplainCard {
  const s = STATIONS[station];
  return {
    title: `${s.emoji} ${s.label} station`,
    what: `Stations stand beside each live session's house; the one matching its current tool call pops. ${s.description}`,
    today: callsSeen > 0 ? [`${plural(callsSeen, `${s.label} call`)} seen since this page opened${agentTitle ? ` (${agentTitle})` : ""}`] : [],
    live: [["Station", s.label]],
  };
}

export function harnessCard(objects: Iterable<Pick<WorldObject, "kind">>): ExplainCard {
  let skills = 0;
  let hooks = 0;
  let mcps = 0;
  for (const o of objects) {
    if (o.kind === "skill") skills += 1;
    else if (o.kind === "hook") hooks += 1;
    else if (o.kind === "mcp") mcps += 1;
  }
  return {
    title: "🧰 Harness City",
    what: "The capital: everything your sessions share. Shops are skills, arches are hooks, antennas are MCP servers. The Tool Yard and the System Quarter stand around it.",
    today: [],
    live: [
      ["Skills", String(skills)],
      ["Hooks", String(hooks)],
      ["MCP servers", String(mcps)],
    ],
    source: "~/.claude and ~/.claude.json (read-only)",
  };
}

export function buildingCard(o: Pick<WorldObject, "kind" | "name" | "usage">): ExplainCard {
  const what: Record<string, string> = {
    skill: "A skill: a packaged set of instructions a session can load on demand.",
    hook: "A hook: a script Claude Code runs on an event (a prompt, a tool call, a stop).",
    mcp: "An MCP server: an external tool provider sessions can call.",
    file: "A file sessions read or wrote.",
    repo: "A git repository sessions worked in.",
  };
  return {
    title: `🏗️ ${o.name}`,
    what: what[o.kind] ?? "A building in the world.",
    today: [],
    live: [["Used by", plural(o.usage, "session")]],
  };
}

function lastDecisionLine(d: JevDecision | undefined): string[] {
  return d ? [`Last decision ${new Date(d.at).toLocaleTimeString()}: ${d.summary} (${d.source})`] : [];
}

export function moonCard(jev: Pick<JevState, "status" | "lastTickAt" | "decisions">, sinceMs: number): ExplainCard {
  const today = jev.decisions.filter((d) => isToday(d.at, sinceMs)).length;
  return {
    title: "🌙 Jev (the moon)",
    what: "Jev is the director. It orbits the planet, grows the harness skills and MCP servers you use most, and answers \"who worked on X?\" when you Ask Jev.",
    today: today > 0 ? [`${plural(today, "decision")} today (of the last ${jev.decisions.length} kept)`, ...lastDecisionLine(jev.decisions[0])] : lastDecisionLine(jev.decisions[0]),
    live: [
      ["Status", jev.status],
      ["Last tick", jev.lastTickAt ? new Date(jev.lastTickAt).toLocaleTimeString() : "never"],
    ],
  };
}

export function jevTowerCard(
  jev: Pick<JevState, "status" | "decisions">,
  router: RouterHookState,
  routerDocs: number | null,
  promptsSeen: number,
  proposals: number,
  sinceMs: number,
): ExplainCard {
  const today = jev.decisions.filter((d) => isToday(d.at, sinceMs)).length;
  return {
    title: "🗼 Jev tower",
    what:
      router === "absent"
        ? "No Jev router hook is seen on UserPromptSubmit, so prompts do not pass through Jev. The tower still hosts Jev's decisions and proposals."
        : "With the Jev router hook installed, every prompt on this Mac passes Jev first. It advises a model tier (Opus, Sonnet or Haiku) and a few notes worth reading. It advises; it never switches the model.",
    today: [
      ...(promptsSeen > 0 ? [`${plural(promptsSeen, "prompt")} seen since this page opened`] : []),
      ...(today > 0 ? [`${plural(today, "Jev decision")} today (of the last ${jev.decisions.length} kept)`] : []),
      ...lastDecisionLine(jev.decisions[0]),
    ],
    live: [
      ["Router hook", router === "installed" ? "installed" : router === "likely" ? "likely (a node hook on UserPromptSubmit)" : "not seen"],
      ["Jev", jev.status],
      ["Notes it can suggest", routerDocs === null ? "no data" : routerDocs.toLocaleString()],
      ["Open proposals", String(proposals)],
    ],
    source: "UserPromptSubmit hooks, world.jev, router.docCount, president board",
  };
}

export function plantCard(stat: PlantStat, arrivals: number): ExplainCard {
  return {
    title: `⚡ ${stat.label} power plant`,
    what: `Sessions running a ${stat.label} model draw their power here. The core grows with the number of live ${stat.label} sessions.`,
    today: [
      ...(stat.today > 0 ? [`${plural(stat.today, "session")} active today`] : []),
      ...(arrivals > 0 ? [`${plural(arrivals, "courier")} passed through since this page opened`] : []),
    ],
    live: [
      ["Live sessions", String(stat.live)],
      ["All sessions", String(stat.total)],
    ],
    buildStages: MODEL_BUILD_STAGES,
  };
}

export function gateCard(g: GateInfo, hits: number): ExplainCard {
  const t = GATE_TEXT[g.event];
  return {
    title: `🚧 ${t.short} (${g.event})`,
    what: `A hook gate ${t.plain}.${g.configured ? "" : " No script is configured for it, so traffic skips it."}`,
    today: hits > 0 ? [`${plural(hits, "courier")} passed since this page opened`] : [],
    live: [
      ["Scripts", g.configured ? String(g.scripts.length) : "none"],
      ...(g.scripts.length ? ([["Runs", g.scripts.slice(0, 6).join(", ") + (g.scripts.length > 6 ? ` +${g.scripts.length - 6}` : "")]] as Array<[string, string]>) : []),
    ],
    source: "hook objects from ~/.claude/settings.json",
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function episodicCard(stats: EpisodicStats | null, hits: number): ExplainCard {
  const idx = stats?.recallIndex;
  return {
    title: "🗄️ Episodic archive",
    what: `The ${INSTITUTE_OF_TRUTH}'s archive. What happened: every session's raw transcript, kept verbatim. A bad episode gets retrieved like a good one and repeats itself.`,
    today: hits > 0 ? [`${plural(hits, "courier")} passed since this page opened`] : [],
    live: [
      ["Session transcripts", stats?.transcriptFiles == null ? "no data" : stats.transcriptFiles.toLocaleString()],
      ["Subagent transcripts", stats?.subagentTranscriptFiles == null ? "no data" : stats.subagentTranscriptFiles.toLocaleString()],
      ["Recall index", idx?.present ? formatBytes(idx.sizeBytes ?? 0) : "no data"],
      ["Last indexed", idx?.present && idx.lastIndexedAt ? new Date(idx.lastIndexedAt).toLocaleString() : "no data"],
      ["Thinks at", "read time"],
    ],
    source: "~/.claude/projects/**/*.jsonl, ~/.gstack/memory/sessions.db",
  };
}

export function semanticCard(stats: SemanticStats | null, hits: number): ExplainCard {
  const mix = stats?.confidence;
  return {
    title: "📚 Semantic library",
    what: `The ${INSTITUTE_OF_TRUTH}'s library. What's true: curated memory files, corrected as they're written. A stale fact is confidently wrong.`,
    today: hits > 0 ? [`${plural(hits, "memory read")} seen since this page opened`] : [],
    live: [
      ["Memory files", stats?.fileCount == null ? "no data" : stats.fileCount.toLocaleString()],
      ["✅ Verified", mix ? String(mix.verified) : "no data"],
      ["📣 Reported", mix ? String(mix.reported) : "no data"],
      ["🧪 Hypothesis", mix ? String(mix.hypothesis) : "no data"],
      ["Unmarked", mix ? String(mix.unmarked) : "no data"],
      [`Stale (${stats?.staleDays ?? 60}+ days)`, stats?.fileCount == null ? "no data" : String(stats.staleCount)],
      ["Thinks at", "write time"],
    ],
    source: "~/.claude/projects/-Users-alexboghossian/memory/*.md",
  };
}

export function proceduralCard(stats: ProceduralStats | null, hits: number): ExplainCard {
  return {
    title: "🛠️ Procedural workshop",
    what: `The ${INSTITUTE_OF_TRUTH}'s workshop. What works: skills, run and occasionally repaired. A wrong playbook does the wrong thing, repeatedly.`,
    today: hits > 0 ? [`${plural(hits, "courier")} passed since this page opened`] : [],
    live: [
      ["Skills", stats?.skillCount == null ? "no data" : stats.skillCount.toLocaleString()],
      ["Patched skills", stats ? String(stats.patchedSkillCount) : "no data"],
      ["Patch entries", stats ? String(stats.patchEntryCount) : "no data"],
      ["Thinks at", "never (frozen)"],
    ],
    source: "~/.claude/skills, ~/.claude/hooks/learning-loop.py",
  };
}

/** What the Institute of Truth card reads: the wake-recall summary (GET-free: the snapshot extra
 *  and WS pushes), the semantic library's confidence mix (memory-layers) and the recall index size
 *  (snapshot extras "recall.docCount" / "recall.ready"). A missing source says "no data". */
export interface InstituteInput {
  wake: WakeRecallSummary | null;
  semantic: SemanticStats | null;
  recall: { docCount: number; ready: boolean } | null;
}

/** The three memory buildings as one place: the town's second brain, and how many sessions really
 *  read from it the moment they woke up (their own transcripts say so), never an assumed "every". */
export function instituteOfTruthCard(input: InstituteInput): ExplainCard {
  const { wake, semantic, recall } = input;
  const t = wake?.ready ? wake.totals : null;
  const wakeRow = (value: (w: WakeRecallTotals) => string): string => (t ? value(t) : wake ? "reading transcripts…" : "no data");
  const mix = semantic?.confidence;
  const live: Array<[string, string]> = [
    ["Fed at wake", wakeRow((w) => `${w.fed.toLocaleString()} of ${(w.fed + w.nothing).toLocaleString()} sessions`)],
    ["Woke with nothing", wakeRow((w) => `${w.nothing} (${w.headlessMisses} headless)`)],
    ["Why nothing", wakeRow((w) => `${w.reasons["timed-out"]} timed out · ${w.reasons.failed} failed · ${w.reasons["no-trace"]} left no trace`)],
  ];
  if (t && t.unread > 0) live.push(["Wake not read", `${t.unread} (first line over 256 KB)`]);
  if (t && t.pending > 0) live.push(["Not woken yet", String(t.pending)]);
  live.push(
    ["Notes injected at wake", wakeRow((w) => w.notes.toLocaleString())],
    ["Prompt-time recalls", wakeRow((w) => `${w.promptRecalls} in ${plural(w.promptRecallSessions, "session")} (first 256 KB of each transcript)`)],
    [
      "Memory files",
      semantic?.fileCount == null || !mix ? "no data" : `${semantic.fileCount.toLocaleString()} (✅ ${mix.verified} · 📣 ${mix.reported} · 🧪 ${mix.hypothesis} · ${mix.unmarked} unmarked)`,
    ],
    ["Vault notes", wake?.vaultNotes == null ? "no data" : wake.vaultNotes.toLocaleString()],
    ["Recall index", recall === null ? "no data" : recall.ready ? `${recall.docCount.toLocaleString()} chunks` : "building"],
  );
  return {
    title: `🏛️ ${INSTITUTE_OF_TRUTH}`,
    what: "The town's second brain: the vault, the memory files and the recall index, kept in three buildings (the episodic archive, the semantic library and the procedural workshop). A session reads from it when it wakes up, if the SessionStart recall hook injects vault notes. Not the School: that is the Skills panel's study tab.",
    today: t && t.today.sessions > 0 ? [`${plural(t.today.sessions, "session")} started today: ${t.today.fed} woke with notes, ${t.today.nothing} with nothing`] : [],
    live,
    source: "SessionStart / UserPromptSubmit hook lines in each main transcript's first 256 KB (/api/wake-recall), memory files, the vault, recall.docCount",
  };
}

export function cliStationCard(snapshot: CliStationSnapshot | null): ExplainCard {
  if (!snapshot || !snapshot.registryPresent || snapshot.clis.length === 0) {
    return { title: "💻 CLI station", what: "No CLIs registered yet — /cli-forge makes one.", today: [], live: [["CLIs", "0"]] };
  }
  const byRecency = [...snapshot.clis].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return {
    title: "💻 CLI station",
    what: "Agent-authored CLIs: a thin wrapper written once against a tool's API, so the next agent finds it instead of rebuilding it.",
    today: [],
    live: [
      ["CLIs", String(snapshot.clis.length)],
      ["Invalid entries", String(snapshot.invalidCount)],
      ["Most recent", byRecency[0]?.name ?? "—"],
    ],
    source: "~/.claude/clis/<name>/cli.json",
  };
}

export function routinesCard(list: readonly Pick<Routine, "running" | "lastExitStatus" | "ranRecently" | "shortName">[] | null): ExplainCard {
  if (!list) return { title: "🏭 Routines factory", what: "One factory per scheduled launchd job (com.stephane.*).", today: [], live: [["Routines", "no data"]] };
  const failing = list.filter((r) => r.lastExitStatus !== null && r.lastExitStatus !== 0);
  const recent = list.filter((r) => r.ranRecently).map((r) => r.shortName);
  return {
    title: "🏭 Routines factory",
    what: "One factory per scheduled launchd job (com.stephane.*). Green ran fine last time, red failed, grey never ran. Smoke means it ran in the last 5 minutes.",
    today: recent.length ? [`Ran in the last 5 min: ${recent.slice(0, 5).join(", ")}`] : [],
    live: [
      ["Routines", String(list.length)],
      ["Running now", String(list.filter((r) => r.running).length)],
      ["Failing", failing.length ? failing.map((r) => r.shortName).slice(0, 4).join(", ") : "none"],
    ],
    source: "~/Library/LaunchAgents + launchctl list (read-only)",
  };
}

// ---------------------------------------------------------------- the campus (agent-city piece 7)

function dayOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "never";
}

export interface SchoolInput {
  lamp: Lamp;
  /** The Skills snapshot's institute block; null = no data. */
  institute: Pick<InstituteSnapshot, "study"> | null;
  candidates: number | null;
  hallPanel: boolean;
}

/** 🏫 The School: the upskill study pipeline's real state, read from its own log. */
export function schoolCard(i: SchoolInput): ExplainCard {
  const st = i.institute?.study ?? null;
  const stats = st?.stats ?? null;
  const noData = "no data";
  const lampText = i.lamp.state === "lit" ? `lit: ${i.lamp.why}` : i.lamp.state === "dim" ? `dim (red lamp): ${i.lamp.why}` : i.lamp.why;
  return {
    title: "🏫 School",
    what: `Where the fleet studies new skills: the upskill autopilot reads past sessions and drafts candidate skills for you to review. Its lamp is lit when it wrote a draft in the last ${LAMP_FRESH_DAYS} days, and dim with a red lamp while it hasn't. Not the ${INSTITUTE_OF_TRUTH}: that is the three memory buildings.`,
    today: [],
    live: [
      ["Lamp", lampText],
      ["Last draft", st ? (stats ? dayOf(stats.lastDraftAt) : "never (no autopilot.log)") : noData],
      ["Last clean exit", st ? (stats ? dayOf(stats.lastSuccessAt) : "never") : noData],
      ["Last study run", st ? (stats?.lastRunAt ? new Date(stats.lastRunAt).toLocaleString() : "never") : noData],
      ["Study runs failed", st ? (stats ? `${stats.forksFailed} of ${stats.forksLaunched}` : "none ran") : noData],
      ["Autopilot", st ? (st.enabled === null ? "enabled flag unknown" : st.enabled ? "enabled" : "disabled") : noData],
      ["Candidates queued", i.candidates === null ? noData : String(i.candidates)],
    ],
    source: "~/.claude/upskill-state/autopilot.log and autopilot.json, via /api/skills/snapshot",
    actions: campusActions(i.hallPanel),
  };
}

export interface HallInput {
  /** GET /api/careers; null = no data. */
  careers: { summary: CareersSummary; workers: readonly Pick<CareerWorker, "key" | "name" | "state">[] } | null;
  /** How many trusted workers have a banner, and how many don't fit (bannerSlots). */
  banners: { shown: number; unshown: number } | null;
  /** Shipped sessions dated in the last SHIPPED_WINDOW_DAYS days; null = no data. */
  shipped: { count: number; undated: number } | null;
  hallPanel: boolean;
  /** ?redact=1: worker names and keys are hidden, as on the AUTO lot callouts. */
  redacted: boolean;
}

/** A shipped session with no merge time can't be placed in the window: with any of those the
 *  count is only a floor, and says so (a server from before evidenceAt sends none at all). */
export function shippedText(shipped: { count: number; undated: number } | null): string {
  if (!shipped) return "no data";
  const n = `${shipped.count} session${shipped.count === 1 ? "" : "s"}`;
  if (shipped.undated === 0) return n;
  const why = `${shipped.undated} shipped with no merge time`;
  return shipped.count === 0 ? `unknown (${why})` : `at least ${n} (${why})`;
}

/** 🎓 The Graduates' Hall: one banner per trusted worker, and the week's shipped sessions. */
export function hallCard(i: HallInput): ExplainCard {
  const noData = "no data";
  const trusted = i.careers?.workers.filter((w) => w.state === "trusted") ?? [];
  const names = trusted.map((w) => w.name ?? w.key);
  const live: Array<[string, string]> = [
    ["Banners", i.banners ? `${i.banners.shown}${i.banners.unshown > 0 ? ` (+${i.banners.unshown} trusted without one: max ${MAX_BANNERS})` : ""}` : noData],
    [
      "Trusted workers",
      !i.careers ? noData : !names.length ? "none yet" : i.redacted ? `${names.length} (names hidden)` : `${names.length}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` +${names.length - 6}` : ""}`,
    ],
    ["Workers in the Tower", i.careers ? String(i.careers.summary.total) : noData],
    [`Shipped, last ${SHIPPED_WINDOW_DAYS} days`, shippedText(i.shipped)],
  ];
  return {
    title: "🎓 Graduates' Hall",
    what: `One banner per trusted automation worker (its last five runs were all clean), at most ${MAX_BANNERS}; no trusted worker, no banner. The plaque counts sessions that shipped (a PR that gh reports merged) in the last ${SHIPPED_WINDOW_DAYS} days, by merge time (by when the PR was first seen if gh gave no merge time).`,
    today: [],
    live,
    source: "/api/careers (worker states, computed from runs), /api/outcomes (verdicts and merge times)",
    actions: campusActions(i.hallPanel),
  };
}

// ---------------------------------------------------------------- the Clinic (vision wave 4)

export interface ClinicInput {
  lamp: ClinicLamp;
  /** Counts over the Clinic's case list (GET /api/sickness + pushes); null until it loaded. */
  counts: SicknessCounts | null;
  /** Sick sessions; null before the snapshot or the list answered. */
  sickSessions: number | null;
  /** Where the sick-session list came from: the snapshot (until the full list lands) or the list. */
  source: "snapshot" | "cases" | null;
  /** The planet's marks: houses marked, sick sessions with no house on the planet, past the cap.
   *  `drawn` false = no System Quarter was built, so nothing is marked. */
  marks: { shown: number; unplaced: number; unshown: number; drawn: boolean };
  /** False while WebGL is off or lost: the marks are kept but nothing is drawn. */
  drawing: boolean;
  /** Cases first seen / healed since local midnight (transcript time); null until the list loaded. */
  today: { opened: number; healed: number } | null;
}

function marksText(i: ClinicInput): string {
  if (i.sickSessions === null) return "no data";
  if (!i.marks.drawn) return "none: no System Quarter on this planet";
  const extra = [i.marks.unplaced > 0 ? `${i.marks.unplaced} sick session${i.marks.unplaced === 1 ? " has" : "s have"} no house on the planet` : null, i.marks.unshown > 0 ? `+${i.marks.unshown} past the ${MAX_MARKS} cap` : null].filter(Boolean);
  const n = `${i.marks.shown} house${i.marks.shown === 1 ? "" : "s"}`;
  return `${n}${extra.length ? ` (${extra.join(", ")})` : ""}${i.drawing ? "" : " · 3D is off: not drawn"}`;
}

/** 🏥 The Clinic: the sickness detectors' cases as a place on the planet. */
export function clinicCard(i: ClinicInput): ExplainCard {
  const noData = "no data (the case list hasn't loaded)";
  const c = i.counts;
  const b = c?.byState;
  const sickNow = b ? b.open + b.chronic + b.exposed : null;
  const lampText = i.lamp.state === "lit" ? `lit: ${i.lamp.why}` : i.lamp.state === "dark" ? "dark: no sick case" : i.lamp.why;
  return {
    title: "🏥 Clinic",
    what: "Where sick minions show up on the planet. The detectors read every transcript for three diseases (a leaked key, a broken build, a page that tries to steer the agent). The lamp is lit while any case is sick (open, chronic or exposed), and every house with a sick case wears a small light: red, dark red when chronic, amber when only exposed. The Clinic panel lists every case, with the Doctor and Mark treated.",
    today: !i.today ? [noData] : i.today.opened > 0 || i.today.healed > 0 ? [`${plural(i.today.opened, "case")} first seen today · ${i.today.healed} healed today`] : [],
    live: [
      ["Lamp", lampText],
      ["Sick now", b && sickNow !== null ? `${sickNow} case${sickNow === 1 ? "" : "s"} (${b.open} open · ${b.chronic} chronic · ${b.exposed} exposed)` : noData],
      ["Sick sessions", i.sickSessions === null ? "no data" : `${i.sickSessions}${i.source === "snapshot" ? " (from the last snapshot; the live list is loading)" : ""}`],
      ["Houses marked", marksText(i)],
      ["Treated · healed", b ? `${b.treated} treated (📣 reported by you) · ${b.healed} healed` : noData],
      ["All cases", c ? `${c.total} (${c.byKind["leaked-key"]} leaked key · ${c.byKind["broken-build"]} broken build · ${c.byKind["steering-page"]} steering page)` : noData],
    ],
    source: "/api/sickness (the detectors' cases) and the world snapshot's sickness.open, as the Clinic panel reads them",
  };
}
