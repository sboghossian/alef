// 🩺 Health keeper: keeps Health at 100 without anyone remembering to look. Once a night at 04:30
// local (HEALTH_KEEPER_AT; a 04:30 missed while the Mac slept or the server was down runs on the
// next tick, once):
//   1. it runs the suite through the Health "Run tests" button's own code path (completeness.ts's
//      runTests: single-flight vitest, results recorded in data/completeness-tests.json) — every
//      night, regardless of how fresh the last run was; a run already in progress is joined, not
//      duplicated;
//   2. it recomputes every Health check;
//   3. under 100, ONE Inbox item for that local date: "Health N%: <check> — <its fix>; …" (a second
//      pass the same day never adds another); the item resolves itself once Health reads 100;
//   4. always one Feed line "Health: N%".
// State (the slot it last handled, its last score and failing checks, the Inbox item) lives in
// data/health-keeper.json, written to a temp file and renamed. A first boot with no state file
// starts from the NEXT 04:30, never at boot.
//
// It never edits settings, never trusts a folder, never logs in, never restarts anything and never
// runs launchctl itself. (Recomputing the checks runs the same read-only probes Health's 60 s tick
// runs, e.g. the routines check's `launchctl list` status dump.)
//
//   GET /api/health-keeper → HealthKeeperResponse (lastRunAt, nextRunAt, lastScore, lastFailing, …)

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeScore, isPinnable, type CheckDismissals } from "../../shared/features/completeness.js";
import { govTag } from "../../shared/features/feed.js";
import {
  HEALTH_KEEPER_EXTRAS_KEY,
  isHealthKeeperInboxItem,
  isHealthKeeperIssue,
  type HealthKeeperInboxItem,
  type HealthKeeperIssue,
  type HealthKeeperMessage,
  type HealthKeeperResponse,
  type HealthKeeperState,
  type HealthKeeperTests,
} from "../../shared/features/health-keeper.js";
import { isRecord, respondJson } from "../http.js";
import { completenessFeature, currentHealthChecks, type HealthHandle } from "./completeness.js";
import { appendToFeed } from "./feed.js";
import { feedDetail, inboxText, isDue, keeperIssues, localDateKey, nextSlotAfter, slotAtOrBefore, testsRunReason } from "./health-keeper-lib.js";
import { dismissalsPathFor, dismissalStoreFor, withDismissals } from "./health-dismissals.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

const TICK_MS = 60_000;

type FeedDraft = Parameters<typeof appendToFeed>[0];

export interface HealthKeeperOptions {
  /** The Health feature it drives (default: the registered completenessFeature). */
  health?: Pick<HealthHandle, "runTests" | "recompute" | "lastTestsRunAt">;
  now?: () => number;
  /** Health's latest server score, for resolving the Inbox item (default: completeness's last recompute). */
  currentScore?: () => number | null;

  appendFeed?: (item: FeedDraft) => void;
  tickIntervalMs?: number;
}

/** What data/health-keeper.json holds. */
interface Persisted {
  lastSlotAt: string | null;
  lastRunAt: string | null;
  lastScore: number | null;
  lastFailing: HealthKeeperIssue[];
  lastTests: HealthKeeperTests | null;
  inbox: HealthKeeperInboxItem | null;
  lastError: string | null;
}

function emptyPersisted(): Persisted {
  return { lastSlotAt: null, lastRunAt: null, lastScore: null, lastFailing: [], lastTests: null, inbox: null, lastError: null };
}

