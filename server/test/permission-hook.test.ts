// Runs hooks/permission-request.mjs as a real child process against a fake world server.

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "permission-request.mjs");
const INPUT = {
  session_id: "0b7c1a4e-1111-4222-8333-444455556666",
  transcript_path: "/tmp/x.jsonl",
  cwd: "/repo",
  permission_mode: "default",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf build", description: "Clean", huge: "x".repeat(50_000) },
  tool_use_id: "toolu_1",
};

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(env: Record<string, string>, input: unknown = INPUT): Promise<HookRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = null;
});

async function fakeWorld(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A world that queues the request and answers polls with `result` after `polls` pending rounds. */
function deciding(result: unknown, polls = 1): { handler: Handler; posted: () => Record<string, unknown> | null } {
  let posted: Record<string, unknown> | null = null;
  let n = 0;
  return {
    posted: () => posted,
    handler: (req, res, body) => {
      if (req.method === "POST" && req.url === "/api/approvals") {
        posted = JSON.parse(body) as Record<string, unknown>;
        return json(res, 201, { id: "abc-123" });
      }
      if (req.method === "GET" && req.url === "/api/approvals/abc-123") {
        n += 1;
        return json(res, 200, n <= polls ? { status: "pending" } : result);
      }
      json(res, 404, {});
    },
  };
}

describe("permission-request hook", () => {
  it("world unreachable → exits 0 fast with empty stdout", async () => {
    const r = await runHook({ AGENT_WORLD_URL: "http://127.0.0.1:9" });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(1500);
  });

  it("allow → prints exactly the decision JSON; payload is trimmed below the body cap", async () => {
    const w = deciding({ status: "decided", behavior: "allow" });
    const r = await runHook({ AGENT_WORLD_URL: await fakeWorld(w.handler) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const posted = w.posted();
    expect(posted?.tool_name).toBe("Bash");
    expect(posted?.agent_world_hook).toBe(1);
    expect(JSON.stringify(posted).length).toBeLessThan(16_000);
  });

  it("deny carries the message", async () => {
    const w = deciding({ status: "decided", behavior: "deny", message: "not now" });
    const r = await runHook({ AGENT_WORLD_URL: await fakeWorld(w.handler) });
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not now" } },
    });
  });

  it("passthrough and expired → silent", async () => {
    for (const result of [{ status: "decided", behavior: "passthrough" }, { status: "expired" }]) {
      const r = await runHook({ AGENT_WORLD_URL: await fakeWorld(deciding(result).handler) });
      expect(r).toMatchObject({ code: 0, stdout: "" });
      await new Promise<void>((res) => server?.close(() => res()));
      server = null;
    }
  });

  it("no decision before the deadline → silent", async () => {
    const w = deciding({ status: "pending" }, 1_000_000);
    const r = await runHook({ AGENT_WORLD_URL: await fakeWorld(w.handler), AGENT_WORLD_DEADLINE_MS: "600" });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(3000);
  });

  it("toggle OFF (204) → silent, no polling", async () => {
    let polls = 0;
    const url = await fakeWorld((req, res) => {
      if (req.method === "POST") {
        res.writeHead(204);
        return res.end();
      }
      polls += 1;
      json(res, 200, { status: "decided", behavior: "allow" });
    });
    const r = await runHook({ AGENT_WORLD_URL: url });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(polls).toBe(0);
  });

  it("world error (500) or garbage stdin → silent", async () => {
    const url = await fakeWorld((_req, res) => json(res, 500, { ok: false }));
    expect(await runHook({ AGENT_WORLD_URL: url })).toMatchObject({ code: 0, stdout: "" });
    expect(await runHook({ AGENT_WORLD_URL: url }, "not json")).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("permission-request hook ↔ approvals feature (end to end)", () => {
  it("a world decision reaches Claude through the hook's stdout", async () => {
    const { createApprovalsFeature } = await import("../features/approvals.js");
    const { bootTestServer } = await import("./helpers.js");
    const { feature } = createApprovalsFeature();
    const { base, server: world } = await bootTestServer({ configOverrides: { features: [feature] } });
    try {
      const run = runHook({ AGENT_WORLD_URL: base });
      let id: string | undefined;
      for (let i = 0; i < 50 && !id; i++) {
        const list = (await (await fetch(`${base}/api/approvals`)).json()) as { pending: { id: string; preview: { title: string } }[] };
        id = list.pending[0]?.id;
        if (!id) await new Promise((r) => setTimeout(r, 50));
      }
      expect(id).toBeDefined();
      const decided = await fetch(`${base}/api/approvals/${id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behavior: "deny", message: "not on main" }),
      });
      expect(decided.status).toBe(200);
      const r = await run;
      expect(JSON.parse(r.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not on main" } },
      });
    } finally {
      await world.close();
    }
  });
});

// Regression: found during the design sweep 2026-09-24 — the orchestrator's own AskUserQuestion
// showed up in the world as a pending "approval". Questions are not permissions.
describe("hook skips questions to the user", () => {
  it("never contacts the world for AskUserQuestion", async () => {
    let hits = 0;
    const url = await fakeWorld((_req, res) => {
      hits++;
      json(res, 201, { id: "should-not-happen" });
    });
    const run = await runHook({ AGENT_WORLD_URL: url }, { ...INPUT, tool_name: "AskUserQuestion", tool_input: { questions: [] } });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(hits).toBe(0);
  });
});
