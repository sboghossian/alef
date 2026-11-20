import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPollResult } from "../../shared/features/approvals.js";
import { APPROVAL_EXPIRY_MS, ApprovalQueue, autoHoldReason, buildPreview, createApprovalsFeature } from "../features/approvals.js";
import { bootTestServer } from "./helpers.js";
import type { RunningServer } from "../index.js";
import { log } from "../log.js";

const SESSION = "0b7c1a4e-1111-4222-8333-444455556666";

describe("buildPreview", () => {
  it("Bash → command with description title; secrets redacted; control chars stripped", () => {
    const p = buildPreview("Bash", { command: "curl -H 'x: sk-ABCDEFGHIJKLMNOPQRSTUV' \u001b[2Jhttp://x", description: "Call API" }, "/r");
    expect(p.kind).toBe("command");
    expect(p.title).toBe("Call API");
    expect(p.body).toContain("[redacted]");
    expect(p.body).not.toContain("\u001b");
  });

  it("Edit → diff with -/+ lines and a cwd-relative title", () => {
    const p = buildPreview("Edit", { file_path: "/r/src/a.ts", old_string: "a\nb", new_string: "c" }, "/r");
    expect(p).toEqual({ kind: "diff", title: "src/a.ts", body: "- a\n- b\n+ c" });
  });

  it("truncates huge bodies", () => {
    const p = buildPreview("Write", { file_path: "/r/big.txt", content: "line\n".repeat(500) }, "/r");
    expect(p.body.split("\n").length).toBeLessThanOrEqual(61);
    expect(p.body.length).toBeLessThanOrEqual(2400);
  });

  it("unknown tools → generic JSON", () => {
    const p = buildPreview("mcp__linear__save_issue", { title: "x" }, "");
    expect(p.kind).toBe("generic");
    expect(p.body).toContain('"title": "x"');
  });
});

describe("autoHoldReason", () => {
  const bash = (command: string): string | null => autoHoldReason("Bash", { command });
  it("lets ordinary work through", () => {
    for (const c of ["ls -la", "npm test", "git push -u origin feat/x", "git commit -m 'main fix'", "vercel deploy", "rm -rf dist", "gh pr create --base main"]) {
      expect(bash(c), c).toBeNull();
    }
    expect(autoHoldReason("Edit", { file_path: "/r/a.ts" })).toBeNull();
    expect(autoHoldReason("mcp__linear__save_issue", {})).toBeNull();
  });
  it("holds Steph's hard stops, also inside a chained command", () => {
    for (const c of [
      "gh pr merge 12 --squash",
      "npm test && gh pr merge 12",
      "git push origin main",
      "git push origin HEAD:main",
      "git push --force origin feat/x",
      "git push -f",
      "git push --force-with-lease",
      "vercel --prod",
      "vercel deploy --prod --yes",
      "~/.alef-loop/bin/alef-live deploy",
    ]) {
      expect(bash(c), c).not.toBeNull();
    }
    expect(autoHoldReason("mcp__github__merge_pull_request", {})).not.toBeNull();
  });
});

