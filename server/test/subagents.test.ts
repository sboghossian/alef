import { appendFile, mkdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSubagentList, spawnedEdges, type SubagentsResponse } from "../../shared/features/subagents.js";
import { subagentCandidates } from "../../client/src/features/workspace-lib.js";
import { computeParents, newSubagentState, parentReportsOnLine, resolveOutcome, STALL_MS } from "../features/subagents/fold.js";
import { subagentsFeature } from "../features/subagents/index.js";
import { buildRecords, runSubagentPass, statsFor } from "../features/subagents/pass.js";
import { listSubagentFiles, streamLines } from "../features/subagents/scan.js";
import { SubagentStore } from "../features/subagents/store.js";
import type { SubagentState } from "../features/subagents/fold.js";
import { bootTestServer, makeTempProjectsDir } from "./helpers.js";

const SESSION = "11111111-2222-4333-8444-555555555555";
const PROJECT = "-tmp-proj";
const CWD = "/tmp/proj";
const A1 = "a0000000000000001"; // direct child, finished (task-notification)
const A2 = "a0000000000000002"; // workflow agent
const A3 = "a0000000000000003"; // nested: spawned by A1
const A4 = "a0000000000000004"; // async launched, never reported, ended mid-tool
/** Past STALL_MS: a transcript silent this long mid-turn counts as cut off. */
const STALLED_MS = STALL_MS + 10 * 60_000;

function line(o: Record<string, unknown>): string {
  return `${JSON.stringify(o)}\n`;
}

function userPrompt(agentId: string, text: string, ts: string): string {
  return line({ parentUuid: null, isSidechain: true, agentId, type: "user", timestamp: ts, cwd: CWD, sessionId: SESSION, message: { role: "user", content: text } });
}

/** An assistant line. stop_reason as Claude Code writes it on a finished block: "tool_use" on a
 *  tool call, "end_turn" on a final text (see subagents-status.test.ts for the null case). */
