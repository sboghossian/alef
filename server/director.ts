// Jev world director. Runs at most once every 60s (the caller in index.ts
// enforces the cadence; this module just does one tick when asked) and
// issues at most one TypeSafe request per tick: which harness skill/MCP most
// deserves to grow, ranked by real usage. Falls back to deterministic rules when there's
// no API key or the call fails/times out — same application logic either way,
// only the `source`/`confidence` on the logged decision differs.
//
// Movement is not Jev's to decide. A plane flies only when a LIVE session is editing files in
// another island's folder, and a road joins two cities only where a session's touched files prove
// a visit (trips-lib.ts). No model call, no invented pairing.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { JevDecision, JevState } from "../shared/types.js";
import type { ObjectWithUsage, WorldDb } from "./db.js";
import type { Role } from "./heuristics.js";
import { log } from "./log.js";
import { diffVisits, newestTouch, newTrips, type Trip } from "./trips-lib.js";
import { HONEST_TRIPS_FLAG, runHonestTripsMigration, TRIPS_CURSOR_KEY, visitsFromDb } from "./trips-migration.js";

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const TIMEOUT_MS = 8000;
const ROAM_TICKS = 3;
const GROWTH_STEP = 0.1;
const MAX_GROW_CANDIDATES = 15;

export interface AgentSnapshot {
  id: string;
  islandId: string; // home island
  title: string;
  role: Role;
  status: "live" | "dormant";
  lastActive: string; // ISO
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DirectorOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  idGen?: () => string;
  /** Where paths outside every repo island fall back to the home island. Defaults to os.homedir(). */
  homeDir?: string;
}

export interface DirectorTickResult {
  status: JevState["status"];
  decisions: JevDecision[];
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

interface DirectorQuestions {
  growCandidates: ObjectWithUsage[];
  payload: Record<string, ChoiceQuestion>;
  state: Record<string, unknown>;
}

/** Jev's only question: which of the most-used harness skills/MCPs grows. Null when there are none. */
export function buildQuestions(growCandidates: ObjectWithUsage[]): DirectorQuestions | null {
  if (growCandidates.length === 0) return null;
  const criteria: Record<string, string | null> = {};
  for (const c of growCandidates) criteria[c.id] = `${c.kind} "${c.name}", used by ${c.usage} session(s) recently`;
  const payload: Record<string, ChoiceQuestion> = {
    grow: {
      type: "choice",
      instructions: "growCandidates (see state) are harness skills/MCP servers ranked by recent usage. Which one most deserves to grow right now?",
      criteria,
    },
  };
  const state = { growCandidates: growCandidates.map((c) => ({ id: c.id, kind: c.kind, name: c.name, usage: c.usage })) };
  return { growCandidates, payload, state };
}

// ── Rules fallback (most-used) ──────────────────────────────────────────────

function ruleAnswers(q: DirectorQuestions): { grow?: ChoiceAnswer } {
  const top = [...q.growCandidates].sort((a, b) => b.usage - a.usage)[0]!;
  return { grow: { choice: top.id, probabilities: { [top.id]: 1 }, confidence: 1 } };
}

// ── TypeSafe call ──────────────────────────────────────────────────────────

export function isChoiceAnswer(x: unknown): x is ChoiceAnswer {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.choice === "string" &&
    typeof o.confidence === "number" &&
    typeof o.probabilities === "object" &&
    o.probabilities !== null
  );
}

/** Shared TypeSafe HTTP call — reused as-is by ask-jev.ts so both callers hit the
 *  same endpoint, auth, and timeout behavior. */
