// "The system" in the orbit (Round 7 T3/T4): Tool Yard, lifecycle ring, machines,
// token-saver / guardrail landmarks and the memory stack. Real signals only; anything
// without one says STATIC on its card.
//
// Real signals used:
//   activity lines (WS)         → lifecycle stations, yard buildings (POW!), memory stack (brain reads, codegraph MCP)
//   agent-state transitions     → Response (working/permission → waiting/idle)
//   approvals (PermissionRequest hook) → Hook station + guardrail; its Bash preview → Verify / Persist / GitHub push
//   GET /api/replay (last 7 days) → yard building sizes (per-tool call counts)
//   POST /api/recall (Ask Jev "From your notes", seen via resource timing) → memory stack
//   sky feature machine payload → MacBook CPU / memory / battery
// Bash activity summaries carry the redacted, truncated command ("Bash: git commit -m …"), so
// Verify / git commit / git push light up from live activity as well as approval previews.

import * as THREE from "three";
import type { AgentActivity } from "../../../shared/types";
import { PLANET_R } from "../layout";
import { tiltFor } from "../scene/rig";
import { sceneParts } from "../scene/scene-bus";
import { STAGE_COLORS, buildSystem, type LandmarkId, type MachineId, type SystemTarget, type SystemVisual } from "../scene/system";
import { log } from "../log";
import { agentStateOf, onAgentStates } from "./agent-state";
import { onApprovalsChange, pendingApprovals } from "./approvals";
import { overlayLayer, place, toScreen } from "./fleet-overlay";
import {
  LIFECYCLE,
  builtinToolKey,
  isGitPush,
  isTurnEnd,
  localDate,
  staleToolyardKeys,
  stagesForActivity,
  stagesForCommand,
  TOOLYARD_KEY_PREFIX,
  toolYardBuildings,
  yardCounts,
  type LifecycleStage,
} from "./orbit-lib";
import type { ClientContext, ClientFeature } from "./registry";
import { getSkyState } from "./sky-state";
import { agentTitle } from "../../../shared/display";

const PANEL_ID = "orbit-system";
const HISTORY_DAYS = 7;
export const SELECT_EVENT = "aw:select";

interface ReplayRow {
  name: string;
  count: number;
}
interface ReplayLike {
  ok: boolean;
  events?: { toolName: string | null }[];
  truncated?: boolean;
  report?: { topTools?: ReplayRow[] };
}

let visual: SystemVisual | null = null;
let selected: SystemTarget | null = null;
const targetByLabel = new Map<string, SystemTarget>();

// ---- real-signal bookkeeping (this session) ----
const stationHits = new Map<LifecycleStage, { n: number; last: number; recent: string[] }>();
const historyCounts = new Map<string, number>(); // yard key → calls over the replay window
let historyDays = 0;
let historySampled = false;
const liveCounts = new Map<string, number>(); // yard key → calls seen live this session
const lastToolLine = new Map<string, string>();
const seenActivity = new Set<string>();
const seenApprovals = new Set<string>();
const landmarkHits = new Map<LandmarkId | MachineId, { n: number; last: number }>();
const prevStates = new Map<string, string | undefined>();
const lastBurstAt = new Map<string, number>();
let yardDirty = true;

const MACHINE_TEXT: Record<MachineId, { name: string; emoji: string; sub: string; lines: string[] }> = {
  macbook: { name: "MacBook", emoji: "💻", sub: "this machine, the primary dev box", lines: ["Claude Code and the code being shipped", "the voice agent, canvas and this world"] },
  macmini: { name: "Mac mini", emoji: "🖥️", sub: "always-on host", lines: ["the always-live service fleet", "the full scheduled-job set"] },
  icloud: { name: "iCloud Drive", emoji: "☁️", sub: "where the vault lives", lines: ["the Obsidian memory vault", "synced across both Macs"] },
  github: { name: "GitHub", emoji: "🐙", sub: "remote repos + private vault mirror", lines: ["off-site backup of the vault", "glows when a git push is seen"] },
};

