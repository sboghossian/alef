// Truthful subagent status and session run endings (server/features/subagents/fold.ts,
// endings.ts). Every line below is in the exact shape Claude Code wrote it: key order and fields
// sampled from real transcripts on 2026-09-28 (2.1.178–2.1.280), with ids and text replaced.

import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SubagentRecord, SubagentStats } from "../../shared/features/subagents.js";
import { RunEndings, readTailEnding } from "../features/subagents/endings.js";
import {
  PROMPT_STALL_MS,
  STALL_MS,
  endingOutcome,
  foldSubagentLine,
  interruptCause,
  lineKind,
  newSubagentState,
  parentReportsOnLine,
  parentStopOnLine,
  type FoldResult,
} from "../features/subagents/fold.js";
import { upsertMessages } from "../features/subagents/index.js";
import { PARENT_FOLD_VERSION, buildRecords, runSubagentPass } from "../features/subagents/pass.js";
import { SubagentStore } from "../features/subagents/store.js";
import { makeTempProjectsDir } from "./helpers.js";

const SESSION = "145f1811-122e-40c3-9e23-ab5cb887123f";
const PROJECT = "-Users-s-Documents-Code-yalla-brief";
const CWD = "/Users/s/Documents/Code/yalla-brief";
const MIN = 60_000;
const STALLED = STALL_MS + 10 * MIN;

const j = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;
const usage = { input_tokens: 3, cache_creation_input_tokens: 6558, cache_read_input_tokens: 23860, cache_creation: { ephemeral_5m_input_tokens: 6558, ephemeral_1h_input_tokens: 0 }, output_tokens: 3, service_tier: "standard", inference_geo: "not_available" };
const tail = (_agentId: string | null, ts: string, entrypoint = "sdk-cli"): Record<string, unknown> => ({ timestamp: ts, userType: "external", entrypoint, cwd: CWD, sessionId: SESSION, version: "2.1.178", gitBranch: "main" });

function prompt(agentId: string | null, ts: string, text: string): string {
  return j({ parentUuid: null, isSidechain: agentId !== null, ...(agentId ? { agentId } : {}), type: "user", message: { role: "user", content: text }, uuid: `u-${ts}`, ...tail(agentId, ts) });
}

/** A text block: stop_reason null while the turn may go on, "end_turn" on the final one. */
function text(agentId: string | null, ts: string, body: string, stop: "end_turn" | null): string {
  return j({
    parentUuid: "3d968d64-3f5d-40c7-b33a-da445343f0cf",
    isSidechain: agentId !== null,
    ...(agentId ? { agentId } : {}),
    message: { model: "claude-sonnet-4-6", id: `msg_${ts}`, type: "message", role: "assistant", content: [{ type: "text", text: body }], container: null, stop_reason: stop, stop_sequence: null, stop_details: null, usage, diagnostics: null, context_management: null },
    requestId: "req_011Cf4epv4sMK8nPDbkQSaFV",
    type: "assistant",
    uuid: `a-${ts}`,
    ...tail(agentId, ts),
  });
}