function assistant(agentId: string, ts: string, msgId: string, content: unknown[], tokens = 10): string {
  const stop = content.some((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use") ? "tool_use" : "end_turn";
  return line({
    isSidechain: true,
    agentId,
    type: "assistant",
    timestamp: ts,
    cwd: CWD,
    sessionId: SESSION,
    message: { id: msgId, role: "assistant", model: "claude-sonnet-5", content, stop_reason: stop, usage: { input_tokens: tokens, output_tokens: 1, cache_creation_input_tokens: 0 } },
  });
}

function toolResultLine(agentId: string, ts: string): string {
  // A big user line that mentions "type":"assistant" only inside an escaped string.
  return line({ isSidechain: true, agentId, type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", content: '{"type":"assistant"} lots of output' }] } });
}

async function fixtureTree(root: string): Promise<string> {
  const projects = join(root, "projects");
  const sessDir = join(projects, PROJECT, SESSION, "subagents");
  const wfDir = join(sessDir, "workflows", "wf_abc-123");
  await mkdir(wfDir, { recursive: true });
  await mkdir(join(projects, PROJECT, "not-a-session", "subagents"), { recursive: true });
  await writeFile(join(projects, PROJECT, "not-a-session", "subagents", `agent-${A1}.jsonl`), userPrompt(A1, "ignored", "2026-09-25T01:00:00Z"));

  await writeFile(join(sessDir, `agent-${A1}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: "Build the thing sk-ABCDEFGHIJKLMNOPQRSTUV", toolUseId: "toolu_parent_1" }));
  await writeFile(
    join(sessDir, `agent-${A1}.jsonl`),
    userPrompt(A1, "Build the thing", "2026-09-25T01:00:00Z") +
      assistant(A1, "2026-09-25T01:00:01Z", "m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/proj/a.ts" } }], 100) +
      // same message id streamed twice: usage counted once
      assistant(A1, "2026-09-25T01:00:02Z", "m1", [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.ts" } }], 100) +
      toolResultLine(A1, "2026-09-25T01:00:03Z") +
      assistant(A1, "2026-09-25T01:00:04Z", "m2", [{ type: "tool_use", id: "toolu_nested_1", name: "Agent", input: { description: "nested", prompt: "x" } }], 5) +
      assistant(A1, "2026-09-25T01:00:05Z", "m3", [{ type: "text", text: "All done." }], 5),
  );
  await writeFile(join(sessDir, `agent-${A3}.meta.json`), JSON.stringify({ agentType: "Explore", description: "nested helper", toolUseId: "toolu_nested_1" }));
  await writeFile(join(sessDir, `agent-${A3}.jsonl`), userPrompt(A3, "look around", "2026-09-25T01:00:04Z") + assistant(A3, "2026-09-25T01:00:06Z", "n1", [{ type: "text", text: "found it" }], 7));
  await writeFile(join(sessDir, `agent-${A4}.jsonl`), userPrompt(A4, "background job from the prompt", "2026-09-25T01:01:00Z") + assistant(A4, "2026-09-25T01:01:01Z", "b1", [{ type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }], 3));

  await writeFile(join(wfDir, `agent-${A2}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: "reasons:0", model: "sonnet" }));
  await writeFile(join(wfDir, `agent-${A2}.jsonl`), userPrompt(A2, "wf", "2026-09-25T01:02:00Z") + assistant(A2, "2026-09-25T01:02:01Z", "w1", [{ type: "text", text: "ok" }], 2));
  await writeFile(join(wfDir, "journal.jsonl"), line({ any: 1 }));

  // Parent transcript: sync Agent result for A1 (async), later a task-notification; A4 async only.
  const parent =
    line({ type: "user", timestamp: "2026-09-25T01:00:00Z", toolUseResult: { isAsync: true, status: "async_launched", agentId: A1, description: "Build the thing", resolvedModel: "claude-sonnet-5", prompt: "…" }, message: { role: "user", content: [] } }) +
    line({ type: "user", timestamp: "2026-09-25T01:01:00Z", toolUseResult: { isAsync: true, status: "async_launched", agentId: A4, description: "bg", resolvedModel: "claude-haiku-4-5", prompt: "…" }, message: { role: "user", content: [] } }) +
    line({ type: "user", timestamp: "2026-09-25T01:05:00Z", message: { role: "user", content: `<task-notification>\n<task-id>${A1}</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>` } });
  await writeFile(join(projects, PROJECT, `${SESSION}.jsonl`), parent);
  return projects;
}

async function age(path: string, msAgo: number): Promise<void> {
  const t = new Date(Date.now() - msAgo);
  await utimes(path, t, t);
}

describe("subagent discovery", () => {
  it("finds flat and workflows/ transcripts, skipping journal.jsonl and non-session dirs", async () => {
    const projects = await fixtureTree(await makeTempProjectsDir());
    const refs = await listSubagentFiles(projects);
    const ids = refs.map((r) => r.agentId).sort();
    expect(ids).toEqual([A1, A2, A3, A4].sort());
    const wf = refs.find((r) => r.agentId === A2);
    expect(wf?.workflowId).toBe("wf_abc-123");
    expect(wf?.parentSessionId).toBe(SESSION);
    expect(refs.find((r) => r.agentId === A1)?.workflowId).toBeNull();
  });

  it("folds tokens (deduped per message id), tools, files, links parents and nesting", async () => {
    const root = await makeTempProjectsDir();
    const projects = await fixtureTree(root);
    const sub = join(projects, PROJECT, SESSION, "subagents");
    for (const id of [A1, A3]) await age(join(sub, `agent-${id}.jsonl`), 10 * 60_000);
    await age(join(sub, `agent-${A4}.jsonl`), STALLED_MS);
    await age(join(sub, "workflows", "wf_abc-123", `agent-${A2}.jsonl`), 10 * 60_000);
    const store = new SubagentStore(join(root, "sa.db"));
    await runSubagentPass(store, projects, { collectActivity: false });
    const recs = buildRecords(store, Date.now());
    const byId = new Map(recs.map((r) => [r.id, r]));

    const a1 = byId.get(A1);
    expect(a1?.tokens).toBe(101 + 6 + 6); // m1 once, then m2, m3
    expect(a1?.toolCounts).toEqual({ Read: 1, Edit: 1, Agent: 1 });
    expect(a1?.files[0]).toEqual({ path: "/tmp/proj/a.ts", count: 2 }); // relative path resolved against the line cwd
    expect(a1?.status).toBe("done"); // task-notification said completed
    expect(a1?.model).toBe("claude-sonnet-5");
    expect(a1?.description).toBe("Build the thing [redacted]");
    expect(a1?.depth).toBe(1);

    expect(byId.get(A3)?.parentAgentId).toBe(A1);
    expect(byId.get(A3)?.depth).toBe(2);
    expect(byId.get(A2)?.workflowId).toBe("wf_abc-123");
    expect(byId.get(A2)?.description).toBe("reasons:0");
    // no meta → parent description; async_launched + ended mid-tool, silent past STALL_MS → async_launched
    expect(byId.get(A4)?.description).toBe("bg");
    expect(byId.get(A4)?.status).toBe("async_launched");
    expect(byId.get(A4)?.model).toBe("claude-sonnet-5"); // what its own turns reported beats resolvedModel

    const stats = statsFor(recs, Date.now(), 1);
    expect(stats).toMatchObject({ total: 4, parents: 1, deepest: 2, live: 0 });
    const edges = spawnedEdges(recs);
    expect(edges.find((e) => e.to === `subagent:${A3}`)?.from).toBe(`subagent:${A1}`);
    expect(edges.find((e) => e.to === `subagent:${A1}`)?.from).toBe(SESSION);
    store.close();
  });

  it("reads only new complete lines on the next pass (byte offsets) and flags a writing agent as running", async () => {
    const root = await makeTempProjectsDir();
    const projects = await fixtureTree(root);
    const store = new SubagentStore(join(root, "sa.db"));
    const first = await runSubagentPass(store, projects, { collectActivity: false });
    expect(first.filesRead).toBe(4);
    expect(first.activities).toEqual([]);
    const second = await runSubagentPass(store, projects, { collectActivity: true });
    expect(second.filesRead).toBe(0);
    expect(second.parentsRead).toBe(0);

    const path = join(projects, PROJECT, SESSION, "subagents", `agent-${A4}.jsonl`);
    const next = assistant(A4, "2026-09-25T01:09:00Z", "b2", [{ type: "tool_use", id: "c", name: "Grep", input: { path: "/tmp/proj/src" } }], 4);
    await appendFile(path, next + next.slice(0, 20)); // one full line + a partial one
    const third = await runSubagentPass(store, projects, { collectActivity: true });
    expect(third.filesRead).toBe(1);
    expect(third.activities.map((a) => [a.subagentId, a.stage, a.toolName])).toEqual([[A4, "tool", "Grep"]]);
    expect(store.states.get(A4)?.tokens).toBe(4 + 5);
    const off = store.offset(path);
    expect(off && off.offset < off.size).toBe(true); // the partial line is left for later
    expect(buildRecords(store, Date.now()).find((r) => r.id === A4)?.status).toBe("running");

    // Reopening the same file keeps state + offsets.
    store.close();
    const reopened = new SubagentStore(join(root, "sa.db"));
    expect(reopened.states.get(A4)?.tokens).toBe(9);
    const fourth = await runSubagentPass(reopened, projects, { collectActivity: true });
    expect(fourth.filesRead).toBe(0);
    reopened.close();
  });
});

// A workflow agent's last three lines, in the shape Claude Code 2.1.280 writes them (trimmed from
// a real transcript: build:global-workspace, agent a60a362a8e61ce6b2): its StructuredOutput call,
// the structured_output attachment, and the accepted tool_result, flagged toolEndsTurn.
function workflowTail(agentId: string, ts: string, accepted: boolean): string {
  const toolUseId = "toolu_01Nq1FkxXfXqiufZUha1FjAu";
  const out = { pr_url: "https://github.com/sboghossian/agent-world/pull/26", summary: 'I\'ve opened PR #26 (not merged). "type":"assistant" in text stays escaped.' };
  const call = line({
    parentUuid: "eebed342-ebb5-4bdd-948b-6219015c7065",
    isSidechain: true,
    agentId,
    message: {
      model: "claude-opus-5-5",
      id: "msg_011CfUK6csUiaXLEZFA29puj",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "StructuredOutput", input: out, caller: { type: "direct" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 2, cache_creation_input_tokens: 2487, cache_read_input_tokens: 344154, output_tokens: 3461 },
    },
    type: "assistant",
    uuid: "8a1d9724-d6d5-4d3d-947d-81dd57eeba94",
    timestamp: ts,
    cwd: CWD,
    sessionId: SESSION,
    version: "2.1.280",
  });
  if (!accepted) {
    // A rejected call is an ordinary error result (no toolEndsTurn): the agent is expected to retry.
    return (
      call +
      line({ isSidechain: true, agentId, type: "user", message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: "Output does not match the schema", is_error: true }] }, timestamp: ts, cwd: CWD, sessionId: SESSION })
    );
  }
  return (
    call +
    line({ parentUuid: "8a1d9724-d6d5-4d3d-947d-81dd57eeba94", isSidechain: true, agentId, attachment: { type: "structured_output", data: out, toolUseID: toolUseId }, type: "attachment", timestamp: ts, cwd: CWD, sessionId: SESSION }) +
    line({
      parentUuid: "8a1d9724-d6d5-4d3d-947d-81dd57eeba94",
      isSidechain: true,
      promptId: "3c923ffa-2672-46c3-ab95-f62ae729593b",
      agentId,
      type: "user",
      message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: "Structured output provided successfully" }] },
      uuid: "fee77307-f612-4bde-bb05-b5c9866d9c50",
      timestamp: ts,
      toolEndsTurn: true,
      sourceToolAssistantUUID: "8a1d9724-d6d5-4d3d-947d-81dd57eeba94",
      cwd: CWD,
      sessionId: SESSION,
      version: "2.1.280",
    })
  );
}