/** Parses the state file; anything malformed reads as null (the keeper then starts over from the next 04:30). */
export function parseKeeperFile(text: string): Persisted | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.lastSlotAt !== "string" || !Number.isFinite(Date.parse(raw.lastSlotAt))) return null;
  const p = emptyPersisted();
  p.lastSlotAt = raw.lastSlotAt;
  if (typeof raw.lastRunAt === "string") p.lastRunAt = raw.lastRunAt;
  if (typeof raw.lastScore === "number") p.lastScore = raw.lastScore;
  if (Array.isArray(raw.lastFailing)) p.lastFailing = raw.lastFailing.filter(isHealthKeeperIssue);
  if (isRecord(raw.lastTests) && typeof raw.lastTests.ran === "boolean" && typeof raw.lastTests.reason === "string") p.lastTests = raw.lastTests as unknown as HealthKeeperTests;
  if (isHealthKeeperInboxItem(raw.inbox)) p.inbox = raw.inbox;
  if (typeof raw.lastError === "string") p.lastError = raw.lastError;
  return p;
}

export function keeperStatePath(dbPath: string): string {
  return join(dirname(dbPath), "health-keeper.json");
}

const iso = (ms: number): string => new Date(ms).toISOString();

export interface HealthKeeperFeature extends ServerFeature {
  /** Test/introspection: the state GET /api/health-keeper serves. */
  state(): HealthKeeperState;
}

