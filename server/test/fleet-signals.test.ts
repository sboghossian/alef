import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorldAgent } from "../../shared/types.js";
import { classifyAgent, computeStates } from "../features/agent-state.js";
import { computeConflicts } from "../features/conflicts.js";
import { FleetTracker } from "../features/fleet-tracker.js";

const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function assistantTool(name: string, input: Record<string, unknown>, id: string, at: number, cwd = "/repo"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(at),
    cwd,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}
function toolResult(id: string, at: number, content: string = "ok"): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(at),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}
function userText(text: string, at: number): string {
  return JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "text", text }] } });
}

describe("FleetTracker todos", () => {
  it("TodoWrite replaces the list and keeps activeForm; malformed items dropped", () => {
    const t = new FleetTracker();
    t.ingestLine(
      "s1",
      assistantTool(
        "TodoWrite",
        {
          todos: [
            { content: "Write tests", status: "completed", activeForm: "Writing tests" },
            { content: "Build it", status: "in_progress", activeForm: "Building it" },
            { content: "Ship", status: "pending", activeForm: "Shipping" },
            { content: "bad", status: "weird" },
            "nope",
          ],
        },
        "tu1",
        T0,
      ),
      T0,
    );
    const list = t.todoList("s1");
    expect(list?.items.map((i) => i.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(list?.items[1]?.activeForm).toBe("Building it");
    expect(list?.updatedAt).toBe(iso(T0));
  });

  it("TaskCreate/TaskUpdate build the list incrementally, adopt Task #N ids, and dedupe replays", () => {
    const t = new FleetTracker();
    const lines = [
      assistantTool("TaskCreate", { subject: "Render HTML" }, "c1", T0),
      toolResult("c1", T0 + 1, "Task #4 created successfully: Render HTML"),
      assistantTool("TaskCreate", { subject: "Archive" }, "c2", T0 + 2),
      assistantTool("TaskUpdate", { taskId: "4", status: "in_progress", activeForm: "Rendering" }, "u1", T0 + 3),
      assistantTool("TaskUpdate", { taskId: "4", status: "completed" }, "u2", T0 + 4),
      assistantTool("TaskUpdate", { taskId: "5", status: "deleted" }, "u3", T0 + 5),
    ];
    for (const l of lines) t.ingestLine("s2", l, T0);
    // A cold scan + live batch overlap must not duplicate items.
    t.ingestLine("s2", lines[2] ?? "", T0);
    const list = t.todoList("s2");
    expect(list?.items).toEqual([{ content: "Render HTML", status: "completed", activeForm: "Rendering" }]);
  });

  it("sanitizes: control chars stripped, secrets redacted, long text capped", () => {
    const t = new FleetTracker();
    t.ingestLine(
      "s3",
      assistantTool("TodoWrite", { todos: [{ content: `use key sk-ABCDEFGHIJKLMNOPQRSTUV\u001b[31m ${"x".repeat(300)}`, status: "pending" }] }, "a", T0),
      T0,
    );
    const c = t.todoList("s3")?.items[0]?.content ?? "";
    expect(c).toContain("[redacted]");
    expect(c).not.toContain("\u001b");
    expect(c.length).toBeLessThanOrEqual(120);
  });

  it("ingestBatch applies one batch object once", () => {
    const t = new FleetTracker();
    const batch = new Map([["s4", [assistantTool("TaskCreate", { subject: "A" }, "x1", T0)]]]);
    t.ingestBatch(batch);
    t.ingestBatch(batch);
    expect(t.todoList("s4")?.items).toHaveLength(1);
  });

  it("malformed JSON and non-object lines are ignored", () => {
    const t = new FleetTracker();
    t.ingestLine("s5", '{"tool_use" broken', T0);
    t.ingestLine("s5", '"tool_use"', T0);
    expect(t.todoList("s5")).toBeNull();
  });
});

describe("FleetTracker pending tools + writes", () => {
  it("tracks unmatched tool_use until its tool_result; a new human prompt clears them", () => {
    const t = new FleetTracker();
    t.ingestLine("s", assistantTool("Bash", { command: "ls" }, "b1", T0), T0);
    t.ingestLine("s", assistantTool("Read", { file_path: "/x" }, "r1", T0), T0);
    t.ingestLine("s", toolResult("r1", T0 + 10), T0);
    expect([...(t.sessions.get("s")?.pending.keys() ?? [])]).toEqual(["b1"]);
    t.ingestLine("s", userText("hello", T0 + 20), T0);
    expect(t.sessions.get("s")?.pending.size).toBe(0);
  });

  it("records writes (not reads), resolves relative paths against the line cwd, expires after the window", () => {
    const t = new FleetTracker();
    t.ingestLine("s", assistantTool("Edit", { file_path: "src/a.ts" }, "e1", T0, "/repo"), T0);
    t.ingestLine("s", assistantTool("Read", { file_path: "/repo/b.ts" }, "r1", T0), T0);
    t.ingestLine("s", assistantTool("NotebookEdit", { notebook_path: "/repo/n.ipynb" }, "n1", T0 - 40 * 60_000), T0);
    const w = t.recentWrites(T0 + 1000).get("s");
    expect([...(w?.keys() ?? [])]).toEqual(["/repo/src/a.ts"]);
  });

  it("cold scan rebuilds todos from recent files only, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aw-fleet-"));
    await mkdir(join(dir, "-repo"));
    const now = Date.now();
    await writeFile(
      join(dir, "-repo", "11111111-1111-4111-8111-111111111111.jsonl"),
      [assistantTool("TaskCreate", { subject: "From disk" }, "c1", now - 1000), "not json"].join("\n") + "\n",
    );
    const t = new FleetTracker();
    await t.ensureColdScan(dir, now);
    await t.ensureColdScan(dir, now);
    expect(t.todoList("11111111-1111-4111-8111-111111111111")?.items.map((i) => i.content)).toEqual(["From disk"]);
  });

  it("cold scan on a missing dir resolves quietly", async () => {
    const t = new FleetTracker();
    await expect(t.ensureColdScan("/nonexistent/aw-projects")).resolves.toBeUndefined();
  });
});