function toolUse(agentId: string | null, ts: string): string {
  return j({
    parentUuid: "3d968d64-3f5d-40c7-b33a-da445343f0cf",
    isSidechain: agentId !== null,
    ...(agentId ? { agentId } : {}),
    message: { model: "claude-sonnet-4-6", id: `msg_${ts}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_01DqNpnB3ZTisap6v3Qwx8A8", name: "Bash", input: { command: "npm test" } }], container: null, stop_reason: "tool_use", stop_sequence: null, stop_details: null, usage },
    type: "assistant",
    uuid: `a-${ts}`,
    ...tail(agentId, ts),
  });
}

/** A tool result. `pad` makes it as big as the real ones (most of a transcript's bytes). */
function toolResult(agentId: string | null, ts: string, pad = 0): string {
  const out = `{"type":"assistant"} is only text here ${"x".repeat(pad)}`;
  return j({
    parentUuid: "af41e3c0-277b-43e7-b1a7-0d141d2913a8",
    isSidechain: agentId !== null,
    promptId: "aabbc266-7303-4716-8a02-2e34885eb25e",
    ...(agentId ? { agentId } : {}),
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01DqNpnB3ZTisap6v3Qwx8A8", content: out }] },
    uuid: `u-${ts}`,
    sourceToolAssistantUUID: "af41e3c0-277b-43e7-b1a7-0d141d2913a8",
    ...tail(agentId, ts),
  });
}

function apiError(agentId: string | null, ts: string, body: string): string {
  return j({
    parentUuid: "73d67c91-902e-4fd9-b255-997952fa6cc7",
    isSidechain: agentId !== null,
    ...(agentId ? { agentId } : {}),
    type: "assistant",
    uuid: `a-${ts}`,
    timestamp: ts,
    message: { diagnostics: null, id: "56cd34c1-f228-4266-9302-6f1a8a696a4f", container: null, model: "<synthetic>", role: "assistant", stop_details: null, stop_reason: "stop_sequence", stop_sequence: "", type: "message", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: "text", text: body }], context_management: null },
    apiError: "max_output_tokens",
    error: "max_output_tokens",
    isApiErrorMessage: true,
    userType: "external",
    entrypoint: "sdk-cli",
    cwd: CWD,
    sessionId: SESSION,
    version: "2.1.278",
  });
}

function interrupt(agentId: string | null, ts: string, entrypoint = "claude-vscode"): string {
  return j({ parentUuid: "ae4d03c3-21c9-465d-a9cb-59c5087d3531", isSidechain: agentId !== null, promptId: "a03a8f84-cfb2-400a-804a-241397bcdfe2", ...(agentId ? { agentId } : {}), type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, uuid: `u-${ts}`, ...tail(agentId, ts, entrypoint) });
}

/** The parent's TaskStop result (sampled from a real parent transcript, 2.1.270–2.1.280). */
function taskStop(ts: string, taskType: "local_workflow" | "local_agent" | "local_bash", taskId: string): string {
  const result = { message: `Successfully stopped task: ${taskId} (Build 6 verified finding clusters)`, task_id: taskId, task_type: taskType, command: "Build 6 verified finding clusters" };
  return j({
    parentUuid: "9eb1f476-9853-4b94-8357-9368189a3688",
    isSidechain: false,
    promptId: "4b9538ad-21c2-4b75-9e98-c8b0bfb5e5b0",
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "toolu_01BCyErFZskFqLE1K42PXpTc", type: "tool_result", content: JSON.stringify(result) }] },
    uuid: `u-${ts}`,
    timestamp: ts,
    toolUseResult: result,
    sourceToolAssistantUUID: "9eb1f476-9853-4b94-8357-9368189a3688",
    userType: "external",
    entrypoint: "claude-vscode",
    cwd: CWD,
    sessionId: SESSION,
    version: "2.1.280",
    gitBranch: "HEAD",
  });
}

/** What Claude Code appends to a session after it ended: a queued notification, not a turn. */
function lateNotification(ts: string): string {
  return j({ parentUuid: "f131d61f-207a-4c85-b263-8363347c27b9", isSidechain: false, promptId: "e1905bc2-e2c4-4f41-b938-ca047d5953c2", type: "user", message: { role: "user", content: "<task-notification>\n<task-id>b3qptnyin</task-id>\n<status>stopped</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>" }, uuid: `u-${ts}`, origin: { kind: "task-notification" }, ...tail(null, ts, "claude-vscode") });
}

/** The lines Claude Code writes after the last turn (they say nothing about the turn). */
function trailer(ts: string): string {
  return j({ type: "attachment", attachment: { type: "hook_success" }, ...tail(null, ts) }) + j({ type: "last-prompt", lastPrompt: "…", sessionId: SESSION }) + j({ type: "cost-state", sessionId: SESSION });
}

function fold(lines: string): { st: ReturnType<typeof newSubagentState>; out: FoldResult } {
  const st = newSubagentState("a0000000000000001", SESSION, null);
  const out: FoldResult = { spawnIds: [], activities: [] };
  for (const l of lines.split("\n")) if (l) foldSubagentLine(st, Buffer.from(l), false, out);
  return { st, out };
}

async function aged(path: string, content: string, msAgo: number): Promise<void> {
  await writeFile(path, content);
  const t = new Date(Date.now() - msAgo);
  await utimes(path, t, t);
}

describe("how a subagent transcript ends (lastKind)", () => {
  const A = "a0000000000000001";
  const T = "2026-09-15T05:13:1";

  it("a text with stop_reason null is mid-turn, the final one with end_turn ends it", () => {
    expect(fold(prompt(A, `${T}0Z`, "go") + text(A, `${T}1Z`, "I'll call both APIs in parallel.", null)).st.lastKind).toBe("text_open");
    expect(fold(prompt(A, `${T}0Z`, "go") + text(A, `${T}1Z`, "All data is in. Here is the brief.", "end_turn")).st.lastKind).toBe("assistant_text");
  });

  it("a tool result updates lastKind (the model hasn't answered yet), big or small", () => {
    expect(fold(prompt(A, `${T}0Z`, "go") + toolUse(A, `${T}1Z`)).st.lastKind).toBe("assistant_tool");
    expect(fold(prompt(A, `${T}0Z`, "go") + toolUse(A, `${T}1Z`) + toolResult(A, `${T}2Z`, 300_000)).st.lastKind).toBe("tool_result");
  });

  it("an API error, an interrupt, and a late notification", () => {
    const err = fold(prompt(A, `${T}0Z`, "go") + apiError(A, `${T}1Z`, "Request timed out"));
    expect(err.st.lastKind).toBe("api_error");
    expect(err.st.lastError).toBe("Request timed out");
    expect(fold(prompt(A, `${T}0Z`, "go") + toolUse(A, `${T}1Z`) + interrupt(A, `${T}2Z`)).st.lastKind).toBe("interrupted");
    // A prompt that merely quotes the phrase is a prompt, not an interrupt.
    expect(fold(prompt(A, `${T}0Z`, "Remember: [Request interrupted by user] means stop.")).st.lastKind).toBe("prompt");
    expect(fold(prompt(A, `${T}0Z`, "go") + text(A, `${T}1Z`, "Done.", "end_turn") + lateNotification(`${T}5Z`)).st.lastKind).toBe("assistant_text");
  });

  it("lineKind reads the same kinds from single lines, and nothing from the trailer", () => {
    const k = (l: string): string | undefined => lineKind(Buffer.from(l.trimEnd()))?.kind;
    expect(k(text(null, `${T}1Z`, "x", null))).toBe("text_open");
    expect(k(apiError(null, `${T}1Z`, "API Error: Unable to connect to API (ConnectionRefused)"))).toBe("api_error");
    expect(lineKind(Buffer.from(apiError(null, `${T}1Z`, "API Error: Unable to connect to API (ConnectionRefused)").trimEnd()))?.error).toBe("API Error: Unable to connect to API (ConnectionRefused)");
    for (const l of trailer(`${T}9Z`).trimEnd().split("\n")) expect(lineKind(Buffer.from(l))).toBeNull();
  });
});

describe("subagent records on real-shaped transcripts", () => {
  const cases: Array<[string, string, number, Pick<SubagentRecord, "status" | "reason">]> = [
    ["a0000000000000011", text("a0000000000000011", "2026-09-15T05:13:11Z", "Calling both APIs now.", null), 10 * MIN, { status: "running", reason: null }],
    ["a0000000000000012", text("a0000000000000012", "2026-09-15T05:13:11Z", "Report delivered to the caller.", null), STALLED, { status: "done", reason: null }],
    ["a0000000000000013", toolUse("a0000000000000013", "2026-09-15T05:13:11Z") + toolResult("a0000000000000013", "2026-09-15T05:13:12Z"), 10 * MIN, { status: "running", reason: null }],
    ["a0000000000000014", toolUse("a0000000000000014", "2026-09-15T05:13:11Z") + toolResult("a0000000000000014", "2026-09-15T05:13:12Z"), STALLED, { status: "failed", reason: "cut off: no reply after a tool result" }],
    ["a0000000000000015", apiError("a0000000000000015", "2026-09-23T06:23:46Z", "Request timed out"), 10 * MIN, { status: "failed", reason: "API error: Request timed out" }],
    ["a0000000000000016", toolUse("a0000000000000016", "2026-09-24T13:33:01Z") + interrupt("a0000000000000016", "2026-09-24T13:33:03Z"), 10 * MIN, { status: "failed", reason: "interrupted (cause unknown)" }],
    ["a0000000000000018", "", 61 * MIN, { status: "running", reason: null }], // an unanswered prompt, 61 min: still running
    ["a0000000000000017", text("a0000000000000017", "2026-09-15T05:13:11Z", "All data is in.", "end_turn"), 10 * MIN, { status: "done", reason: null }],
  ];

  it("resolves each ending by its rule", async () => {
    const root = await makeTempProjectsDir();
    const projects = join(root, "projects");
    const dir = join(projects, PROJECT, SESSION, "subagents");
    await mkdir(dir, { recursive: true });
    for (const [id, body, ago] of cases) await aged(join(dir, `agent-${id}.jsonl`), prompt(id, "2026-09-15T05:13:10Z", "go") + body, ago);
    const store = new SubagentStore(join(root, "sa.db"));
    await runSubagentPass(store, projects, { collectActivity: false });
    const byId = new Map(buildRecords(store, Date.now()).map((r) => [r.id, r] as const));
    for (const [id, , , want] of cases) expect({ id, ...want }).toEqual({ id, status: byId.get(id)?.status, reason: byId.get(id)?.reason });
    store.close();
  });

  it("a notification naming several agents reports each, with the parent's words; parents are re-read once per PARENT_FOLD_VERSION", async () => {
    const root = await makeTempProjectsDir();
    const projects = join(root, "projects");
    const dir = join(projects, PROJECT, SESSION, "subagents");
    await mkdir(dir, { recursive: true });
    const [X, Y, Z] = ["ae9aaf124836a79d6", "a3dc0274a2e0d8a70", "a8f8c968f132f9ed7"];
    for (const id of [X, Y, Z]) await aged(join(dir, `agent-${id}.jsonl`), prompt(id, "2026-09-24T02:00:00Z", "research") + toolUse(id, "2026-09-24T02:00:01Z"), 10 * MIN);
    const parent =
      j({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-24T02:55:08.678Z", sessionId: SESSION, content: `<task-notification>\n<task-id>${X}</task-id>\n<task-id>${Y}</task-id>\n<status>stopped</status>\n<summary>2 background agents didn't finish before the previous session ended: "US research" (${X}), "LatAm research" (${Y}).</summary>\n</task-notification>` }) +
      j({ type: "user", message: { role: "user", content: `<task-notification>\n<task-id>${Z}</task-id>\n<tool-use-id>toolu_01TCMFDdk5znPgDRZjCM4427</tool-use-id>\n<status>failed</status>\n<summary>Agent "Design sweep" failed: Agent stalled: no progress for 600s (stream watchdog did not recover)</summary>\n</task-notification>` }, timestamp: "2026-09-24T02:56:00Z", sessionId: SESSION });
    const parentPath = join(projects, PROJECT, `${SESSION}.jsonl`);
    await writeFile(parentPath, parent);

    // What the previous release stored: the parent already read to its end, first <task-id> only.
    const dbPath = join(root, "sa.db");
    const old = new SubagentStore(dbPath);
    const { size, mtimeMs } = await stat(parentPath);
    old.commit({ offsets: new Map([[parentPath, { size, mtime: mtimeMs, offset: size }]]), states: [], reports: [{ agentId: X, status: "stopped", model: null, description: null }], spawns: [] });
    old.close();

    const store = new SubagentStore(dbPath);
    expect(store.meta("parentFoldVersion")).toBeUndefined();
    const first = await runSubagentPass(store, projects, { collectActivity: false });
    expect(first.parentsRead).toBe(1);
    expect(store.meta("parentFoldVersion")).toBe(String(PARENT_FOLD_VERSION));
    const byId = new Map(buildRecords(store, Date.now()).map((r) => [r.id, r] as const));
    expect(byId.get(X)).toMatchObject({ status: "stopped", reason: "its session ended before it finished" });
    expect(byId.get(Y)).toMatchObject({ status: "stopped", reason: "its session ended before it finished" });
    expect(byId.get(Z)).toMatchObject({ status: "failed", reason: "Agent stalled: no progress for 600s (stream watchdog did not recover)" });
    expect((await runSubagentPass(store, projects, { collectActivity: false })).parentsRead).toBe(0); // once
    store.close();
  });

  it("a crash before the pass commits leaves no flag, and the next pass converges (crash-then-rerun)", async () => {
    const root = await makeTempProjectsDir();
    const projects = join(root, "projects");
    const dir = join(projects, PROJECT, SESSION, "subagents");
    await mkdir(dir, { recursive: true });
    const X = "a0000000000000021";
    await aged(join(dir, `agent-${X}.jsonl`), prompt(X, "2026-09-24T02:00:00Z", "go") + interrupt(X, "2026-09-24T02:00:05.272Z"), 10 * MIN);
    await writeFile(join(projects, PROJECT, `${SESSION}.jsonl`), prompt(null, "2026-09-24T01:59:00Z", "orchestrate") + taskStop("2026-09-24T02:00:05.284Z", "local_agent", X));
    const dbPath = join(root, "sa.db");
    const store = new SubagentStore(dbPath);
    store.commit = () => {
      throw new Error("simulated crash mid-commit");
    };
    await expect(runSubagentPass(store, projects, { collectActivity: false })).rejects.toThrow("simulated crash");
    store.close();
    const again = new SubagentStore(dbPath);
    expect(again.meta("parentFoldVersion")).toBeUndefined();
    expect(again.states.size).toBe(0);
    expect(again.stops.size).toBe(0); // the stops ride the same transaction
    const pass = await runSubagentPass(again, projects, { collectActivity: false });
    expect([pass.filesRead, pass.parentsRead]).toEqual([1, 1]);
    expect(again.meta("parentFoldVersion")).toBe(String(PARENT_FOLD_VERSION));
    expect(buildRecords(again, Date.now())[0]).toMatchObject({ id: X, status: "stopped", reason: "stopped by its parent session" });
    again.close();
  });

  it("parentReportsOnLine keeps the summary and every task-id", () => {
    const line = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>ae9aaf124836a79d6</task-id>\n<task-id>a3dc0274a2e0d8a70</task-id>\n<status>stopped</status>\n<summary>2 background agents didn't finish</summary>\n</task-notification>" });
    expect(parentReportsOnLine(line).map((r) => [r.agentId, r.status, r.summary])).toEqual([
      ["ae9aaf124836a79d6", "stopped", "2 background agents didn't finish"],
      ["a3dc0274a2e0d8a70", "stopped", "2 background agents didn't finish"],
    ]);
  });
});