const LANDMARK_TEXT: Record<LandmarkId, { name: string; emoji: string; sub: string; lines: string[]; signal: string | null }> = {
  rtk: {
    name: "RTK token saver",
    emoji: "🪙",
    sub: "token saver in Harness City",
    lines: ["A CLI proxy that trims command output before it reaches the model.", "Applied transparently through a hook; it tracks its own savings (`rtk gain`)."],
    signal: null,
  },
  guard: {
    name: "Hooks guard",
    emoji: "🛡️",
    sub: "guardrails in Harness City",
    lines: ["Plan before non-trivial work, verify before claiming done.", "Permission requests are routed to the world and wait for you."],
    signal: "Glows on every permission request (PermissionRequest hook → approvals).",
  },
  index: {
    name: "Memory index",
    emoji: "🗂️",
    sub: "the table of contents (MEMORY.md)",
    lines: ["One line per fact, loaded every session.", "Standing warnings on top, scenario bundles below."],
    signal: "Pulses when an agent reads memory/vault files, and on Ask Jev note recalls.",
  },
  graph: {
    name: "Code graph",
    emoji: "🕸️",
    sub: "code intelligence index",
    lines: ["A symbol/edge graph of the workspace.", "Answers before re-reading code."],
    signal: "Pulses on codegraph MCP calls.",
  },
  vector: {
    name: "Vector recall",
    emoji: "📡",
    sub: "local search over notes",
    lines: ["Local recall over vault + memory; the corpus stays on this machine.", "Ask Jev's \"From your notes\" uses it."],
    signal: "Pulses on each Ask Jev notes query (POST /api/recall).",
  },
  vault: {
    name: "Memory vault",
    emoji: "🔐",
    sub: "the Obsidian vault underneath",
    lines: ["The memory folder and the vault are the same directory.", "Writing a memory writes a vault note."],
    signal: "Pulses when an agent reads memory/vault files, and on Ask Jev note recalls.",
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function stageLabel(stage: LifecycleStage): string {
  return LIFECYCLE.find((s) => s.id === stage)?.label ?? stage;
}

function yardCount(key: string): number {
  return (historyCounts.get(key) ?? 0) + (liveCounts.get(key) ?? 0);
}

/** The hover label for a target; also its pick id (unique), recorded for click → card. */
function labelFor(t: SystemTarget): string {
  let text: string;
  switch (t.type) {
    case "station":
      text = `Lifecycle · ${stageLabel(t.stage)}`;
      break;
    case "yard":
      text = `Tool Yard · ${t.key} · ${yardCount(t.key)} calls`;
      break;
    case "yard-sign":
      text = "Tool Yard · built-in tools";
      break;
    case "landmark":
      text = `${LANDMARK_TEXT[t.id].name}${LANDMARK_TEXT[t.id].signal ? "" : " · static"}`;
      break;
    case "machine":
      text = `${MACHINE_TEXT[t.id].name}${t.id === "macbook" ? " · live" : " · static"}`;
      break;
  }
  targetByLabel.set(text, t);
  return text;
}

function hit(id: LandmarkId | MachineId, elapsed: number): void {
  const h = landmarkHits.get(id) ?? { n: 0, last: 0 };
  h.n += 1;
  h.last = Date.now();
  landmarkHits.set(id, h);
  if (id === "macbook" || id === "macmini" || id === "icloud" || id === "github") visual?.pulseMachine(id, elapsed);
  else visual?.pulseLandmark(id, elapsed);
}

function pulseStage(stage: LifecycleStage, line: string, elapsed: number): void {
  const h = stationHits.get(stage) ?? { n: 0, last: 0, recent: [] };
  h.n += 1;
  h.last = Date.now();
  h.recent = [line, ...h.recent].slice(0, 5);
  stationHits.set(stage, h);
  visual?.pulseStation(stage, elapsed);
}

function onActivities(list: AgentActivity[], ctx: ClientContext): void {
  const elapsed = ctx.elapsed();
  for (const a of list) {
    if (seenActivity.has(a.id)) continue;
    seenActivity.add(a.id);
    for (const s of stagesForActivity(a)) pulseStage(s, a.summary, elapsed);
    const key = builtinToolKey(a.toolName);
    if (key) {
      liveCounts.set(key, (liveCounts.get(key) ?? 0) + 1);
      lastToolLine.set(key, a.summary);
      yardDirty = true;
      visual?.pulseYard(key, elapsed);
      const top = visual?.yardTop(key);
      const lastBurst = lastBurstAt.get(key) ?? -10;
      if (top && elapsed - lastBurst > 1.2) {
        lastBurstAt.set(key, elapsed);
        ctx.labels.burst("POW!", top);
      }
    }
    if (a.stage === "brain") {
      hit("index", elapsed);
      hit("vault", elapsed);
    }
    if (a.toolName?.startsWith("mcp__codegraph__")) hit("graph", elapsed);
    if (a.toolName === "Bash" && isGitPush(a.summary)) hit("github", elapsed);
  }
  if (seenActivity.size > 4000) seenActivity.clear();
}

function onApprovals(ctx: ClientContext): void {
  const elapsed = ctx.elapsed();
  for (const ap of pendingApprovals()) {
    if (seenApprovals.has(ap.id)) continue;
    seenApprovals.add(ap.id);
    pulseStage("hook", `permission: ${ap.toolName} · ${ap.preview.title}`, elapsed);
    hit("guard", elapsed);
    const top = visual?.landmarkTop("guard");
    if (top) ctx.labels.burst("HOLD!", top);
    if (ap.preview.kind === "command") {
      for (const s of stagesForCommand(ap.preview.body)) pulseStage(s, `${ap.toolName}: ${ap.preview.title}`, elapsed);
      if (isGitPush(ap.preview.body)) hit("github", elapsed);
    }
  }
}

function onStates(ctx: ClientContext): void {
  const elapsed = ctx.elapsed();
  for (const a of ctx.store.agents.values()) {
    const next = agentStateOf(a.id);
    const prev = prevStates.get(a.id);
    if (prev !== next) {
      if (isTurnEnd(prev, next)) pulseStage("response", `${agentTitle(a)} · turn ended (${next})`, elapsed);
      prevStates.set(a.id, next);
    }
  }
}

interface DayRows {
  rows: ReplayRow[];
  sampled: boolean;
}

/** One day's per-tool call counts from the replay API. Past days never change, so they are
 *  cached in localStorage (a missing/blocked storage just means refetching). */
async function dayToolRows(ctx: ClientContext, date: string, cacheable: boolean): Promise<DayRows | null> {
  const key = `${TOOLYARD_KEY_PREFIX}${date}`;
  if (cacheable) {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as DayRows).rows)) return parsed as DayRows;
    } catch {
      // fall through to the network
    }
  }
  const res = await ctx.api.getJson<ReplayLike>(`/api/replay?date=${date}`, 20_000);
  if (!res?.ok) return null;
  // Full event list when not truncated (all tools); otherwise the report's top 10 (exact counts).
  let day: DayRows;
  if (res.events && !res.truncated) {
    const c = new Map<string, number>();
    for (const e of res.events) if (e.toolName) c.set(e.toolName, (c.get(e.toolName) ?? 0) + 1);
    day = { rows: [...c].map(([name, count]) => ({ name, count })), sampled: false };
  } else {
    day = { rows: res.report?.topTools ?? [], sampled: true };
  }
  if (cacheable) {
    try {
      localStorage.setItem(key, JSON.stringify(day));
    } catch {
      // storage full / blocked: fine
    }
  }
  return day;
}