describe("classifyAgent", () => {
  const base = { status: "live" as const, awaitingInput: false, lastActiveMs: T0, pending: [], queuedApproval: false };
  it("maps each rule", () => {
    expect(classifyAgent({ ...base, status: "dormant" }, T0)).toBe("sleeping");
    expect(classifyAgent({ ...base, status: "dormant", queuedApproval: true }, T0)).toBe("permission");
    expect(classifyAgent({ ...base, awaitingInput: true }, T0 + 5000)).toBe("waiting");
    expect(classifyAgent(base, T0 + 30_000)).toBe("working");
    expect(classifyAgent(base, T0 + 61_000)).toBe("idle");
    expect(classifyAgent({ ...base, pending: [{ name: "Bash", atMs: T0 }] }, T0 + 10_000)).toBe("working");
    expect(classifyAgent({ ...base, pending: [{ name: "Bash", atMs: T0 }] }, T0 + 21_000)).toBe("permission");
    expect(classifyAgent({ ...base, pending: [{ name: "Agent", atMs: T0 }] }, T0 + 5 * 60_000)).toBe("working");
    // With the real hook installed, a slow tool is just slow; only the queue means "permission".
    expect(classifyAgent({ ...base, hookInstalled: true, pending: [{ name: "Bash", atMs: T0 }] }, T0 + 5 * 60_000)).toBe("working");
    expect(classifyAgent({ ...base, hookInstalled: true, queuedApproval: true }, T0)).toBe("permission");
  });

  it("computeStates uses the later of lastActive and the tracker's last line", () => {
    const t = new FleetTracker();
    t.ingestLine("a1", userText("hi", T0 + 50_000), T0);
    const agent = { id: "a1", status: "live", awaitingInput: false, lastActive: iso(T0) } as WorldAgent;
    expect(computeStates([agent], t, new Set(), T0 + 70_000)).toEqual({ a1: "working" });
    expect(computeStates([agent], t, new Set(["a1"]), T0 + 70_000)).toEqual({ a1: "permission" });
  });
});

describe("computeConflicts", () => {
  it("pairs sessions writing the same file within 30 min when one is live", () => {
    const writes = new Map([
      ["b", new Map([["/r/x.ts", T0], ["/r/y.ts", T0 + 5]])],
      ["a", new Map([["/r/x.ts", T0 - 60_000], ["/r/y.ts", T0 - 1]])],
      ["c", new Map([["/r/x.ts", T0 - 40 * 60_000]])], // outside window
      ["d", new Map([["/r/z.ts", T0]])],
    ]);
    const pairs = computeConflicts(writes, new Set(["b"]), T0 + 1000);
    expect(pairs).toEqual([{ a: "a", b: "b", files: ["/r/x.ts", "/r/y.ts"], at: iso(T0 + 5) }]);
  });

  it("ignores overlaps where neither session is live", () => {
    const writes = new Map([
      ["a", new Map([["/r/x.ts", T0]])],
      ["b", new Map([["/r/x.ts", T0]])],
    ]);
    expect(computeConflicts(writes, new Set(), T0)).toEqual([]);
  });
});

describe("FleetTracker lastLineMs", () => {
  it("ignores lines without a timestamp (they are not activity)", () => {
    const t = new FleetTracker();
    t.ingestLine("s", userText("hi", T0), T0 + 3600_000);
    t.ingestLine("s", JSON.stringify({ type: "file-history-snapshot", snapshot: {} }), T0 + 3600_000);
    t.ingestLine("s", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] } }), T0 + 3600_000);
    expect(t.sessions.get("s")?.lastLineMs).toBe(T0);
  });
});