export async function callJev(apiKey: string, body: unknown, fetchImpl: FetchLike, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(TYPESAFE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Release the connection before throwing. undici holds the socket open until the body is
      // read or cancelled, so every error response used to leak one -- and all seven callers of
      // this function reach it, each on its own schedule (the director ticks, the router runs per
      // prompt). A run of 500s was quietly retiring sockets with nothing left to consume them.
      try {
        await res.body?.cancel();
      } catch {
        /* already errored or disturbed: there is nothing left to release */
      }
      throw new Error(`typesafe http ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseAnswers(raw: unknown, expectedKeys: string[]): { grow?: ChoiceAnswer } {
  if (typeof raw !== "object" || raw === null) throw new Error("typesafe response not an object");
  const answers = (raw as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null) throw new Error("typesafe response missing answers");
  const out: { grow?: ChoiceAnswer } = {};
  for (const key of expectedKeys) {
    const a = (answers as Record<string, unknown>)[key];
    if (!isChoiceAnswer(a)) throw new Error(`typesafe response missing/invalid answer for "${key}"`);
    if (key === "grow") out.grow = a;
  }
  return out;
}

// ── Applying answers (shared by jev + rules paths) ─────────────────────────

function applyAnswers(
  db: WorldDb,
  q: DirectorQuestions,
  answers: { grow?: ChoiceAnswer },
  source: "jev" | "rules",
  now: () => Date,
  idGen: () => string,
): JevDecision[] {
  const decisions: JevDecision[] = [];
  const nowIso = () => now().toISOString();

  if (answers.grow) {
    const ans = answers.grow;
    const obj = q.growCandidates.find((c) => c.id === ans.choice);
    const newGrowth = db.bumpGrowth(ans.choice, GROWTH_STEP);
    decisions.push({
      id: idGen(),
      at: nowIso(),
      kind: "grow",
      subjects: [ans.choice],
      choice: ans.choice,
      probabilities: ans.probabilities,
      confidence: ans.confidence,
      source,
      summary: obj ? `${obj.kind} "${obj.name}" grows (now ${newGrowth.toFixed(2)})` : `${ans.choice} grows (now ${newGrowth.toFixed(2)})`,
    });
  }

  for (const d of decisions) db.insertDecision(d);
  return decisions;
}

// ── Honest trips (trips-lib.ts) ──────────────────────────────────────────────

/**
 * Keeps the stored `visited` edges equal to what the touched edges prove (one listEdges() read),
 * flies each LIVE session that touched another island's files since the last tick there, and sends
 * any dormant roamer home. Writes nothing until the one-time cleanup has run (its backup may have
 * failed this boot), so the old invented edges are never touched without a backup.
 */
function syncTrips(db: WorldDb, agents: readonly AgentSnapshot[], homeDir: string): Trip[] {
  if (db.getMeta(HONEST_TRIPS_FLAG) !== "1") return [];
  const edges = db.listEdges();
  const visits = visitsFromDb(db, edges, homeDir);
  const { put, remove } = diffVisits(edges, visits);
  const live = new Set(agents.filter((a) => a.status === "live").map((a) => a.id));
  const since = db.getMeta(TRIPS_CURSOR_KEY);
  // No cursor yet: this tick only sets it, so a restart never replays old touches as new trips.
  const trips = since === null ? [] : newTrips(visits, since, live);
  const cursor = newestTouch(edges);
  const strays = db.listSessions().filter((s) => s.targetIslandId !== s.islandId && !live.has(s.id));
  db.transaction(() => {
    for (const r of remove) db.deleteEdge(r.from, r.to, "visited");
    for (const v of put) db.putEdge(v);
    for (const s of strays) db.sendHome(s.id);
    for (const t of trips) db.setTarget(t.sessionId, t.islandId, ROAM_TICKS);
    if (cursor !== null && (since === null || cursor > since)) db.setMeta(TRIPS_CURSOR_KEY, cursor);
  });
  if (put.length > 0 || remove.length > 0) log.info("trips", `visits: ${put.length} written, ${remove.length} removed (${visits.length} total)`);
  if (strays.length > 0) log.info("trips", `${strays.length} dormant agent(s) sent home`);
  for (const t of trips) log.info("trips", `live agent ${t.sessionId.slice(0, 8)} flies to ${t.islandId} (edited a file there at ${t.at})`);
  return trips;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function runDirectorTick(
  db: WorldDb,
  agents: AgentSnapshot[],
  options: DirectorOptions = {},
): Promise<DirectorTickResult> {
  const now = options.now ?? (() => new Date());
  const idGen = options.idGen ?? randomUUID;
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const homeDir = options.homeDir ?? homedir();

  // Housekeeping runs every tick regardless of Jev availability.
  await runHonestTripsMigration(db, { homeDir, now });
  const sentHome = db.tickRoamers();
  if (sentHome.length > 0) log.info("director", `${sentHome.length} agent(s) returned home`);
  syncTrips(db, agents, homeDir);

  const growCandidates = db
    .listObjectsWithUsage()
    .filter((o) => o.islandId === "harness" && (o.kind === "skill" || o.kind === "mcp") && o.growth < 1) // fully grown can't grow
    .sort((a, b) => b.usage - a.usage)
    .slice(0, MAX_GROW_CANDIDATES);

  const q = buildQuestions(growCandidates);
  if (!q) {
    log.info("director", "nothing to decide this tick (no harness skill/MCP left to grow)");
    return { status: apiKey ? "online" : "disabled", decisions: [] };
  }

  if (!apiKey) {
    const decisions = applyAnswers(db, q, ruleAnswers(q), "rules", now, idGen);
    return { status: "disabled", decisions };
  }

  try {
    const raw = await callJev(apiKey, { state: q.state, model: "jev-latest", questions: q.payload }, fetchImpl, TIMEOUT_MS);
    const answers = parseAnswers(raw, Object.keys(q.payload));
    const decisions = applyAnswers(db, q, answers, "jev", now, idGen);
    return { status: "online", decisions };
  } catch (err) {
    log.warn("director", "typesafe call failed, falling back to rules", String(err));
    const decisions = applyAnswers(db, q, ruleAnswers(q), "rules", now, idGen);
    return { status: "fallback", decisions };
  }
}