/** Drops cached days older than the window (and malformed keys). Blocked storage: nothing to prune. */
function pruneToolyardCache(nowMs: number): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const stale = staleToolyardKeys(keys, localDate(nowMs, HISTORY_DAYS - 1));
    for (const k of stale) localStorage.removeItem(k);
    if (stale.length) log.info("orbit-system", `tool yard: pruned ${stale.length} cached day(s)`);
  } catch {
    // storage blocked: fine
  }
}

async function loadHistory(ctx: ClientContext): Promise<void> {
  const now = Date.now();
  pruneToolyardCache(now);
  historyCounts.clear();
  historyDays = 0;
  historySampled = false;
  for (let d = 0; d < HISTORY_DAYS; d++) {
    const day = await dayToolRows(ctx, localDate(now, d), d > 0);
    if (!day) continue;
    historyDays += 1;
    if (day.sampled) historySampled = true;
    for (const [k, v] of yardCounts(day.rows)) historyCounts.set(k, (historyCounts.get(k) ?? 0) + v);
    yardDirty = true;
  }
  // Live calls after this point would double count today's replay; start counting fresh.
  liveCounts.clear();
  log.info("orbit-system", `tool yard: ${historyCounts.size} tools over ${historyDays} day(s)${historySampled ? " (some days top-10 only)" : ""}`);
}

