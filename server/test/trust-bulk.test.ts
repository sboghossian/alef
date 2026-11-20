// POST /api/trust/bulk (Health's "Trust these N folders"): a FAKE $HOME and its ~/.claude.json
// fixture only, never the real file. Each test checks what was written against the SAFETY
// INVARIANT in server/features/trust.ts: confirm required, only paths from the current
// untrusted-targets list, one by one through the single-folder grant, honest per-path outcomes.

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrustBulkResult, TrustTargetsResponse } from "../../shared/features/trust.js";
import type { RunningServer } from "../index.js";
import { createTrustFeature, type TrustFeatureOptions } from "../features/trust.js";
import { onlyTrustKeyChanged } from "../features/trust-lib.js";
import { bootTestServer } from "./helpers.js";

const DISTRICTS = ["acme-www", "legal-taxonomy", "new-repo"] as const;

/** ~/.claude.json's real key names (values made up), with three untrusted district folders. */
function fixtureConfig(home: string): Record<string, unknown> {
  return {
    numStartups: 812,
    theme: "dark",
    oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000000", emailAddress: "redacted@example.com" },
    projects: {
      [join(home, "Documents")]: { allowedTools: [], hasTrustDialogAccepted: true, lastCost: 1.5 },
      [join(home, "Documents/Code/acme-www")]: { allowedTools: ["Bash(npm test)"], hasTrustDialogAccepted: false, lastSessionFirstPrompt: "Réécris la FAQ ✓" },
      [join(home, "Documents/Code/legal-taxonomy")]: { allowedTools: [], lastCost: 0 },
    },
    userID: "redacted",
  };
}

interface Booted {
  base: string;
  home: string;
  claudeJson: string;
  server: RunningServer;
  path: (name: string) => string;
}

let booted: Booted | null = null;

afterEach(async () => {
  if (!booted) return;
  await booted.server.close();
  await rm(booted.home, { recursive: true, force: true });
  booted = null;
});

async function boot(opts: TrustFeatureOptions = {}): Promise<Booted> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "aw-trust-bulk-")));
  const claudeJson = join(home, ".claude.json");
  const path = (name: string): string => join(home, "Documents/Code", name);
  // Git repos: the trusted ~/Documents above them doesn't count (Claude Code stops at the repo root).
  for (const d of DISTRICTS) await mkdir(join(path(d), ".git"), { recursive: true });
  await mkdir(join(home, "Documents/Code/not-a-district"), { recursive: true });
  await writeFile(claudeJson, JSON.stringify(fixtureConfig(home), null, 2), { encoding: "utf8", mode: 0o600 });
  const b = await bootTestServer({
    configOverrides: {
      claudeJsonPath: claudeJson,
      features: [createTrustFeature({ homeDir: home, sleep: async () => {}, now: () => new Date("2026-09-29T09:00:00Z"), ...opts })],
    },
  });
  const db = b.server.db;
  const cwds: Array<[string, string]> = [...DISTRICTS.map((d): [string, string] => [path(d), d]), [join(home, "Documents"), "documents"], [home, "home"]];
  for (const [i, [cwd, id]] of cwds.entries()) {
    db.setIslandForCwd(cwd, id);
    db.upsertSession({ id: `00000000-0000-4000-8000-00000000000${i}`, cwd, islandId: id, title: id, startedAt: "2026-09-27T00:00:00Z", lastActive: "2026-09-27T00:00:00Z", jsonlMtime: 0, messageCountDelta: 1, model: null, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 0, cntAssistantTotalDelta: 0 });
  }
  booted = { base: b.base, home, claudeJson, server: b.server, path };
  return booted;
}

async function bulk(b: Booted, body: unknown): Promise<{ status: number; body: TrustBulkResult }> {
  const res = await fetch(`${b.base}/api/trust/bulk`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as TrustBulkResult };
}

async function targets(b: Booted): Promise<string[]> {
  const r = (await (await fetch(`${b.base}/api/trust/targets`)).json()) as TrustTargetsResponse;
  return r.untrusted.map((t) => t.cwd);
}

async function projects(b: Booted): Promise<Record<string, Record<string, unknown>>> {
  return (JSON.parse(await readFile(b.claudeJson, "utf8")) as { projects: Record<string, Record<string, unknown>> }).projects;
}