describe("workflow agents: how they finish", () => {
  const OK = "a60a362a8e61ce6b2";
  const REJECTED = "a0000000000000011";

  async function workflowTree(root: string): Promise<{ projects: string; wfDir: string }> {
    const projects = join(root, "projects");
    const wfDir = join(projects, PROJECT, SESSION, "subagents", "workflows", "wf_25b2560f-17c");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(projects, PROJECT, `${SESSION}.jsonl`), userPrompt(SESSION, "run the workflow", "2026-09-27T16:40:00Z")); // the parent says nothing about workflow agents
    for (const [id, desc, accepted] of [
      [OK, "build:global-workspace", true],
      [REJECTED, "build:rejected-output", false],
    ] as const) {
      await writeFile(join(wfDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: desc }));
      await writeFile(
        join(wfDir, `agent-${id}.jsonl`),
        userPrompt(id, "Fix the findings", "2026-09-27T16:41:00Z") +
          assistant(id, "2026-09-27T16:42:00Z", `${id}-m1`, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create" } }], 50) +
          toolResultLine(id, "2026-09-27T16:42:10Z") +
          workflowTail(id, "2026-09-27T17:09:16.536Z", accepted),
      );
      await age(join(wfDir, `agent-${id}.jsonl`), STALLED_MS);
    }
    return { projects, wfDir };
  }

  it("an accepted StructuredOutput (a tool result that ends the turn) is done, not failed; a rejected one never answered is cut off", async () => {
    const root = await makeTempProjectsDir();
    const { projects } = await workflowTree(root);
    const store = new SubagentStore(join(root, "sa.db"));
    await runSubagentPass(store, projects, { collectActivity: false });
    const recs = buildRecords(store, Date.now());
    expect(recs.find((r) => r.id === OK)?.status).toBe("done");
    expect(recs.find((r) => r.id === REJECTED)).toMatchObject({ status: "failed", reason: "cut off: no reply after a tool result" });
    expect(recs.find((r) => r.id === OK)?.reason).toBeNull();
    expect(store.states.get(OK)?.toolCounts).toEqual({ Bash: 1, StructuredOutput: 1 });

    // The Town square's adapter, on the real records: a hand-back that stays failed is still a
    // failure; a "done" hand-back from a workflow's own subagent (agentType "workflow-subagent",
    // set by workflowTree() above) is demoted to info — it's that workflow's plumbing, not town
    // news (feat/town-square-truth).
    const lookup = (id: string): { islandId: string; name: string } | undefined => (id === SESSION ? { islandId: "agent-world", name: "orchestrator" } : undefined);
    const byId = new Map(subagentCandidates(recs, lookup).map((c) => [c.id, c] as const));
    expect(byId.get(`sub:${OK}:done`)).toMatchObject({ urgency: "info", origin: "workflow", text: "handed back: build:global-workspace" });
    expect(byId.get(`sub:${REJECTED}:failed`)?.urgency).toBe("failure");
    store.close();
  });

  it("a state folded under the old rules is re-read once, so records already stored as failed are corrected", async () => {
    const root = await makeTempProjectsDir();
    const { projects } = await workflowTree(root);
    const dbPath = join(root, "sa.db");
    const store = new SubagentStore(dbPath);
    await runSubagentPass(store, projects, { collectActivity: false });
    // What the previous release stored for it: ended on a tool call, no fold version.
    const old = { ...structuredClone(store.states.get(OK)), lastKind: "assistant_tool" };
    delete (old as { foldVersion?: number }).foldVersion;
    store.commit({ offsets: new Map(), states: [old as SubagentState], reports: [], spawns: [] });
    store.close();

    const reopened = new SubagentStore(dbPath);
    expect(buildRecords(reopened, Date.now()).find((r) => r.id === OK)?.status).toBe("failed");
    const pass = await runSubagentPass(reopened, projects, { collectActivity: false });
    expect(pass.filesRead).toBe(1); // only the stale state's file, though no file changed
    expect(buildRecords(reopened, Date.now()).find((r) => r.id === OK)?.status).toBe("done");
    expect((await runSubagentPass(reopened, projects, { collectActivity: false })).filesRead).toBe(0); // once
    reopened.close();
  });
});

