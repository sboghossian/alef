import { afterEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

describe("POST /api/open-editor/:agentId", () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("rejects a non-uuid agent id with 400, without calling the executor", async () => {
    const calls: string[] = [];
    const { base, server: s } = await bootTestServer({ openEditorExecutor: (cwd) => { calls.push(cwd); } });
    server = s;

    const res = await fetch(`${base}/api/open-editor/not-a-uuid`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown (but well-formed) agent id with 404", async () => {
    const calls: string[] = [];
    const { base, server: s } = await bootTestServer({ openEditorExecutor: (cwd) => { calls.push(cwd); } });
    server = s;

    const res = await fetch(`${base}/api/open-editor/99999999-9999-9999-9999-999999999999`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("runs the injected executor with the session's cwd and returns ok for a known agent", async () => {
    const calls: string[] = [];
    const { base, server: s } = await bootTestServer({ openEditorExecutor: (cwd) => { calls.push(cwd); } });
    server = s;

    const agentId = "abcdefab-1234-1234-1234-1234567890ab";
    s.db.setIslandForCwd("/ws/editor-project", "editor-project");
    s.db.upsertSession({
      id: agentId,
      cwd: "/ws/editor-project",
      islandId: "editor-project",
      title: "test session",
      startedAt: "2026-09-20T00:00:00.000Z",
      lastActive: "2026-09-20T00:00:00.000Z",
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 1,
      cntAssistantTotalDelta: 1,
    });

    const res = await fetch(`${base}/api/open-editor/${agentId}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agentId: string };
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe(agentId);
    expect(calls).toEqual(["/ws/editor-project"]);
  });

  it("turns an executor failure into a 500 with the error message", async () => {
    const { base, server: s } = await bootTestServer({
      openEditorExecutor: () => {
        throw new Error("code: command not found");
      },
    });
    server = s;

    const agentId = "abcdefab-1234-1234-1234-1234567890ab";
    s.db.setIslandForCwd("/ws/editor-project", "editor-project");
    s.db.upsertSession({
      id: agentId,
      cwd: "/ws/editor-project",
      islandId: "editor-project",
      title: "test session",
      startedAt: "2026-09-20T00:00:00.000Z",
      lastActive: "2026-09-20T00:00:00.000Z",
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 1,
      cntAssistantTotalDelta: 1,
    });

    const res = await fetch(`${base}/api/open-editor/${agentId}`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("command not found");
  });
});