// ---------------------------------------------------------------- DOM chips

interface Chip {
  el: HTMLElement;
  pos(out: THREE.Vector3): THREE.Vector3 | null;
  /** Only when the camera is this close (world units from the centre); Infinity = always. */
  near: number;
  /** Extra visibility gate (ring / satellites hidden when the camera is inside their orbit). */
  when?: () => boolean;
}
const chips: Chip[] = [];

function mountChips(ctx: ClientContext): void {
  const layer = overlayLayer();
  const add = (text: string, cls: string, pos: Chip["pos"], near = Infinity, color?: number, when?: () => boolean): HTMLElement => {
    const el = document.createElement("div");
    el.className = `orbit-chip ${cls}`;
    el.textContent = text;
    if (color !== undefined) el.style.setProperty("--c", `#${color.toString(16).padStart(6, "0")}`);
    el.hidden = true;
    layer.appendChild(el);
    chips.push({ el, pos, near, when });
    return el;
  };
  const ringOn = (): boolean => visual?.ringVisible() ?? false;
  const machinesOn = (): boolean => visual?.machinesVisible() ?? false;
  for (const st of LIFECYCLE) add(st.label, "orbit-station", (out) => visual?.stationPos(st.id, out) ?? null, Infinity, STAGE_COLORS[st.id], ringOn);
  for (const id of Object.keys(MACHINE_TEXT) as MachineId[]) {
    const el = add(`${MACHINE_TEXT[id].emoji} ${MACHINE_TEXT[id].name}`, `orbit-machine m-${id}`, (out) => visual?.machinePos(id, out).addScaledVector(out.clone().normalize(), 3.2) ?? null, Infinity, undefined, machinesOn);
    el.dataset.machine = id;
  }
  add("🛠 Tool Yard", "orbit-sign", (out) => (visual ? out.copy(visual.yardSignPos()) : null), PLANET_R * 2.6);
  for (const id of Object.keys(LANDMARK_TEXT) as LandmarkId[]) {
    add(`${LANDMARK_TEXT[id].emoji} ${LANDMARK_TEXT[id].name}`, "orbit-landmark", (out) => (visual ? out.copy(visual.landmarkTop(id)) : null), PLANET_R * 1.9);
  }
  void ctx;
}

function refreshMachineChips(): void {
  const sky = getSkyState();
  for (const c of chips) {
    const id = c.el.dataset.machine as MachineId | undefined;
    if (!id) continue;
    const t = MACHINE_TEXT[id];
    let status = "static";
    if (id === "macbook") {
      const cpu = sky?.machine.cpuPercent;
      status = cpu === null || cpu === undefined ? "live · CPU n/a" : `live · CPU ${Math.round(cpu)}%`;
    } else if (id === "github" && landmarkHits.get("github")) status = "push seen";
    c.el.textContent = status === "static" ? `${t.emoji} ${t.name}` : `${t.emoji} ${t.name} · ${status}`;
    c.el.classList.toggle("is-static", status === "static");
  }
}

const tmpV = new THREE.Vector3();
function updateChips(ctx: ClientContext): void {
  const show = visual?.group.visible ?? false;
  const dist = ctx.camera.position.length();
  for (const c of chips) {
    if (!show || dist > c.near || (c.when && !c.when())) {
      c.el.hidden = true;
      continue;
    }
    const p = c.pos(tmpV);
    if (!p) {
      c.el.hidden = true;
      continue;
    }
    place(c.el, toScreen(ctx, p));
  }
}

