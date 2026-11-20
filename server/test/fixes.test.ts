// The Fix queue: the pure merge (fixes-lib.ts), its store (fixes-store.ts) and the feature's routes
// on a booted server. Every input is a plain fixture; nothing here reads a real transcript, todo.md
// or vault.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckDismissal, CompletenessCheck } from "../../shared/features/completeness.js";
import { FIX_SOURCE_CAP, healthFixPrompt, isFixId, type FixActionResult, type FixesResponse, type FixRowResponse } from "../../shared/features/fixes.js";
import type { LoopsBoard, LoopsItem } from "../../shared/features/loops.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { SicknessCase } from "../../shared/features/sickness.js";
import type { VaultGaps } from "../../shared/features/vault.js";
import { createFixesFeature } from "../features/fixes.js";
import { buildFixQueue, openTotal, type FixInputs } from "../features/fixes-lib.js";
import { fixesStoreFor, parseFixesFile, resetFixesStoresForTests } from "../features/fixes-store.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function check(p: Partial<CompletenessCheck> & Pick<CompletenessCheck, "id" | "state">): CompletenessCheck {
  return { label: p.id, group: "see", weight: 1, detail: `${p.id} detail`, ...p };
}

function sick(p: Partial<SicknessCase> = {}): SicknessCase {
  return {
    id: "case-hash",
    kind: "broken-build",
    state: "open",
    sessionId: "11111111-1111-1111-1111-111111111111",
    subagentId: null,
    lineage: null,
    district: "demo",
    label: "npm test failing",
    source: { tool: "Bash", target: "npm test" },
    detail: { cmdClass: "npm test", hash10: "abcdef0123" },
    firstSeenAt: iso(NOW - 2 * DAY),
    lastSeenAt: iso(NOW - DAY),
    occurrences: 3,
    healedAt: null,
    ...p,
  };
}

function outcome(p: Partial<OutcomeRecord> & Pick<OutcomeRecord, "sessionId" | "outcome">): OutcomeRecord {
  return {
    reason: null,
    evidenceAt: null,
    lastActive: iso(NOW - DAY),
    toolCalls: 0,
    writes: 0,
    learnings: [],
    artifacts: [],
    prs: [],
    pushes: [],
    todos: null,
    ending: null,
    onDisk: true,
    pending: false,
    provisionalUntil: null,
    ...p,
  };
}

function loop(p: Partial<LoopsItem> & Pick<LoopsItem, "id">): LoopsItem {
  return {
    task: `task ${p.id}`,
    project: "demo",
    lens: "unranked",
    score: 0,
    sources: ["scan"],
    sourceType: "todo_md",
    updatedAt: iso(NOW - 20 * DAY),
    openPath: "/home/u/Documents/Code/demo/tasks/todo.md",
    launchCwd: "/home/u/Documents/Code/demo",
    ...p,
  };
}

function gaps(p: Partial<VaultGaps> = {}): VaultGaps {
  return { notes: 10, linked: 9, orphans: 1, ghostTotal: 3, untyped: 0, projectsMissingNote: 1, writeNext: [], orphansByFolder: [], duplicates: [], missingProjects: [], untypedByFolder: [], unanchored: null, unanchoredByFolder: [], ...p };
}

function board(items: LoopsItem[]): LoopsBoard {
  return { generatedAt: iso(NOW), items, badge: 0, whatsupOk: true, whatsupError: null };
}

function inputs(p: Partial<FixInputs> = {}): FixInputs {
  return {
    nowMs: NOW,
    health: [],
    sickness: [],
    gaps: gaps(),
    loops: board([]),
    outcomes: [],
    vaultDir: "/vault",
    alefDir: "/alef",
    cityForCwd: (cwd) => ({ "/vault": "vault-city", "/alef": "alef-city", "/home/u/Documents/Code/demo": "demo" })[cwd] ?? null,
    session: (id) => (id === "11111111-1111-1111-1111-111111111111" ? { title: "Fix the build", cwd: "/home/u/Documents/Code/demo", islandId: "demo" } : null),
    dismissal: () => null,
    launch: () => null,
    sessionForTmux: () => null,
    ...p,
  };
}

