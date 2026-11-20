// The wake-recall feature through the real pipeline: transcripts on disk → the cold pass on the
// tick (boot-known sessions) and the real indexer's raw lines (collectLines, exactly what the hub
// hands onIndexPass) for sessions first seen after boot → broadcasts, WS entries and the GET.
// The memory dir is a real symlink into a temp vault, as on Alex's Mac.

import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWakeRecallSummary,
  WAKE_RECALL_SUMMARY_KEY,
  type WakeRecallMessage,
  type WakeRecallResponse,
  type WakeRecallSessionResponse,
} from "../../shared/features/wake-recall.js";
import type { ServerMessage } from "../../shared/types.js";
import type { WorldDb } from "../db.js";
import { runIndexPass } from "../indexer.js";
import type { FeatureContext, Route } from "../features/registry.js";
import { countVaultNotes, createWakeRecallFeature } from "../features/wake-recall.js";
import { appendToSessionFile, makeTempDb, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Rig {
  dir: string;
  projects: string;
  home: string;
  db: WorldDb;
  ctx: FeatureContext;
  emitted: WakeRecallMessage[];
  broadcasts: ServerMessage[];
  feature: ReturnType<typeof createWakeRecallFeature>;
}

async function rig(): Promise<Rig> {
  const dir = await makeTempProjectsDir();
  dirs.push(dir);
  const home = join(dir, "home");
  const vault = join(home, "vault");
  const projects = join(dir, "projects");
  await mkdir(join(vault, "60-Meta", "claude-config", "memory"), { recursive: true });
  await mkdir(join(vault, "20-Projects", "alef"), { recursive: true });
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(join(vault, "20-Projects", "alef", "_index.md"), "# alef\n");
  await writeFile(join(vault, "Home.md"), "# home\n");
  await writeFile(join(vault, ".obsidian", "hidden.md"), "not a note\n");
  await writeFile(join(vault, "60-Meta", "claude-config", "memory", "feedback_x.md"), "# memory\n");
  const memoryDir = join(home, ".claude", "projects", "-home", "memory");
  await mkdir(join(memoryDir, ".."), { recursive: true });
  await symlink(join(vault, "60-Meta", "claude-config", "memory"), memoryDir);
  await mkdir(projects, { recursive: true });
  const db = await makeTempDb(dir);
  const emitted: WakeRecallMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const ctx = {
    featureId: "wake-recall",
    db,
    config: { projectsDir: projects },
    emit: (p: unknown) => void emitted.push(p as WakeRecallMessage),
    broadcast: (m: ServerMessage) => void broadcasts.push(m),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as FeatureContext;
  const feature = createWakeRecallFeature({ home, vaultRoot: vault, memoryDir });
  return { dir, projects, home, db, ctx, emitted, broadcasts, feature };
}

const iso = (dMs: number): string => new Date(Date.now() + dMs).toISOString();

/** The real SessionStart memory-recall attachment (content: the "- `path` — snippet" list). */
function wakeAttachment(ts: string, paths: string[], entrypoint = "claude-vscode", hookName = "SessionStart:startup"): string {
  const content = ["## Memory recall (auto-pulled at session start)", "", "_From your second-brain vault. Query: 'main x'_", "", ...paths.map((p) => `- \`${p}\` — NOTE-BODY-SNIPPET`)].join("\n");
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    attachment: { type: "hook_success", hookName, toolUseID: "t1", hookEvent: "SessionStart", content, stdout: `${content}\n`, stderr: "", exitCode: 0, command: "/h/.claude/hooks/memory-recall.py", durationMs: 400 },
    type: "attachment",
    uuid: "u1",
    timestamp: ts,
    entrypoint,
    cwd: "/tmp/agent-world",
  });
}