describe("streamLines", () => {
  it("hands over complete lines across chunk boundaries and returns the last complete offset", async () => {
    const dir = await makeTempProjectsDir();
    const p = join(dir, "f.jsonl");
    const big = "x".repeat(3 * (1 << 20)); // spans several 1 MB chunks
    await writeFile(p, `a\n${big}\nb\npartial`);
    const lines: number[] = [];
    const end = await streamLines(p, 0, (l) => lines.push(l.length));
    expect(lines).toEqual([1, big.length, 1]);
    expect(end).toBe(2 + big.length + 1 + 2);
  });
});

describe("status + parent helpers", () => {
  it("resolveOutcome: writing wins, then the parent's report, then how the transcript ends", () => {
    const quiet = 10 * 60_000;
    const done = { agentId: "a", status: "completed", model: null, description: null };
    const killed = { agentId: "a", status: "killed", model: null, description: null, summary: 'Agent "x" was stopped by Claude' };
    const bad = { agentId: "a", status: "failed", model: null, description: null, summary: 'Agent "x" failed: Agent stalled: no progress for 600s (stream watchdog did not recover)' };
    const bg = { agentId: "a", status: "async_launched", model: null, description: null };
    expect(resolveOutcome(60_000, done, "assistant_text").status).toBe("running");
    expect(resolveOutcome(quiet, done, "assistant_tool").status).toBe("done");
    expect(resolveOutcome(quiet, killed, "assistant_tool")).toEqual({ status: "stopped", reason: "stopped by its parent session" });
    expect(resolveOutcome(quiet, bad, "assistant_tool")).toEqual({ status: "failed", reason: "Agent stalled: no progress for 600s (stream watchdog did not recover)" });
    // A clean ending is never "failed" (nor "stopped"), even when a stale parent report says so.
    expect(resolveOutcome(quiet, bad, "assistant_text")).toEqual({ status: "done", reason: null });
    expect(resolveOutcome(quiet, bad, "tool_end")).toEqual({ status: "done", reason: null });
    expect(resolveOutcome(quiet, { ...killed, status: "stopped" }, "assistant_text")).toEqual({ status: "done", reason: null });
    expect(resolveOutcome(quiet, undefined, "assistant_text").status).toBe("done");
    expect(resolveOutcome(quiet, undefined, "tool_end").status).toBe("done"); // a workflow agent's accepted StructuredOutput
    // Mid-turn: running until STALL_MS, then cut off (or never heard from, when launched in the background).
    expect(resolveOutcome(quiet, bg, "assistant_tool").status).toBe("running");
    expect(resolveOutcome(STALLED_MS, bg, "assistant_tool").status).toBe("async_launched");
    expect(resolveOutcome(quiet, undefined, "assistant_tool").status).toBe("running");
    expect(resolveOutcome(STALLED_MS, undefined, "assistant_tool")).toEqual({ status: "failed", reason: "cut off: a tool call never returned" });
    // A pre-FOLD_VERSION-3 state whose transcript is gone keeps resolving as before.
    expect(resolveOutcome(STALLED_MS, undefined, null)).toEqual({ status: "failed", reason: "cut off: its prompt was never answered" });
  });

  it("parentReportsOnLine ignores notifications quoted inside assistant turns", () => {
    const quoted = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "<task-notification><task-id>a0000000000000009</task-id><status>failed</status></task-notification>" }] } });
    expect(parentReportsOnLine(quoted)).toEqual([]);
  });

  it("computeParents survives a spawn cycle", () => {
    const a = { ...newSubagentState("x", "s", null), meta: { agentType: null, description: null, toolUseId: "t-y", model: null } };
    const b = { ...newSubagentState("y", "s", null), meta: { agentType: null, description: null, toolUseId: "t-x", model: null } };
    const res = computeParents([a, b], new Map([["t-y", "y"], ["t-x", "x"]]));
    expect(res.get("x")?.depth).toBeLessThan(40);
  });
});

describe("GET /api/subagents", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()?.close();
  });

  it("returns a session's children after the background cold pass", async () => {
    const root = await makeTempProjectsDir();
    const projects = await fixtureTree(root);
    const { base, server } = await bootTestServer({ configOverrides: { projectsDir: projects, dbPath: join(root, "world.db"), features: [subagentsFeature] } });
    servers.push(server);
    const res = await fetch(`${base}/api/subagents?parent=${SESSION}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubagentsResponse;
    expect(parseSubagentList(body.subagents).map((r) => r.id).sort()).toEqual([A1, A2, A3, A4].sort());
    expect(body.stats.total).toBe(4);
    expect(body.stats.coldPassMs).not.toBeNull();
    const none = (await (await fetch(`${base}/api/subagents?parent=nope`)).json()) as SubagentsResponse;
    expect(none.subagents).toEqual([]);
  });
});