describe("ApprovalQueue", () => {
  it("add → decide → poll; second decision rejected", () => {
    const q = new ApprovalQueue();
    const v = q.add({ agentId: SESSION, cwd: "/r", toolName: "Bash", preview: { kind: "command", title: "t", body: "b" } });
    expect(q.poll(v.id)).toEqual({ status: "pending" });
    expect(q.pendingAgents().has(SESSION)).toBe(true);
    expect(q.decide(v.id, "deny", "no")).toBe("ok");
    expect(q.poll(v.id)).toEqual({ status: "decided", behavior: "deny", message: "no" });
    expect(q.decide(v.id, "allow")).toBe("not-pending");
    expect(q.decide("nope", "allow")).toBe("not-found");
    expect(q.pendingAgents().size).toBe(0);
  });

  it("expires after the window and is forgotten later", () => {
    let now = 0;
    const q = new ApprovalQueue({ now: () => now, expiryMs: 65_000 });
    const v = q.add({ agentId: SESSION, cwd: "", toolName: "Bash", preview: { kind: "command", title: "", body: "" } });
    now = 64_999;
    expect(q.sweep()).toEqual([]);
    now = 65_000;
    expect(q.sweep().map((x) => x.id)).toEqual([v.id]);
    expect(q.poll(v.id)).toEqual({ status: "expired" });
    expect(q.decide(v.id, "allow")).toBe("expired"); // distinct from "not-pending" (decided by someone) — see the 410 route test
    now = 65_000 + 121_000;
    expect(q.poll(v.id)).toBeNull();
  });

  it("wait() resolves as soon as a decision lands", async () => {
    const q = new ApprovalQueue();
    const v = q.add({ agentId: SESSION, cwd: "", toolName: "Bash", preview: { kind: "command", title: "", body: "" } });
    const started = Date.now();
    const waiting = q.wait(v.id, 5000);
    setTimeout(() => q.decide(v.id, "allow"), 30);
    await waiting;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("decide() reports 'expired' for a timed-out request, distinct from not-found and not-pending", () => {
    let now = 0;
    const q = new ApprovalQueue({ now: () => now, expiryMs: 1000 });
    const v = q.add({ agentId: SESSION, cwd: "", toolName: "Bash", preview: { kind: "command", title: "", body: "" } });
    now = 1000;
    expect(q.decide(v.id, "allow")).toBe("expired");
    expect(q.decide(v.id, "allow")).toBe("expired"); // stays "expired", never flips to "not-pending"
    expect(q.decide("never-seen-id", "allow")).toBe("not-found");
  });

  it("expirySecondsLabel reflects this instance's own expiry", () => {
    expect(new ApprovalQueue({ expiryMs: 1000 }).expirySecondsLabel()).toBe("1s");
    expect(new ApprovalQueue().expirySecondsLabel()).toBe(`${APPROVAL_EXPIRY_MS / 1000}s`);
  });

  it("round-trips through JSON persistence", () => {
    const a = new ApprovalQueue();
    const v = a.add({ agentId: SESSION, cwd: "/r", toolName: "Bash", preview: { kind: "command", title: "t", body: "b" } });
    const b = new ApprovalQueue();
    b.load(a.toJSON());
    b.load("garbage");
    expect(b.pending().map((x) => x.id)).toEqual([v.id]);
  });
});

describe("approvals routes", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function boot(pollMaxMs = 300): Promise<string> {
    const { feature } = createApprovalsFeature({ pollMaxMs });
    const booted = await bootTestServer({ configOverrides: { features: [feature] } });
    server = booted.server;
    return booted.base;
  }
  const post = (base: string, path: string, body: unknown, contentType = "application/json"): Promise<Response> =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });

  it("full lifecycle: queue → long-poll pending → decide → poll decided", async () => {
    const base = await boot();
    const created = await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash", cwd: "/r", tool_input: { command: "ls" } });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const list = (await (await fetch(`${base}/api/approvals`)).json()) as { pending: { id: string }[] };
    expect(list.pending.map((p) => p.id)).toEqual([id]);

    const first = (await (await fetch(`${base}/api/approvals/${id}`)).json()) as ApprovalPollResult;
    expect(first).toEqual({ status: "pending" }); // long-poll returned after pollMaxMs

    const polling = fetch(`${base}/api/approvals/${id}`).then((r) => r.json() as Promise<ApprovalPollResult>);
    await new Promise((r) => setTimeout(r, 50));
    const decided = await post(base, `/api/approvals/${id}/decision`, { behavior: "allow" });
    expect(decided.status).toBe(200);
    expect(await polling).toEqual({ status: "decided", behavior: "allow" });
    expect((await post(base, `/api/approvals/${id}/decision`, { behavior: "deny" })).status).toBe(409);
  });

  it("validates decisions and payloads", async () => {
    const base = await boot();
    const { id } = (await (await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash" })).json()) as { id: string };
    expect((await post(base, `/api/approvals/${id}/decision`, { behavior: "maybe" })).status).toBe(400);
    expect((await post(base, `/api/approvals/${id}/decision`, { behavior: "allow", message: "x" })).status).toBe(400);
    expect((await post(base, `/api/approvals/${id}/decision`, { behavior: "deny", message: "x".repeat(501) })).status).toBe(400);
    expect((await post(base, `/api/approvals/unknown/decision`, { behavior: "allow" })).status).toBe(404);
    expect((await post(base, "/api/approvals", { session_id: "../etc", tool_name: "Bash" })).status).toBe(400);
    expect((await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash; rm" })).status).toBe(400);
    expect((await post(base, "/api/approvals", ["x"])).status).toBe(400);
    // guard: form posts are refused before reaching the feature
    expect((await post(base, "/api/approvals", {}, "text/plain")).status).toBe(415);
    expect((await fetch(`${base}/api/approvals/unknown`)).status).toBe(404);
  });

  it("auto-approve ON: allowed at once with no card; hard stops still queue; works with the toggle OFF", async () => {
    const base = await boot();
    expect((await post(base, "/api/approvals/settings", { autoApprove: "yes" })).status).toBe(400);
    expect((await post(base, "/api/approvals/settings", {})).status).toBe(400);
    expect(await (await post(base, "/api/approvals/settings", { autoApprove: true })).json()).toEqual({ enabled: true, autoApprove: true });

    const ok = await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm test" } });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };
    expect(await (await fetch(`${base}/api/approvals/${id}`)).json()).toEqual({ status: "decided", behavior: "allow" });

    const held = await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash", tool_input: { command: "git push origin main" } });
    const heldId = ((await held.json()) as { id: string }).id;
    const list = (await (await fetch(`${base}/api/approvals`)).json()) as { pending: { id: string }[] };
    expect(list.pending.map((p) => p.id)).toEqual([heldId]);

    // World toggle OFF: auto-approve still answers, a hard stop goes to the terminal (204).
    await post(base, "/api/approvals/settings", { enabled: false });
    expect((await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Write", tool_input: { file_path: "/r/a" } })).status).toBe(201);
    expect((await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash", tool_input: { command: "vercel --prod" } })).status).toBe(204);
    expect(await (await fetch(`${base}/api/approvals/settings`)).json()).toEqual({ enabled: false, autoApprove: true });
  });

  it("toggle OFF → POST answers 204 with no queue entry; settings round-trip", async () => {
    const base = await boot();
    expect(await (await fetch(`${base}/api/approvals/settings`)).json()).toEqual({ enabled: true, autoApprove: false });
    expect((await post(base, "/api/approvals/settings", { enabled: "no" })).status).toBe(400);
    expect(await (await post(base, "/api/approvals/settings", { enabled: false })).json()).toEqual({ enabled: false, autoApprove: false });
    const r = await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash" });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    const list = (await (await fetch(`${base}/api/approvals`)).json()) as { pending: unknown[]; enabled: boolean };
    expect(list).toEqual({ enabled: false, pending: [] });
  });

  it("a decision on an expired request is 410 (not 200/409), and the expiry is logged exactly once", async () => {
    let now = 0;
    const { feature } = createApprovalsFeature({ now: () => now, expiryMs: 1000, pollMaxMs: 50 });
    const booted = await bootTestServer({ configOverrides: { features: [feature] } });
    server = booted.server;
    const base = booted.base;
    const infoSpy = vi.spyOn(log, "info");
    try {
      const created = await post(base, "/api/approvals", { session_id: SESSION, tool_name: "Bash" });
      const { id } = (await created.json()) as { id: string };

      now = 1000; // exactly at this instance's expiry
      const decided = await post(base, `/api/approvals/${id}/decision`, { behavior: "allow" });
      expect(decided.status).toBe(410);
      expect(await decided.json()).toEqual({ ok: false, error: "Too late: that request expired and the terminal prompt took over." });

      const expiryLines = infoSpy.mock.calls.filter(([scope, msg]) => scope === "approvals" && typeof msg === "string" && msg.startsWith("expired "));
      expect(expiryLines).toHaveLength(1);
      expect(expiryLines[0]?.[1]).toBe(`expired Bash for ${SESSION.slice(0, 8)}: nobody answered in 1s, the terminal prompt took over`);

      // A second decision on the same (still-remembered) id must not log a second expiry.
      const again = await post(base, `/api/approvals/${id}/decision`, { behavior: "allow" });
      expect(again.status).toBe(410);
      expect(infoSpy.mock.calls.filter(([scope, msg]) => scope === "approvals" && typeof msg === "string" && msg.startsWith("expired "))).toHaveLength(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("a decision on an id the server never saw is still 404, not 410", async () => {
    const base = await boot();
    expect((await post(base, "/api/approvals/never-seen/decision", { behavior: "allow" })).status).toBe(404);
  });
});

describe("APPROVAL_EXPIRY_MS vs. the hook's own deadline", () => {
  it("stays at least 5s below hooks/permission-request.mjs's default DEADLINE_MS", async () => {
    const hookPath = fileURLToPath(new URL("../../hooks/permission-request.mjs", import.meta.url));
    const src = await readFile(hookPath, "utf8");
    const m = src.match(/DEADLINE_MS\s*=\s*Number\(process\.env\.AGENT_WORLD_DEADLINE_MS\)\s*\|\|\s*([0-9_]+)/);
    expect(m).not.toBeNull();
    const hookDefaultMs = Number(m![1]!.replace(/_/g, ""));
    expect(APPROVAL_EXPIRY_MS).toBeLessThanOrEqual(hookDefaultMs - 5000);
  });
});