describe("buildFixQueue", () => {
  it("merges every source into one list, worst first, each row with its city and a prompt", () => {
    const q = buildFixQueue(
      inputs({
        health: [check({ id: "jev-key", state: "fail", detail: "TYPESAFE_API_KEY not set" }), check({ id: "tmux", state: "warn" }), check({ id: "live-visible", state: "pass" })],
        sickness: [sick(), sick({ id: "leak", kind: "leaked-key", detail: { provider: "OpenRouter", masked: "sk-or-v1-...", hash10: "0123456789" } })],
        gaps: gaps({ missingProjects: ["groot"], writeNext: [{ key: "Weekly review", n: 3 }] }),
        loops: board([loop({ id: "old" }), loop({ id: "fresh", updatedAt: iso(NOW - DAY) }), loop({ id: "waits", lens: "waiting" })]),
        outcomes: [outcome({ sessionId: "11111111-1111-1111-1111-111111111111", outcome: "abandoned", reason: "waited on you: AskUserQuestion" }), outcome({ sessionId: "old-one", outcome: "abandoned", lastActive: iso(NOW - 30 * DAY) })],
      }),
    );
    expect(q.rows.map((r) => r.id)).toEqual([
      "sickness:leak",
      "health:jev-key",
      "sickness:case-hash",
      "health:tmux",
      "abandoned:11111111-1111-1111-1111-111111111111",
      "loop:old",
      "vault-ghost:Weekly review",
      "vault-project:groot",
    ]);
    expect(q.open).toEqual({ health: 2, sickness: 2, "vault-project": 1, "vault-ghost": 1, loop: 1, abandoned: 1 });
    expect(openTotal(q.open)).toBe(8);
    expect(q.pending).toEqual([]);
    const byId = new Map(q.rows.map((r) => [r.id, r]));
    expect(byId.get("health:jev-key")).toMatchObject({ severity: "high", cityId: "alef-city", state: "open", prompt: healthFixPrompt(check({ id: "jev-key", state: "fail", detail: "TYPESAFE_API_KEY not set" })) });
    expect(byId.get("sickness:case-hash")).toMatchObject({ cityId: "demo", cwd: "/home/u/Documents/Code/demo", since: iso(NOW - 2 * DAY) });
    expect(byId.get("vault-project:groot")).toMatchObject({ cityId: "vault-city", severity: "low" });
    expect(byId.get("loop:old")).toMatchObject({ loopId: "old", cityId: "demo", evidence: "demo: open in its tasks/todo.md, not touched in 20 days" });
    expect(byId.get("abandoned:11111111-1111-1111-1111-111111111111")).toMatchObject({ title: "Abandoned: Fix the build", evidence: "waited on you: AskUserQuestion" });
    for (const r of q.rows) expect(isFixId(r.id)).toBe(true);
  });

  it("never puts a leaked key's hash or the case id in the prompt (the doctor invariant)", () => {
    const q = buildFixQueue(inputs({ sickness: [sick({ id: "c0ffee", kind: "leaked-key", detail: { provider: "OpenRouter", masked: "sk-or-v1-...", hash10: "0123456789" } })] }));
    const p = q.rows[0]?.prompt ?? "";
    expect(p).toContain("sk-or-v1-...");
    expect(p).not.toContain("0123456789");
    expect(p).not.toContain("c0ffee");
  });

  it("names a source whose owner hasn't computed once as pending, never as zero rows", () => {
    const q = buildFixQueue(inputs({ health: null, gaps: null, outcomes: null }));
    expect(q.pending).toEqual(["health", "vault-project", "vault-ghost", "abandoned"]);
    expect(openTotal(q.open)).toBe(0);
  });

  it("keeps a set-aside row listed, last and out of the open count; a health row uses the check's own dismissal", () => {
    const snooze: CheckDismissal = { kind: "snooze", at: iso(NOW), until: iso(NOW + 7 * DAY), reason: null };
    const q = buildFixQueue(
      inputs({
        health: [check({ id: "tmux", state: "fail", dismissed: { kind: "wont-fix", at: iso(NOW), until: null, reason: null } })],
        gaps: gaps({ missingProjects: ["a", "b"] }),
        dismissal: (id) => (id === "vault-project:a" ? snooze : null),
      }),
    );
    expect(q.rows.map((r) => [r.id, r.state])).toEqual([
      ["vault-project:b", "open"],
      ["health:tmux", "wont-fix"],
      ["vault-project:a", "snoozed"],
    ]);
    expect(openTotal(q.open)).toBe(1);
  });

  it("closes the loop: a launch's tmux session resolves to its session id, and that session's verdict shows on the row", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    const q = buildFixQueue(
      inputs({
        gaps: gaps({ missingProjects: ["groot"] }),
        outcomes: [outcome({ sessionId: sid, outcome: "shipped", reason: "o/r#3 merged" })],
        launch: (id) => (id === "vault-project:groot" ? { at: iso(NOW - 3600_000), tmuxName: "aw-deadbeef", sessionId: null } : null),
        sessionForTmux: (name) => (name === "aw-deadbeef" ? sid : null),
      }),
    );
    expect(q.rows[0]).toMatchObject({ state: "launched", launch: { tmuxName: "aw-deadbeef", sessionId: sid, outcome: "shipped", outcomeReason: "o/r#3 merged" } });
    expect(q.newlyBound).toEqual([{ id: "vault-project:groot", sessionId: sid }]);
  });

  it("lists at most FIX_SOURCE_CAP rows per source but counts them all", () => {
    const many = Array.from({ length: FIX_SOURCE_CAP + 5 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const q = buildFixQueue(inputs({ gaps: gaps({ missingProjects: many }) }));
    expect(q.rows).toHaveLength(FIX_SOURCE_CAP);
    expect(q.open["vault-project"]).toBe(FIX_SOURCE_CAP + 5);
  });

  it("marks only a scanned todo.md item as tickable", () => {
    const q = buildFixQueue(inputs({ loops: board([loop({ id: "scan" }), loop({ id: "memo", sources: ["whatsup"], openPath: "/home/u/memory/x.md", sourceType: "memory" })]) }));
    expect(new Map(q.rows.map((r) => [r.id, r.loopId]))).toEqual(new Map([["loop:scan", "scan"], ["loop:memo", null]]));
  });
});

describe("fixes store", () => {
  let dir = "";
  afterEach(async () => {
    resetFixesStoresForTests();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("drops unknown ids, bad tmux names and malformed entries on read", () => {
    const f = parseFixesFile(
      JSON.stringify({
        dismissals: { "vault-project:a": { kind: "wont-fix", at: "x", until: null, reason: null }, "nope:a": { kind: "wont-fix", at: "x", until: null, reason: null } },
        launches: { "loop:a": { at: "x", tmuxName: "aw-12ab", sessionId: null }, "loop:b": { at: "x", tmuxName: "rm -rf", sessionId: null } },
      }),
    );
    expect(Object.keys(f.dismissals)).toEqual(["vault-project:a"]);
    expect(Object.keys(f.launches)).toEqual(["loop:a"]);
    expect(parseFixesFile("not json")).toEqual({ dismissals: {}, launches: {} });
  });

  it("persists dismissals and launches, and lets an expired snooze lapse", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-fixes-"));
    const path = join(dir, "fixes.json");
    const store = fixesStoreFor(path);
    await store.setDismissal("loop:a", { kind: "snooze", at: iso(NOW), until: iso(NOW + DAY), reason: null });
    await store.recordLaunch("loop:a", { at: iso(NOW), tmuxName: "aw-12ab", sessionId: null });
    await store.bindSession("loop:a", "33333333-3333-3333-3333-333333333333");
    resetFixesStoresForTests();
    const again = fixesStoreFor(path);
    expect(again.dismissal("loop:a", NOW)?.kind).toBe("snooze");
    expect(again.dismissal("loop:a", NOW + 2 * DAY)).toBeNull();
    expect(again.launch("loop:a")).toEqual({ at: iso(NOW), tmuxName: "aw-12ab", sessionId: "33333333-3333-3333-3333-333333333333" });
    expect(await again.clearDismissal("loop:a")).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ dismissals: {} });
  });
});