describe("an interrupt is a stop only when the parent session explains it", () => {
  // The real cases (2026-09-25/27/28): a workflow the parent TaskStopped wrote each agent's
  // interrupt 12–58 ms before the TaskStop's result; a workflow's stall watchdog wrote the same
  // interrupt line with nothing in the parent (the harness then retried the agent).
  const WF = "wf_318398cd-296";
  const [STOPPED, WATCHDOG, LATE, BY_USER, BASH] = ["a5757767a40b45769", "aa5d5f7a9eeb99a63", "a0000000000000031", "a0000000000000032", "a0000000000000033"];

  async function setup(): Promise<{ projects: string; root: string; parentPath: string; wfDir: string }> {
    const root = await makeTempProjectsDir();
    const projects = join(root, "projects");
    const wfDir = join(projects, PROJECT, SESSION, "subagents", "workflows", WF);
    await mkdir(wfDir, { recursive: true });
    return { projects, root, parentPath: join(projects, PROJECT, `${SESSION}.jsonl`), wfDir };
  }
  const agent = (id: string, at: string): string => prompt(id, "2026-09-25T18:50:15Z", "Build cluster c1.") + toolUse(id, "2026-09-25T18:50:17Z") + interrupt(id, at);

  it("TaskStop or a user interrupt in the parent within 1s → stopped; nothing, too far, or a shell's TaskStop → failed", async () => {
    const { projects, root, parentPath, wfDir } = await setup();
    await aged(join(wfDir, `agent-${STOPPED}.jsonl`), agent(STOPPED, "2026-09-25T18:50:20.226Z"), 10 * MIN);
    await aged(join(wfDir, `agent-${WATCHDOG}.jsonl`), agent(WATCHDOG, "2026-09-27T23:58:04.198Z"), 10 * MIN);
    await aged(join(wfDir, `agent-${LATE}.jsonl`), agent(LATE, "2026-09-25T18:50:23.400Z"), 10 * MIN);
    await aged(join(wfDir, `agent-${BY_USER}.jsonl`), agent(BY_USER, "2026-09-26T09:00:00.450Z"), 10 * MIN);
    await aged(join(wfDir, `agent-${BASH}.jsonl`), agent(BASH, "2026-09-26T10:00:00.100Z"), 10 * MIN);
    await writeFile(
      parentPath,
      prompt(null, "2026-09-25T18:50:10Z", "orchestrate") +
        taskStop("2026-09-25T18:50:20.284Z", "local_workflow", "wx5a22r2k") +
        interrupt(null, "2026-09-26T09:00:00.100Z") +
        taskStop("2026-09-26T10:00:00.150Z", "local_bash", "bfg43fcjg"),
    );
    const store = new SubagentStore(join(root, "sa.db"));
    await runSubagentPass(store, projects, { collectActivity: false });
    const byId = new Map(buildRecords(store, Date.now()).map((r) => [r.id, r] as const));
    expect(byId.get(STOPPED)).toMatchObject({ status: "stopped", reason: "stopped by its parent session" });
    expect(byId.get(WATCHDOG)).toMatchObject({ status: "failed", reason: "interrupted (cause unknown)" });
    expect(byId.get(LATE)).toMatchObject({ status: "failed", reason: "interrupted (cause unknown)" }); // 3.1s after the TaskStop
    expect(byId.get(BY_USER)).toMatchObject({ status: "stopped", reason: "interrupted by the user" });
    expect(byId.get(BASH)).toMatchObject({ status: "failed", reason: "interrupted (cause unknown)" });
    store.close();
  });

  it("a parent stop read in an earlier pass than the agent's interrupt still explains it, and survives a reopen", async () => {
    const { projects, root, parentPath, wfDir } = await setup();
    const p = join(wfDir, `agent-${STOPPED}.jsonl`);
    await aged(p, prompt(STOPPED, "2026-09-25T18:50:15Z", "Build cluster c1.") + toolUse(STOPPED, "2026-09-25T18:50:17Z"), 10 * MIN);
    await writeFile(parentPath, prompt(null, "2026-09-25T18:50:10Z", "orchestrate") + taskStop("2026-09-25T18:50:20.284Z", "local_workflow", "wx5a22r2k"));
    const dbPath = join(root, "sa.db");
    const store = new SubagentStore(dbPath);
    await runSubagentPass(store, projects, { collectActivity: false });
    expect(store.stops.get(SESSION)).toEqual([{ at: "2026-09-25T18:50:20.284Z", by: "task" }]);
    await aged(p, agent(STOPPED, "2026-09-25T18:50:20.226Z"), 10 * MIN); // the interrupt lands after the parent was read
    const second = await runSubagentPass(store, projects, { collectActivity: false });
    expect([second.filesRead, second.parentsRead]).toEqual([1, 0]);
    expect(buildRecords(store, Date.now())[0]).toMatchObject({ id: STOPPED, status: "stopped", reason: "stopped by its parent session" });
    store.close();
    const reopened = new SubagentStore(dbPath);
    expect(buildRecords(reopened, Date.now())[0]).toMatchObject({ id: STOPPED, status: "stopped" });
    reopened.close();
  });

  it("parentStopOnLine reads structure, not text; interruptCause picks the nearest stop within 1s", () => {
    const line = (l: string): Buffer => Buffer.from(l.trimEnd());
    expect(parentStopOnLine(line(taskStop("2026-09-25T18:50:20.284Z", "local_agent", "abe0d54c4367c27bd")))).toEqual({ at: "2026-09-25T18:50:20.284Z", by: "task" });
    expect(parentStopOnLine(line(taskStop("2026-09-25T18:50:20.284Z", "local_bash", "bfg43fcjg")))).toBeNull();
    expect(parentStopOnLine(line(interrupt(null, "2026-09-21T02:03:41.406Z")))).toEqual({ at: "2026-09-21T02:03:41.406Z", by: "user" });
    // A prompt or a tool result that quotes the phrase is not a stop.
    expect(parentStopOnLine(line(prompt(null, "2026-09-21T02:03:41Z", "Remember: [Request interrupted by user] means stop.")))).toBeNull();
    expect(parentStopOnLine(line(toolResult(null, "2026-09-21T02:03:41Z").replace("is only text here", "[Request interrupted by user]")))).toBeNull();
    const stops = [
      { at: "2026-09-25T18:50:20.284Z", by: "task" as const },
      { at: "2026-09-25T18:50:20.900Z", by: "user" as const },
    ];
    expect(interruptCause("2026-09-25T18:50:20.226Z", stops)).toBe("stopped by its parent session");
    expect(interruptCause("2026-09-25T18:50:21.500Z", stops)).toBe("interrupted by the user");
    expect(interruptCause("2026-09-25T18:50:22.000Z", stops)).toBeNull();
    expect(interruptCause(null, stops)).toBeNull();
    expect(interruptCause("2026-09-25T18:50:20.226Z", undefined)).toBeNull();
  });
});