describe("trust-targets counts only districts sessions sit on (2026-10-14: 71 of 104)", () => {
  it("never lists, or bulk-trusts, a folder only touched files sit on", async () => {
    const b = await boot();
    const phantom = join(b.home, "decks", "gov5"); // an existing folder under $HOME no trust covers
    await mkdir(phantom, { recursive: true });
    b.server.db.setIslandForCwd(phantom, "phantom");
    b.server.db.upsertObjectShell({ id: `file:${join(phantom, "deck.html")}`, kind: "file", name: "deck.html", islandId: "phantom" });
    const r = (await (await fetch(`${b.base}/api/trust/targets`)).json()) as TrustTargetsResponse;
    expect(r.untrusted.map((t) => t.cwd)).toEqual(DISTRICTS.map(b.path));
    expect(r.checked).toBe(DISTRICTS.length + 1); // the districts + ~/Documents; $HOME never
    const out = await bulk(b, { paths: [phantom], confirm: true });
    expect(out.body.results).toEqual([{ path: phantom, outcome: "refused", error: "not in the current list of untrusted launch targets" }]);
    expect(Object.keys(await projects(b))).not.toContain(phantom);
  });
});

describe("POST /api/trust/bulk (fake $HOME)", () => {
  it("lists the three untrusted districts, then one click trusts exactly them, one key each", async () => {
    const b = await boot();
    const listed = await targets(b);
    expect(listed).toEqual(DISTRICTS.map(b.path)); // ~/Documents is trusted, $HOME is never a target
    const before = JSON.parse(await readFile(b.claudeJson, "utf8")) as { projects: Record<string, unknown> };
    const r = await bulk(b, { paths: listed, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, trusted: 3, already: 0, refused: 0 });
    expect(r.body.results.map((x) => [x.path, x.outcome])).toEqual(listed.map((p) => [p, "trusted"]));
    expect(await targets(b)).toEqual([]);
    // Structurally: only the three trust keys changed (one existing false→true, one added, one new default entry).
    const after = JSON.parse(await readFile(b.claudeJson, "utf8")) as { projects: Record<string, unknown> };
    const { [b.path("acme-www")]: _a, [b.path("legal-taxonomy")]: _b, [b.path("new-repo")]: _c, ...restAfter } = after.projects;
    const { [b.path("acme-www")]: _d, [b.path("legal-taxonomy")]: _e, ...restBefore } = before.projects;
    expect(restAfter).toEqual(restBefore);
    expect({ ...after, projects: {} }).toEqual({ ...before, projects: {} });
    expect((await projects(b))[b.path("acme-www")]).toEqual({ allowedTools: ["Bash(npm test)"], hasTrustDialogAccepted: true, lastSessionFirstPrompt: "Réécris la FAQ ✓" });
    expect((await stat(b.claudeJson)).mode & 0o777).toBe(0o600);
    // One safety copy for the day, not one per folder.
    expect(await readdir(join(b.home, ".alef-trash", "2026-09-29", "claude-json"))).toHaveLength(1);
  });

  it("refuses without confirm:true, and on a malformed body: nothing written", async () => {
    const b = await boot();
    const bytes = await readFile(b.claudeJson, "utf8");
    const listed = await targets(b);
    for (const body of [{ paths: listed }, { paths: listed, confirm: "true" }, { paths: listed, confirm: false }, { paths: [], confirm: true }, { paths: "x", confirm: true }, { paths: [1], confirm: true }]) {
      const r = await bulk(b, body);
      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
      expect(r.body.results).toEqual([]);
    }
    expect(await readFile(b.claudeJson, "utf8")).toBe(bytes);
  });

  it("no arbitrary paths: anything outside the current untrusted list is refused and never written", async () => {
    const b = await boot();
    const r = await bulk(b, {
      paths: [b.path("acme-www"), join(b.home, "Documents/Code/not-a-district"), b.home, "/etc", "relative/path", join(b.home, "Documents")],
      confirm: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, trusted: 1, already: 1, refused: 4 });
    const outcome = Object.fromEntries(r.body.results.map((x) => [x.path, x.error ?? x.outcome]));
    expect(outcome).toEqual({
      [b.path("acme-www")]: "trusted",
      [join(b.home, "Documents/Code/not-a-district")]: "not in the current list of untrusted launch targets",
      [b.home]: "refusing to trust your whole home folder or /: pick a project folder", // a district, never a target
      "/etc": "not in the current list of untrusted launch targets",
      "relative/path": "not in the current list of untrusted launch targets",
      [join(b.home, "Documents")]: "already", // a district Claude already trusts: nothing written
    });
    expect(r.body.error).toContain("4 of 6 folders not trusted");
    const p = await projects(b);
    expect(p[join(b.home, "Documents/Code/not-a-district")]).toBeUndefined();
    expect(p[b.home]).toBeUndefined();
    expect(p["/etc"]).toBeUndefined();
    expect(p[b.path("acme-www")]?.hasTrustDialogAccepted).toBe(true);
  });

  it("partial failure: a folder deleted mid-run is refused with its reason, the others are trusted, ok:false", async () => {
    let writes = 0;
    const b = await boot({
      beforeRename: async () => {
        writes++;
        if (writes === 1 && booted) await rm(booted.path("new-repo"), { recursive: true, force: true });
      },
    });
    const listed = await targets(b);
    const r = await bulk(b, { paths: listed, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, trusted: 2, already: 0, refused: 1 });
    expect(r.body.results.find((x) => x.path === b.path("new-repo"))).toEqual({ path: b.path("new-repo"), outcome: "refused", error: "folder not found" });
    expect(r.body.error).toBe(`1 of 3 folders not trusted: ${b.path("new-repo")} (folder not found)`);
    const p = await projects(b);
    expect(p[b.path("acme-www")]?.hasTrustDialogAccepted).toBe(true);
    expect(p[b.path("legal-taxonomy")]?.hasTrustDialogAccepted).toBe(true);
    expect(p[b.path("new-repo")]).toBeUndefined();
  });

  it("a concurrent write by Claude Code mid-run is kept: the write starts over from Claude's version", async () => {
    let raced = false;
    const b = await boot({
      beforeRename: async () => {
        if (raced || !booted) return;
        raced = true; // Claude Code rewrites the file between Alef's read and its rename
        const cur = JSON.parse(await readFile(booted.claudeJson, "utf8")) as Record<string, unknown> & { projects: Record<string, unknown> };
        cur.numStartups = 813;
        cur.projects[join(booted.home, "Documents/Code/fresh")] = { allowedTools: [], lastCost: 2 };
        await writeFile(booted.claudeJson, JSON.stringify(cur, null, 2), "utf8");
      },
    });
    const listed = await targets(b);
    const r = await bulk(b, { paths: listed, confirm: true });
    expect(r.body).toMatchObject({ ok: true, trusted: 3, refused: 0 });
    const after = JSON.parse(await readFile(b.claudeJson, "utf8")) as { numStartups: number; projects: Record<string, Record<string, unknown>> };
    expect(after.numStartups).toBe(813); // Claude's own change survived
    expect(after.projects[join(b.home, "Documents/Code/fresh")]).toEqual({ allowedTools: [], lastCost: 2 });
    for (const d of DISTRICTS) expect(after.projects[b.path(d)]?.hasTrustDialogAccepted).toBe(true);
  });

  it("Claude Code holding its lock: every folder refused with the reason, the file untouched, the lock left alone", async () => {
    const b = await boot();
    const bytes = await readFile(b.claudeJson, "utf8");
    await mkdir(`${b.claudeJson}.lock`);
    const r = await bulk(b, { paths: await targets(b), confirm: true });
    expect(r.body).toMatchObject({ ok: false, trusted: 0, refused: 3 });
    expect(r.body.results.every((x) => x.outcome === "refused" && (x.error ?? "").includes("its lock is held"))).toBe(true);
    expect(await readFile(b.claudeJson, "utf8")).toBe(bytes);
    expect((await stat(`${b.claudeJson}.lock`)).isDirectory()).toBe(true);
  });

  it("a folder Claude trusted between the list and the click reads as already, nothing written for it", async () => {
    const b = await boot();
    const listed = await targets(b);
    const cur = JSON.parse(await readFile(b.claudeJson, "utf8")) as { projects: Record<string, Record<string, unknown>> };
    const before = JSON.parse(JSON.stringify(cur)) as unknown;
    cur.projects[b.path("acme-www")]!.hasTrustDialogAccepted = true; // answered in Terminal meanwhile
    expect(onlyTrustKeyChanged(before, cur, b.path("acme-www"))).toBe(true);
    await writeFile(b.claudeJson, JSON.stringify(cur, null, 2), "utf8");
    const r = await bulk(b, { paths: listed, confirm: true });
    // The server's own list no longer has it, and Claude trusts it: "already", not a refusal.
    expect(r.body).toMatchObject({ ok: true, trusted: 2, already: 1, refused: 0 });
    expect(r.body.results.find((x) => x.path === b.path("acme-www"))).toEqual({ path: b.path("acme-www"), outcome: "already" });
    expect(await readFile(b.claudeJson, "utf8")).toContain('"hasTrustDialogAccepted": true');
  });

  it("only one bulk request at a time: a second one gets 409 and writes nothing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const inFirstWrite = new Promise<void>((r) => {
      entered = r;
    });
    const b = await boot({
      beforeRename: async () => {
        entered();
        await gate;
      },
    });
    const listed = await targets(b);
    const first = bulk(b, { paths: listed, confirm: true });
    await inFirstWrite;
    const second = await bulk(b, { paths: listed, confirm: true });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ ok: false, results: [] });
    release();
    expect((await first).body).toMatchObject({ ok: true, trusted: 3 });
  });
});