describe("fixes routes on a booted server", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    resetFixesStoresForTests();
    if (server) await server.close();
    server = null;
  });

  let dir = "";
  async function boot(): Promise<string> {
    const booted = await bootTestServer({ configOverrides: { features: [createFixesFeature({ now: () => NOW, vaultDir: "/nonexistent-vault" })] } });
    server = booted.server;
    dir = booted.dir;
    return booted.base;
  }

  const post = async (url: string, body: unknown): Promise<{ status: number; body: FixActionResult }> => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as FixActionResult };
  };

  it("serves the queue, refuses a bad id or kind, and sends a Health row to the check's own dismissal", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/fixes`);
    const q = (await res.json()) as FixesResponse;
    expect(res.status).toBe(200);
    expect(q.ok).toBe(true);
    expect(Array.isArray(q.rows)).toBe(true);
    expect((await post(`${base}/api/fixes/${encodeURIComponent("nope:x")}/dismiss`, { kind: "snooze" })).status).toBe(400);
    expect((await post(`${base}/api/fixes/${encodeURIComponent("vault-project:x")}/dismiss`, { kind: "later" })).status).toBe(400);
    expect((await post(`${base}/api/fixes/${encodeURIComponent("health:tmux")}/dismiss`, { kind: "snooze" })).body.error).toMatch(/completeness/);
    const missing = await fetch(`${base}/api/fixes/${encodeURIComponent("vault-project:x")}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as FixRowResponse).ok).toBe(false);
  });

  it("records a dispatched fix with its tmux session, and snoozes / undoes a row", async () => {
    const base = await boot();
    const id = encodeURIComponent("vault-ghost:Weekly / review");
    expect((await post(`${base}/api/fixes/${id}/launched`, { tmuxName: "aw-0badc0de" })).body).toEqual({ ok: true });
    expect((await post(`${base}/api/fixes/${id}/dismiss`, { kind: "wont-fix" })).body).toEqual({ ok: true });
    expect((await post(`${base}/api/fixes/${id}/undismiss`, {})).body).toEqual({ ok: true });
    const stored = parseFixesFile(await readFile(join(dir, "fixes.json"), "utf8"));
    expect(stored.launches["vault-ghost:Weekly / review"]).toMatchObject({ tmuxName: "aw-0badc0de", sessionId: null });
    expect(stored.dismissals).toEqual({});
  });
});