export function createHealthKeeperFeature(opts: HealthKeeperOptions = {}): HealthKeeperFeature {
  const health = opts.health ?? completenessFeature;
  const now = opts.now ?? Date.now;
  const currentScore =
    opts.currentScore ??
    ((): number | null => {
      const cur = currentHealthChecks();
      return cur ? computeScore(cur.checks) : null;
    });
  const appendFeed = opts.appendFeed ?? appendToFeed;
  let st: Persisted = emptyPersisted();
  let loaded = false;
  let running = false;
  /** The dismissal store's file (set on load, from the db path); null before. */
  let dismissalsPath: string | null = null;
  let unsubscribe: (() => void) | null = null;

  function dismissals(): CheckDismissals {
    return dismissalsPath ? dismissalStoreFor(dismissalsPath).list(now()) : {};
  }

  /** The Inbox item as served: snoozed / won't-fix checks left out (Health still lists them),
   *  and no item at all once every issue on it is dismissed. Persisted state keeps them all, so
   *  an undo brings the row back. */
  function servedInbox(): HealthKeeperInboxItem | null {
    const item = st.inbox;
    if (!item) return null;
    const d = dismissals();
    const issues = item.issues.filter((i) => !d[i.id]);
    if (issues.length === item.issues.length) return item;
    if (issues.length === 0) return null;
    return { ...item, issues, text: inboxText(item.score, issues) };
  }

  function publicState(): HealthKeeperState {
    const lastSlotMs = st.lastSlotAt === null ? slotAtOrBefore(now()) : Date.parse(st.lastSlotAt);
    return {
      lastRunAt: st.lastRunAt,
      nextRunAt: iso(nextSlotAfter(lastSlotMs)),
      lastScore: st.lastScore,
      lastFailing: st.lastFailing,
      lastTests: st.lastTests,
      running,
      inbox: servedInbox(),
      lastError: st.lastError,
    };
  }

  async function persist(ctx: FeatureContext): Promise<void> {
    const path = keeperStatePath(ctx.config.dbPath);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, JSON.stringify(st, null, 2), "utf8");
      await rename(tmp, path);
    } catch (err) {
      ctx.log.error("health-keeper", "couldn't write its state file", String(err));
    }
  }

  function emit(ctx: FeatureContext): void {
    ctx.emit({ kind: "state", state: publicState() } satisfies HealthKeeperMessage);
  }

  async function load(ctx: FeatureContext): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(keeperStatePath(ctx.config.dbPath), "utf8");
    } catch {
      text = null; // first boot: no state yet
    }
    const parsed = text === null ? null : parseKeeperFile(text);
    if (parsed) st = parsed;
    else {
      // No (usable) state: the first pass is the NEXT 04:30, never a test run at boot. Written now,
      // so a restart later today doesn't move that first pass another day out.
      st = { ...emptyPersisted(), lastSlotAt: iso(slotAtOrBefore(now())) };
      if (text !== null) ctx.log.warn("health-keeper", "its state file was unreadable; starting over from the next 04:30");
      await persist(ctx);
    }
    loaded = true;
    dismissalsPath = dismissalsPathFor(ctx.config.dbPath);
    unsubscribe?.();
    unsubscribe = dismissalStoreFor(dismissalsPath).onChange(() => emit(ctx));
  }

  /** The Inbox item goes away once Health reads 100 again (any recompute, not only the keeper's).
   *  An item whose issues are all dismissed is only hidden (servedInbox), never resolved, so undo
   *  brings it back. */
  async function maybeResolveInbox(ctx: FeatureContext): Promise<void> {
    if (!st.inbox || st.inbox.resolvedAt !== null) return;
    if (currentScore() !== 100) return;
    st.inbox = { ...st.inbox, resolvedAt: iso(now()) };
    await persist(ctx);
    emit(ctx);
  }

  async function runNight(ctx: FeatureContext, slotMs: number): Promise<void> {
    running = true;
    emit(ctx);
    const startedMs = now();
    let lastError: string | null = null;
    try {
      const reason = testsRunReason(await health.lastTestsRunAt(ctx), startedMs);
      ctx.log.info("health-keeper", `running the Health test suite: ${reason}`);
      const r = await health.runTests(ctx);
      const tests: HealthKeeperTests = { ran: true, reason, ok: r.ok, passed: r.passed, failed: r.failed, total: r.total };
      const { checks, score } = await health.recompute(ctx);
      const issues = keeperIssues(checks);
      const pinnable = keeperIssues(withDismissals(checks, dismissals(), now()).filter(isPinnable));
      const doneMs = now();
      st.lastScore = score;
      st.lastFailing = issues;
      st.lastTests = tests;
      if (score < 100 && pinnable.length > 0) {
        const date = localDateKey(doneMs);
        if (st.inbox?.date !== date) st.inbox = { date, at: iso(doneMs), score, text: inboxText(score, issues), issues, resolvedAt: null };
      }
      appendFeed({ id: `health-keeper:${iso(slotMs)}`, at: iso(doneMs), kind: "decision", agentId: null, title: `Health: ${score}%`, detail: feedDetail(issues, tests), tag: govTag("health") });
      ctx.log.info("health-keeper", `night pass: Health ${score}%${issues.length ? ` (${issues.map((i) => i.id).join(", ")})` : ""}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      ctx.log.error("health-keeper", "night pass failed", lastError);
      appendFeed({ id: `health-keeper:${iso(slotMs)}`, at: iso(now()), kind: "decision", agentId: null, title: "Health: the keeper's night pass failed", detail: lastError.slice(0, 300), tag: govTag("health") });
    } finally {
      // The slot is handled even on a failure: one attempt per night, never a retry every minute.
      st.lastSlotAt = iso(slotMs);
      st.lastRunAt = iso(startedMs);
      st.lastError = lastError;
      running = false;
      await persist(ctx);
      emit(ctx);
    }
  }

  return {
    id: "health-keeper",
    tickIntervalMs: opts.tickIntervalMs ?? TICK_MS,
    state: publicState,
    async onStart(ctx) {
      await load(ctx);
    },
    async onTick(ctx) {
      if (!loaded) await load(ctx);
      await maybeResolveInbox(ctx);
      const nowMs = now();
      const lastSlotMs = st.lastSlotAt === null ? null : Date.parse(st.lastSlotAt);
      if (!isDue(lastSlotMs, nowMs)) return;
      await runNight(ctx, slotAtOrBefore(nowMs));
    },
    routes: [
      {
        method: "GET",
        path: "/api/health-keeper",
        handler(_req, res) {
          respondJson(res, 200, { ok: true, ...publicState() } satisfies HealthKeeperResponse);
        },
      },
    ],
    snapshotExtras() {
      return { [HEALTH_KEEPER_EXTRAS_KEY]: publicState() };
    },
  };
}

export const healthKeeperFeature = createHealthKeeperFeature();