const CSS = `
.orbit-chip { font: 700 11px/1.1 var(--font-ui, system-ui), sans-serif; padding: 3px 7px; border-radius: 999px;
  background: #fffdf6; color: #2a1850; border: 2px solid #2a1850; box-shadow: 2px 2px 0 #2a1850;
  white-space: nowrap; translate: -50% -130%; }
.orbit-chip.orbit-station { border-color: var(--c, #2a1850); box-shadow: 2px 2px 0 var(--c, #2a1850); font-size: 10px; }
.orbit-chip.orbit-machine.is-static::after { content: " STATIC"; font-size: 8px; letter-spacing: .06em; color: #8a7fa0; }
.orbit-chip.orbit-sign { background: #ffd23f; font-size: 12px; }
.orbit-chip.orbit-landmark { font-size: 10px; opacity: .92; }
.orbit-card h3 { margin: 0 0 4px; font-size: 16px; }
.orbit-card .sub { color: #6b5f86; margin: 0 0 8px; font-size: 12px; }
.orbit-card .badge { display: inline-block; font: 800 10px/1 system-ui, sans-serif; letter-spacing: .06em; padding: 3px 6px; border-radius: 6px; margin-left: 6px; vertical-align: middle; }
.orbit-card .badge.live { background: #d9f99d; color: #1d5b0f; }
.orbit-card .badge.static { background: #ece8f5; color: #5d5470; }
.orbit-card .badge.heuristic { background: #ffe8a3; color: #7a5200; }
.orbit-card ul { margin: 6px 0; padding-left: 18px; font-size: 13px; }
.orbit-card .kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 13px; margin: 8px 0; }
.orbit-card .kv b { font-weight: 700; }
.orbit-card .note { font-size: 11px; color: #6b5f86; margin-top: 8px; }
`;

// ---------------------------------------------------------------- card

function ago(ms: number): string {
  if (!ms) return "not yet this session";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ms).toLocaleTimeString();
}

