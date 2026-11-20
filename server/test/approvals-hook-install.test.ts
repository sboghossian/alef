// FN-2: installing the approvals hook from Health (preview diff, then an explicit Install) and from
// scripts/install-approvals-hook.mjs --apply. Every write goes to a temp settings.json / temp HOME,
// never the real ~/.claude.

import { execFileSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVALS_INSTALL_LABEL, type ApprovalsHookInstallPlan, type ApprovalsHookInstallResult } from "../../shared/features/completeness.js";
import { applyApprovalsHookInstall, approvalsHookCommand, lineDiff, planApprovalsHookInstall, previewApprovalsHookInstall, type InstallDeps } from "../features/approvals-hook-install.js";
import { createCompletenessFeature, readApprovalsHookInstalled } from "../features/completeness.js";
import type { FeatureContext, Route } from "../features/registry.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(REPO, "hooks", "permission-request.mjs");
const CMD = approvalsHookCommand("/usr/local/bin/node", HOOK);
const EXISTING = `${JSON.stringify({ model: "opus", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "x.py" }] }] } }, null, 2)}\n`;

describe("planApprovalsHookInstall (pure)", () => {
  it("appends one PermissionRequest entry, keeps everything else, and shows only that in the diff", () => {
    const plan = planApprovalsHookInstall(EXISTING, CMD, false, "/tmp/s.json");
    expect(plan.status).toBe("ready");
    const after = JSON.parse(plan.after ?? "{}") as { model: string; hooks: Record<string, unknown> };
    expect(after.model).toBe("opus");
    expect(after.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: "x.py" }] }]);
    expect(after.hooks.PermissionRequest).toEqual([{ matcher: "", hooks: [{ type: "command", command: CMD, timeout: 70 }] }]);
    expect(plan.diff.some((l) => l.kind === "+" && l.text.includes("permission-request.mjs"))).toBe(true);
  });

  it("already installed: nothing to do; invalid JSON: refused, never overwritten", () => {
    expect(planApprovalsHookInstall(EXISTING, CMD, true, "/tmp/s.json")).toMatchObject({ ok: true, status: "already", diff: [] });
    expect(planApprovalsHookInstall("{ nope", CMD, false, "/tmp/s.json")).toMatchObject({ ok: false, status: "error" });
    expect(planApprovalsHookInstall("[1,2]", CMD, false, "/tmp/s.json")).toMatchObject({ ok: false, status: "error" });
  });

  it("no settings.json yet: the whole new file is the diff", () => {
    const plan = planApprovalsHookInstall(null, CMD, false, "/tmp/s.json");
    expect(plan.status).toBe("ready");
    expect(plan.diff.every((l) => l.kind === "+")).toBe(true);
  });

  it("lineDiff keeps two lines of context around a pure insertion", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nb\nX\nc\nd")).toEqual([
      { kind: " ", text: "a" },
      { kind: " ", text: "b" },
      { kind: "+", text: "X" },
      { kind: " ", text: "c" },
      { kind: " ", text: "d" },
    ]);
  });
});