function promptRecall(ts: string): string {
  const content = "## Memory Recall\n\n- **[vault]** `20-Projects/alef/_index.md` — 2026-09-24 — NOTE-BODY-SNIPPET";
  return JSON.stringify({
    type: "attachment",
    timestamp: ts,
    attachment: { type: "hook_success", hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit", content, command: "$HOME/.claude/hooks/prompt-memory-recall.py", exitCode: 0 },
  });
}

function user(ts: string, entrypoint = "claude-vscode"): string {
  return JSON.stringify({ type: "user", timestamp: ts, cwd: "/tmp/agent-world", entrypoint, message: { role: "user", content: [{ type: "text", text: "go" }] } });
}

const NOTES = ["~/vault/20-Projects/alef/_index.md", "~/.claude/projects/-home/memory/feedback_x.md"];
const S = {
  a: "aaaaaaaa-0000-4000-8000-000000000001",
  b: "bbbbbbbb-0000-4000-8000-000000000002",
  c: "cccccccc-0000-4000-8000-000000000003",
  d: "dddddddd-0000-4000-8000-000000000004",
  e: "eeeeeeee-0000-4000-8000-000000000005",
  g: "99999999-0000-4000-8000-000000000006",
};

async function get<T>(r: Rig, path: string, params: Record<string, string> = {}): Promise<T> {
  const route = r.feature.routes!.find((x: Route) => x.path === path)!;
  let body = "";
  const res = { writeHead: () => res, end: (d: string) => void (body = d) };
  await route.handler({ url: path } as never, res as never, r.ctx, params);
  return JSON.parse(body) as T;
}

async function indexPass(r: Rig): Promise<void> {
  const stats = await runIndexPass(r.db, { projectsDir: r.projects, collectLines: true, homeDir: r.home });
  await r.feature.onIndexPass!(r.ctx, stats.linesBySession);
}

describe("wake-recall feature", () => {
  it("cold pass: every boot-known transcript's head, vault-relative paths only, no replay storm", async () => {
    const r = await rig();
    await writeSessionFile(r.projects, "-a", S.a, [wakeAttachment(iso(-3_600_000), NOTES), user(iso(-3_599_000))].join("\n") + "\n");
    await writeSessionFile(r.projects, "-b", S.b, [user(iso(-3_000_000), "sdk-cli")].join("\n") + "\n");
    await r.feature.onTick!(r.ctx);

    const body = await get<WakeRecallResponse>(r, "/api/wake-recall");
    expect(body.ready).toBe(true);
    expect(body.totals).toMatchObject({ sessions: 2, fed: 1, nothing: 1, headlessMisses: 1, reasons: { "timed-out": 0, failed: 0, "no-trace": 1 }, notes: 2 });
    expect(body.vaultNotes).toBe(3); // Home.md, _index.md, the memory file; .obsidian skipped
    const a = body.sessions.find((s) => s.sessionId === S.a)!;
    expect(a.notes).toEqual(["20-Projects/alef/_index.md", "60-Meta/claude-config/memory/feedback_x.md"]);
    expect(a.newSinceBoot).toBe(false);
    expect(JSON.stringify(body)).not.toContain("NOTE-BODY-SNIPPET");
    expect(r.emitted).toHaveLength(1); // the "cold pass done" summary, no entries
    expect(r.emitted[0]!.entries).toEqual([]);

    // A fresh db replays every history line through the indexer: none of it is news.
    await indexPass(r);
    expect(r.broadcasts).toEqual([]);
    const one = await get<WakeRecallSessionResponse>(r, "/api/wake-recall/session/:sessionId", { sessionId: S.a });
    expect(one.entry).toMatchObject({ state: "fed", count: 2 });
    expect(isWakeRecallSummary(r.feature.snapshotExtras!(r.ctx)[WAKE_RECALL_SUMMARY_KEY])).toBe(true);
  });

  it("a NEW session that got notes broadcasts ONE brain activity at its wake time; nothing else does", async () => {
    const r = await rig();
    await writeSessionFile(r.projects, "-a", S.a, [wakeAttachment(iso(-3_600_000), NOTES), user(iso(-3_599_000))].join("\n") + "\n");
    await r.feature.onTick!(r.ctx); // boot listing: only A is history
    await indexPass(r);
    expect(r.broadcasts).toEqual([]);

    const wokeAt = iso(-2_000);
    const fileC = await writeSessionFile(r.projects, "-c", S.c, [wakeAttachment(wokeAt, NOTES), user(iso(-1_000))].join("\n") + "\n");
    await writeSessionFile(r.projects, "-d", S.d, [user(iso(-1_000), "sdk-cli")].join("\n") + "\n"); // woke with nothing
    await writeSessionFile(r.projects, "-e", S.e, [wakeAttachment(iso(-2 * 86_400_000), NOTES), user(iso(-2 * 86_400_000 + 1000))].join("\n") + "\n"); // an old transcript copied in
    await writeSessionFile(r.projects, "-x", "not-a-session", [wakeAttachment(iso(-2_000), NOTES), user(iso(-1_000))].join("\n") + "\n"); // not <uuid>.jsonl
    await indexPass(r);

    expect(r.broadcasts).toEqual([
      {
        type: "activity",
        activities: [{ id: `wake:${S.c}`, agentId: S.c, at: wokeAt, stage: "brain", toolName: "memory-recall", targetObjectId: null, summary: "woke with 2 vault notes" }],
      },
    ]);
    const pushed = r.emitted.at(-1)!;
    expect(pushed.kind).toBe("entries");
    expect(pushed.entries.map((e) => [e.sessionId, e.state, e.newSinceBoot]).sort()).toEqual([
      [S.c, "fed", true],
      [S.d, "nothing", true],
      [S.e, "fed", true],
    ]);

    // More lines for C: a prompt-time recall is counted, but its wake is never announced twice.
    await appendToSessionFile(fileC, [promptRecall(iso(0)), user(iso(0))].join("\n") + "\n");
    await indexPass(r);
    expect(r.broadcasts).toHaveLength(1);
    const c = await get<WakeRecallSessionResponse>(r, "/api/wake-recall/session/:sessionId", { sessionId: S.c });
    expect(c.entry).toMatchObject({ state: "fed", count: 2, promptRecalls: 1 });

    const all = await get<WakeRecallResponse>(r, "/api/wake-recall");
    expect(all.totals).toMatchObject({ sessions: 4, fed: 3, nothing: 1 });
  });

  it("bounded: a first line bigger than the head is never read into, cold or live", async () => {
    const r = await rig();
    const giant = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: iso(-10_000), content: "x".repeat(300 * 1024) });
    await writeSessionFile(r.projects, "-g", S.g, [giant, wakeAttachment(iso(-9_000), NOTES), user(iso(-8_000))].join("\n") + "\n");
    await r.feature.onTick!(r.ctx);
    expect((await get<WakeRecallResponse>(r, "/api/wake-recall")).totals).toMatchObject({ sessions: 1, unread: 1, fed: 0 });

    await writeSessionFile(r.projects, "-c", S.c, [giant, wakeAttachment(iso(-1_000), NOTES), user(iso(0))].join("\n") + "\n");
    await indexPass(r);
    expect(r.broadcasts).toEqual([]);
    const c = await get<WakeRecallSessionResponse>(r, "/api/wake-recall/session/:sessionId", { sessionId: S.c });
    expect(c.entry?.state).toBe("unread");
  });

  it("a boot-known head that grows is re-read (no broadcast); a pruned transcript leaves", async () => {
    const r = await rig();
    const fileA = await writeSessionFile(r.projects, "-a", S.a, [wakeAttachment(iso(-60_000), NOTES), user(iso(-59_000))].join("\n") + "\n");
    await writeSessionFile(r.projects, "-b", S.b, [user(iso(-50_000))].join("\n") + "\n");
    await r.feature.onTick!(r.ctx);
    await appendToSessionFile(fileA, [promptRecall(iso(-1_000)), user(iso(0))].join("\n") + "\n");
    await r.feature.onTick!(r.ctx);
    expect(r.broadcasts).toEqual([]);
    const pushed = r.emitted.at(-1)!;
    expect(pushed.entries).toHaveLength(1);
    expect(pushed.entries[0]).toMatchObject({ sessionId: S.a, promptRecalls: 1, newSinceBoot: false });

    await unlink(fileA);
    await r.feature.onTick!(r.ctx);
    const body = await get<WakeRecallResponse>(r, "/api/wake-recall");
    expect(body.sessions.map((s) => s.sessionId)).toEqual([S.b]);
    expect(r.emitted.at(-1)!.summary.totals.sessions).toBe(1);
  });

  it("the cold pass spreads over ticks under its byte budget and is ready only when done", async () => {
    const r = await rig();
    const f = createWakeRecallFeature({ home: r.home, vaultRoot: join(r.home, "vault"), budgetBytes: 10 });
    await writeSessionFile(r.projects, "-a", S.a, [wakeAttachment(iso(-60_000), NOTES), user(iso(-59_000))].join("\n") + "\n");
    await writeSessionFile(r.projects, "-b", S.b, [user(iso(-50_000))].join("\n") + "\n");
    await f.onTick!(r.ctx);
    expect((f.snapshotExtras!(r.ctx)[WAKE_RECALL_SUMMARY_KEY] as { ready: boolean }).ready).toBe(false);
    await f.onTick!(r.ctx);
    const s = f.snapshotExtras!(r.ctx)[WAKE_RECALL_SUMMARY_KEY] as { ready: boolean; totals: { sessions: number } };
    expect(s.ready).toBe(true);
    expect(s.totals.sessions).toBe(2);
  });

  it("countVaultNotes: an unreadable vault is no data, not 0", async () => {
    expect(await countVaultNotes("/nonexistent/vault")).toBeNull();
  });
});