function renderCard(el: HTMLElement): void {
  el.classList.add("orbit-card");
  const t = selected;
  if (!t) {
    el.innerHTML = `<p>Hover or click a lifecycle station, a Tool Yard building, a machine or a Harness landmark.</p>`;
    return;
  }
  const badge = (kind: "live" | "static" | "heuristic"): string => `<span class="badge ${kind}">${kind.toUpperCase()}</span>`;
  const list = (lines: string[]): string => `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
  switch (t.type) {
    case "station": {
      const st = LIFECYCLE.find((s) => s.id === t.stage);
      const h = stationHits.get(t.stage);
      const heuristic = t.stage === "response" || t.stage === "verify";
      el.innerHTML = `<h3>${esc(st?.label ?? t.stage)} ${badge(heuristic ? "heuristic" : "live")}</h3>
        <p class="sub">Lifecycle: Prompt → Hook → Plan/Skill → Reason → Tools → Subagents → Verify → Persist → Response</p>
        <div class="kv"><b>Lights on</b><span>${esc(st?.signal ?? "")}</span>
        <b>Pulses</b><span>${h?.n ?? 0} this session</span><b>Last</b><span>${esc(ago(h?.last ?? 0))}</span></div>
        ${h?.recent.length ? `<b>Recent</b>${list(h.recent)}` : ""}
        ${t.stage === "verify" || t.stage === "persist" ? `<p class="note">Seen in Bash activity lines (the command, redacted and cut at 80 characters) and permission-request previews. Write/Edit always count as Persist.</p>` : ""}`;
      return;
    }
    case "yard":
    case "yard-sign": {
      const rows = toolYardBuildings(new Map([...new Set([...historyCounts.keys(), ...liveCounts.keys()])].map((k) => [k, yardCount(k)])));
      const focus = t.type === "yard" ? t.key : null;
      el.innerHTML = `<h3>${focus ? `🛠 ${esc(focus)}` : "🛠 Tool Yard"} ${badge("live")}</h3>
        <p class="sub">One building per built-in tool actually used; height = log of real call counts.</p>
        ${focus ? `<div class="kv"><b>Calls</b><span>${yardCount(focus)} (${historyDays}-day replay + live)</span><b>Live</b><span>${liveCounts.get(focus) ?? 0} this session</span><b>Last line</b><span>${esc(lastToolLine.get(focus) ?? "–")}</span></div>` : ""}
        <div class="kv">${rows.map((r) => `<b>${esc(r.key)}</b><span>${r.count}</span>`).join("") || "<span>No tool calls in the replay window yet.</span>"}</div>
        <p class="note">Source: GET /api/replay for the last ${HISTORY_DAYS} days${historySampled ? " (busy days: top-10 tools only)" : ""}, plus live activity. MCP tools are antennas in Harness City, not here.</p>`;
      return;
    }
    case "landmark": {
      const x = LANDMARK_TEXT[t.id];
      const h = landmarkHits.get(t.id);
      el.innerHTML = `<h3>${x.emoji} ${esc(x.name)} ${badge(x.signal ? "live" : "static")}</h3><p class="sub">${esc(x.sub)}</p>${list(x.lines)}
        <div class="kv"><b>Signal</b><span>${esc(x.signal ?? "None available to the world: this card is static.")}</span>
        ${x.signal ? `<b>Pulses</b><span>${h?.n ?? 0} this session · last ${esc(ago(h?.last ?? 0))}</span>` : ""}</div>`;
      return;
    }
    case "machine": {
      const x = MACHINE_TEXT[t.id];
      const sky = getSkyState();
      const live = t.id === "macbook";
      const m = sky?.machine;
      const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `${Math.round(v)}%`);
      const h = landmarkHits.get(t.id);
      el.innerHTML = `<h3>${x.emoji} ${esc(x.name)} ${badge(live ? "live" : "static")}</h3><p class="sub">${esc(x.sub)}</p>${list(x.lines)}
        ${live ? `<div class="kv"><b>CPU</b><span>${pct(m?.cpuPercent)}</span><b>Memory</b><span>${pct(m?.memPercent)}</span><b>Battery</b><span>${pct(m?.batteryPercent)}${m?.batteryCharging ? " (charging)" : ""}</span><b>Updated</b><span>${esc(sky?.at ? new Date(sky.at).toLocaleTimeString() : "n/a")}</span></div>` : `<p class="note">No live signal from this machine reaches the world, so no status is shown.${t.id === "github" ? ` Git pushes seen this session: ${h?.n ?? 0} (from permission previews).` : ""}</p>`}`;
      return;
    }
  }
}

function select(t: SystemTarget, ctx: ClientContext): void {
  selected = t;
  ctx.openPanel(PANEL_ID);
  window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { kind: "system", target: t } }));
}

function mountPicking(ctx: ClientContext): void {
  const canvas = sceneParts().rig?.renderer.domElement;
  if (!canvas) return;
  const down = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (ev) => {
    down.x = ev.clientX;
    down.y = ev.clientY;
  });
  canvas.addEventListener("click", (ev) => {
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6 || document.body.classList.contains("in-room")) return;
    const pick = sceneParts().pick;
    if (!pick || !visual?.group.visible) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const p = pick.pick(ndc, ctx.camera, PLANET_R + 0.4);
    const target = p?.kind === "system" ? targetByLabel.get(p.id) : undefined;
    if (target) select(target, ctx);
  });
}

function watchRecall(ctx: ClientContext): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!/\/api\/recall(\?|$)/.test(new URL(e.name, location.href).pathname)) continue;
        const elapsed = ctx.elapsed();
        hit("vector", elapsed);
        hit("index", elapsed);
        hit("vault", elapsed);
        const top = visual?.landmarkTop("vector");
        if (top) ctx.labels.burst("RECALL!", top);
      }
    }).observe({ type: "resource", buffered: false });
  } catch (err) {
    log.warn("orbit-system", "resource timing unavailable; recall pulses off", err);
  }
}

/** Debug/screenshot framing: ?system=yard | ring | machines. Stops the hub's auto-rotate the way a
 *  user would (a wheel event), then places the camera. */
function frameDebug(ctx: ClientContext, what: string | null): void {
  if (!what || !visual) return;
  const canvas = sceneParts().rig?.renderer.domElement;
  canvas?.dispatchEvent(new WheelEvent("wheel", { deltaY: 0 }));
  const cam = ctx.camera;
  if (what === "yard") {
    // Like main.ts's flyToCity: land "south" of the spot so the flyover tilt frames it.
    const p = visual.yardSignPos().normalize();
    const h = 26;
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(p, -p.y).normalize();
    const dir = p.clone().multiplyScalar(PLANET_R).addScaledVector(north, -h * 1.05 * tiltFor(h)).normalize();
    cam.position.copy(dir).multiplyScalar(PLANET_R + h);
  } else if (what === "ring" || what === "machines") {
    // Look down the orbit's axis (tilted a little) so it reads as a ring around the planet.
    const axis = what === "ring" ? visual.ringAxis() : visual.machineAxis();
    const side = new THREE.Vector3(0, 1, 0).cross(axis).normalize();
    cam.position.copy(axis).addScaledVector(side, 0.35).normalize().multiplyScalar(what === "ring" ? PLANET_R * 3.6 : PLANET_R * 4.6);
  }
}

export const orbitSystemFeature: ClientFeature = {
  id: "orbit-system",
  mount(ctx) {
    const parts = sceneParts();
    const harness = parts.layout?.find((c) => c.id === "harness");
    if (!harness || !parts.pick) {
      log.warn("orbit-system", "no Harness City or pick registry; system layer off");
      return;
    }
    visual = buildSystem({ harness, pick: parts.pick, label: labelFor });
    ctx.scene.add(visual.group);
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    mountChips(ctx);
    mountPicking(ctx);
    watchRecall(ctx);
    for (const a of ctx.store.agents.values()) prevStates.set(a.id, agentStateOf(a.id));
    ctx.store.onActivity((fresh) => onActivities(fresh, ctx));
    onAgentStates(() => onStates(ctx));
    onApprovalsChange(() => onApprovals(ctx));
    for (const ap of pendingApprovals()) seenApprovals.add(ap.id); // already on screen before we mounted
    void loadHistory(ctx).then(() => (yardDirty = true));
    window.setInterval(() => void loadHistory(ctx), 30 * 60_000);
    const debug = new URLSearchParams(window.location.search).get("system");
    if (debug) window.setTimeout(() => frameDebug(ctx, debug), 600);
  },
  onFrame(dt, ctx) {
    if (!visual) return;
    const elapsed = ctx.elapsed();
    if (yardDirty) {
      yardDirty = false;
      const keys = new Set([...historyCounts.keys(), ...liveCounts.keys()]);
      visual.setYard(toolYardBuildings(new Map([...keys].map((k) => [k, yardCount(k)]))));
    }
    visual.update(dt, elapsed, ctx.camera.position.length());
    if (Math.floor(elapsed * 2) !== Math.floor((elapsed - dt) * 2)) refreshMachineChips();
    updateChips(ctx);
  },
  panels: [{ id: PANEL_ID, title: "The system", render: (el) => renderCard(el) }],
  paletteCommands: (ctx) => [
    {
      id: "tool-yard",
      title: "Show the Tool Yard",
      kind: "place",
      keywords: ["tools", "bash", "read", "edit", "yard", "system"],
      run: () => {
        ctx.flyTo("harness");
        select({ type: "yard-sign" }, ctx);
      },
    },
    {
      id: "lifecycle",
      title: "Lifecycle ring: what each station means",
      kind: "system",
      keywords: ["prompt", "hook", "verify", "persist", "response", "lifecycle"],
      run: () => select({ type: "station", stage: "prompt" }, ctx),
    },
  ],
};

/** For tests / other features: the target a pick id (hover label) stands for. */
export function systemTargetFor(label: string): SystemTarget | undefined {
  return targetByLabel.get(label);
}