describe("preview / apply on a temp settings.json", () => {
  let dir = "";
  let settingsPath = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-approvals-install-"));
    settingsPath = join(dir, ".claude", "settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, EXISTING, "utf8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const deps = (): InstallDeps => ({ settingsPath, command: CMD, isInstalled: () => readApprovalsHookInstalled(dirname(settingsPath), HOOK), now: () => Date.parse("2026-10-27T08:00:00.000Z") });

  it("preview writes nothing and never ships the whole file", async () => {
    const plan = await previewApprovalsHookInstall(deps());
    expect(plan.status).toBe("ready");
    expect(plan.after).toBeUndefined();
    expect(await readFile(settingsPath, "utf8")).toBe(EXISTING);
    expect(await readdir(dirname(settingsPath))).toEqual(["settings.json"]);
  });

  it("apply backs up first, writes, and the Health check then reads it as installed; a second apply is a no-op", async () => {
    const r = await applyApprovalsHookInstall(deps());
    expect(r).toMatchObject({ ok: true, status: "installed" });
    expect(r.backupPath).toBe(`${settingsPath}.bak-2026-10-27T08-00-00-000Z`);
    expect(await readFile(r.backupPath ?? "", "utf8")).toBe(EXISTING);
    expect(await readApprovalsHookInstalled(dirname(settingsPath), HOOK)).toBe(true);
    expect(await applyApprovalsHookInstall(deps())).toMatchObject({ ok: true, status: "already", backupPath: null });
    expect((await readdir(dirname(settingsPath))).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });

  it("refuses a settings.json that isn't JSON and leaves it untouched", async () => {
    await writeFile(settingsPath, "{ broken", "utf8");
    expect(await applyApprovalsHookInstall(deps())).toMatchObject({ ok: false, status: "error" });
    expect(await readFile(settingsPath, "utf8")).toBe("{ broken");
  });
});

// ── the routes, through the real completeness feature (claudeDir = temp) ─────────

function fakeRes(): { res: ServerResponse; status: () => number; json: <T>() => T } {
  let statusCode = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      statusCode = code;
      return res;
    },
    end(data: string) {
      body = data;
    },
  };
  return { res: res as unknown as ServerResponse, status: () => statusCode, json: <T>() => JSON.parse(body) as T };
}

async function call<T>(route: Route | undefined, ctx: FeatureContext, body?: unknown): Promise<{ status: number; body: T }> {
  if (!route) throw new Error("route not found");
  const { res, status, json } = fakeRes();
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  await route.handler(req as never, res, ctx, {});
  return { status: status(), body: json<T>() };
}

describe("GET/POST /api/completeness/approvals-hook/install", () => {
  let dir = "";
  let ctx: FeatureContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-approvals-route-"));
    await writeFile(join(dir, "settings.json"), EXISTING, "utf8");
    ctx = { config: { claudeDir: dir, dbPath: join(dir, "world.db") }, log: { info: () => {}, warn: () => {}, error: () => {} }, emit: () => {} } as unknown as FeatureContext;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const feature = createCompletenessFeature();
  const route = (method: string): Route | undefined => feature.routes?.find((r) => r.method === method && r.path === "/api/completeness/approvals-hook/install");

  it("GET is a dry run; POST without confirm is refused; POST with confirm writes after a backup", async () => {
    const preview = await call<ApprovalsHookInstallPlan>(route("GET"), ctx);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ ok: true, status: "ready", settingsPath: join(dir, "settings.json") });
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(EXISTING);

    const refused = await call<ApprovalsHookInstallResult>(route("POST"), ctx, {});
    expect(refused.status).toBe(400);
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(EXISTING);

    const done = await call<ApprovalsHookInstallResult>(route("POST"), ctx, { confirm: true });
    expect(done.body).toMatchObject({ ok: true, status: "installed" });
    expect((await readdir(dir)).some((f) => f.startsWith("settings.json.bak-"))).toBe(true);
    expect(await readApprovalsHookInstalled(dir, HOOK)).toBe(true);
  });

  it("the failing check offers the install preview as its fix", () => {
    expect(APPROVALS_INSTALL_LABEL).toBe("Install (preview diff)");
  });
});

describe("scripts/install-approvals-hook.mjs (temp HOME)", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-approvals-script-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), EXISTING, "utf8");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = (...args: string[]): string => execFileSync(process.execPath, [join(REPO, "scripts", "install-approvals-hook.mjs"), ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });

  it("dry run prints the diff and writes nothing; --apply backs up then writes; a rerun is a no-op", async () => {
    expect(run()).toContain("Dry run");
    expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toBe(EXISTING);
    expect(run("--apply")).toContain("Backed up the previous settings.json");
    const files = await readdir(join(home, ".claude"));
    const backup = files.find((f) => f.startsWith("settings.json.bak-"));
    expect(backup).toBeDefined();
    expect(await readFile(join(home, ".claude", backup ?? ""), "utf8")).toBe(EXISTING);
    expect(await readApprovalsHookInstalled(join(home, ".claude"), HOOK)).toBe(true);
    expect(run("--apply")).toContain("nothing to do");
  });
});