describe("an unanswered prompt gets PROMPT_STALL_MS, other mid-turn silences STALL_MS", () => {
  it("the real headless silences: a prompt 63 min unanswered is still running; past 2 h it is cut off", () => {
    expect(endingOutcome("prompt", 63 * MIN, null)).toEqual({ status: "running", reason: null });
    expect(endingOutcome("prompt", 108 * MIN, null)).toEqual({ status: "running", reason: null });
    expect(endingOutcome("prompt", PROMPT_STALL_MS + MIN, null)).toEqual({ status: "failed", reason: "cut off: its prompt was never answered" });
    expect(endingOutcome("tool_result", STALLED, null)).toEqual({ status: "failed", reason: "cut off: no reply after a tool result" });
  });
});

describe("session run endings (endings.ts)", () => {
  it("reads the last turn behind the trailer, across a multi-MB last line, and ignores a partial one", async () => {
    const dir = await makeTempProjectsDir();
    const p = join(dir, "s.jsonl");
    const body = prompt(null, "2026-09-24T09:00:00Z", "run") + toolUse(null, "2026-09-24T09:00:01Z") + toolResult(null, "2026-09-24T09:00:02Z", 3_000_000) + trailer("2026-09-24T09:00:03Z");
    await writeFile(p, `${body}{"type":"assistant","partial`);
    expect(await readTailEnding(p, (await stat(p)).size)).toEqual({ kind: "tool_result", error: null, headless: true });
    const empty = join(dir, "e.jsonl");
    await writeFile(empty, trailer("2026-09-24T09:00:03Z"));
    expect((await readTailEnding(empty, (await stat(empty)).size)).kind).toBeNull();
  });

  it("lists failed and stopped sessions only, each with its rule's reason", async () => {
    const root = await makeTempProjectsDir();
    const proj = join(root, PROJECT);
    await mkdir(proj, { recursive: true });
    const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const P = (n: number): string => join(proj, `${id(n)}.jsonl`);
    const start = prompt(null, "2026-09-19T07:03:17Z", "You are the narrative step of Alex's /daily-recap.");
    await aged(P(1), start + apiError(null, "2026-09-19T08:50:59Z", "API Error: Unable to connect to API (ConnectionRefused)") + trailer("2026-09-19T08:51:00Z"), 10 * MIN);
    await aged(P(2), start + toolUse(null, "2026-09-24T11:14:32Z") + trailer("2026-09-24T11:14:33Z"), STALLED); // cut off mid-tool
    await aged(P(3), start + toolUse(null, "2026-09-24T11:14:32Z"), 10 * MIN); // mid-tool, not stalled yet: running
    await aged(P(4), start + text(null, "2026-09-24T11:14:32Z", "Done.", "end_turn") + lateNotification("2026-09-24T12:00:00Z"), STALLED); // clean
    await aged(P(5), start + toolUse(null, "2026-09-24T11:14:32Z") + interrupt(null, "2026-09-24T11:14:40Z"), STALLED);
    await aged(P(6), start + apiError(null, "2026-09-19T08:50:59Z", "Request timed out"), 30_000); // still being written
    await aged(P(7), start + toolUse(null, "2026-09-24T11:14:32Z") + interrupt(null, "2026-09-24T11:14:40Z", "sdk-cli"), STALLED); // headless: nobody to interrupt it
    await aged(P(8), start, 63 * MIN); // the first reply still pending (a96c2446 went on after 63 min)
    await aged(join(proj, "not-a-session.jsonl"), start + apiError(null, "2026-09-19T08:50:59Z", "x"), 10 * MIN);

    const endings = new RunEndings();
    const list = await endings.refresh(root, Date.now());
    const byId = new Map(list.map((e) => [e.sessionId, e] as const));
    expect([...byId.keys()].sort()).toEqual([id(1), id(2), id(5), id(7)]);
    expect(byId.get(id(1))).toMatchObject({ status: "failed", reason: "API Error: Unable to connect to API (ConnectionRefused)", headless: true });
    expect(byId.get(id(2))).toMatchObject({ status: "failed", reason: "cut off: a tool call never returned", headless: true });
    expect(byId.get(id(5))).toMatchObject({ status: "stopped", reason: "interrupted by the user", headless: false });
    expect(byId.get(id(7))).toMatchObject({ status: "failed", reason: "interrupted (cause unknown)", headless: true });
    // The cached tail is reused while the file doesn't change; the clock alone can still move P(3) to cut off.
    expect((await endings.refresh(root, Date.now() + STALL_MS)).map((e) => e.sessionId).sort()).toEqual([id(1), id(2), id(3), id(5), id(6), id(7)]);
    // The unanswered prompt is cut off only past PROMPT_STALL_MS.
    const late = await endings.refresh(root, Date.now() + PROMPT_STALL_MS);
    expect(late.find((e) => e.sessionId === id(8))).toMatchObject({ status: "failed", reason: "cut off: its prompt was never answered", headless: true });
  });
});

describe("publish emits every changed record", () => {
  it("chunks 450 changes into 3 upserts of ≤ 200 and drops none", () => {
    const stats: SubagentStats = { total: 450, today: 0, live: 0, parents: 1, deepest: 1, coldPassMs: 1 };
    const recs = Array.from({ length: 450 }, (_, i) => ({ id: `a${String(i).padStart(16, "0")}` }) as SubagentRecord);
    const msgs = upsertMessages(recs, stats);
    expect(msgs.map((m) => (m.kind === "upsert" ? m.subagents.length : -1))).toEqual([200, 200, 50]);
    expect(msgs.flatMap((m) => (m.kind === "upsert" ? m.subagents.map((r) => r.id) : []))).toEqual(recs.map((r) => r.id));
    expect(upsertMessages([], stats)).toEqual([]);
  });
});
