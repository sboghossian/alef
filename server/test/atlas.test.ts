import { chmod, link, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AtlasResponse } from "../../shared/features/atlas.js";
import { createAtlasFeature, type AtlasFeatureDeps } from "../features/atlas.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

const BUNDLE_SECRET = "the orange heron sleeps under bridge nine";
const MEMORY_SECRET = "private dinner with nobody on tuesday";
const POST_JSON = { method: "POST", headers: { "content-type": "application/json" } };

const emptySources: AtlasFeatureDeps["sources"] = {
  skills: async () => ({ installed: [], usage: [], candidates: [], historyReady: true }),
  automations: async () => [],
  workers: () => [],
  subagents: () => [],
};

async function mkCli(home: string, dir: string, entry: string): Promise<void> {
  await mkdir(join(home, ".claude", "clis", dir), { recursive: true });
  const cli = { name: dir, tool: "t", purpose: "p", entry, language: "sh", created: "2026-09-30", author: "agent", tests: null };
  await writeFile(join(home, ".claude", "clis", dir, "cli.json"), JSON.stringify(cli));
}

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "atlas-home-"));
  const memory = join(home, ".claude", "projects", home.replace(/[\\/]/g, "-"), "memory");
  await mkdir(join(memory, "_L2"), { recursive: true });
  await writeFile(join(memory, "_L2", "acme-gtm.md"), `# GTM\n${BUNDLE_SECRET}. Ship with /pitch-deck and /pitch-deck.\n`);
  await writeFile(join(memory, "_L2", "rituals.md"), `${BUNDLE_SECRET}\nmorning: /pitch-deck\n`);
  await writeFile(join(memory, "_L2", "alex-context.md"), "/pitch-deck /pitch-deck /pitch-deck personal");
  await writeFile(join(memory, "MEMORY.md"), "index");
  await writeFile(join(memory, "user_note.md"), `---\nname: n\n---\n${MEMORY_SECRET}`);
  await mkdir(join(home, ".claude", "agents"), { recursive: true });
  await writeFile(join(home, ".claude", "agents", "scout.md"), "---\nname: scout\ndescription: Finds things\n---\nbody text");
  await mkdir(join(home, "tools"), { recursive: true });
  await writeFile(join(home, "tools", "ok.sh"), "echo ok");
  await mkCli(home, "fine", join(home, "tools", "ok.sh"));
  return home;
}

describe("atlas feature: wired into a real server", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("files leaves by bundle mentions and never returns bundle or memory text", async () => {
    const home = await fixtureHome();
    const feature = createAtlasFeature({
      home,
      sources: {
        ...emptySources,
        skills: async () => ({
          installed: [{ slug: "pitch-deck", name: "pitch-deck", description: "Builds decks", origin: "user", pluginId: null, path: "/s/pitch-deck/SKILL.md", updatedAt: null }],
          usage: [],
          candidates: [],
          historyReady: true,
        }),
      },
    });
    const boot = await bootTestServer({ configOverrides: { features: [feature] } });
    server = boot.server;
    const res = await fetch(`${boot.base}/api/atlas`);
    const raw = await res.text();
    const body = JSON.parse(raw) as AtlasResponse;

    expect(res.status).toBe(200);
    expect(body.hub).toEqual({ memoryFiles: 1, bundles: 2 }); // alex-context is never read
    expect(body.pending).toEqual([]);
    expect(body.leaves.find((l) => l.id === "skill:pitch-deck")).toMatchObject({ dept: "acme-gtm", reason: "mentioned 2× in ACME GTM", canOpen: false });
    expect(body.leaves.find((l) => l.id === "agent:scout")).toMatchObject({ description: "Finds things", path: join(home, ".claude", "agents", "scout.md"), canOpen: true });
    expect(body.leaves.find((l) => l.id === "cli:fine")?.canOpen).toBe(true);
    expect(raw).not.toContain(BUNDLE_SECRET);
    expect(raw).not.toContain("orange heron");
    expect(raw).not.toContain(MEMORY_SECRET);
    expect(raw).not.toContain("body text");
  });

  it("empty or missing dirs: 200 with no leaves, memory unknown; unread sources are listed as pending", async () => {
    const home = await mkdtemp(join(tmpdir(), "atlas-empty-"));
    const sources = { ...emptySources, workers: () => null, subagents: () => null };
    const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home, sources })] } });
    server = boot.server;
    const body = (await (await fetch(`${boot.base}/api/atlas`)).json()) as AtlasResponse;
    expect(body).toMatchObject({ ok: true, leaves: [], hub: { memoryFiles: null, bundles: 0 }, pending: ["Tower runs", "subagent runs"] });
    expect(body.departments).toHaveLength(9);
  });

  it("a paused job reads as paused from the first answer, before the routines feature ever ticked (review M2)", async () => {
    const home = await mkdtemp(join(tmpdir(), "atlas-boot-"));
    const job = { id: "eulex-bench", kind: "launchd" as const, launchdLabel: "com.stephane.eulex-bench", skill: null, schedule: "daily 06:17", description: null, lastRunAt: null };
    const sources = { ...emptySources, automations: async () => [{ ...job, loaded: false }, { ...job, id: "unread", launchdLabel: "com.stephane.unread" }] };
    const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home, sources })] } });
    server = boot.server;
    const body = (await (await fetch(`${boot.base}/api/atlas`)).json()) as AtlasResponse;
    expect(body.leaves.find((l) => l.id === "routine:eulex-bench")).toMatchObject({ autonomy: "manual", evidence: "paused: launchd has not loaded com.stephane.eulex-bench" });
    expect(body.leaves.find((l) => l.id === "routine:unread")?.autonomy).toBeNull();
    expect(body.pending).toEqual(["launchd load state"]);
  });

  it("a stuck source can't hang the route: 503 after the build timeout (review L4)", async () => {
    const home = await mkdtemp(join(tmpdir(), "atlas-stuck-"));
    const sources = { ...emptySources, automations: () => new Promise<never>(() => undefined) };
    const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home, sources, buildTimeoutMs: 200 })] } });
    server = boot.server;
    const res = await fetch(`${boot.base}/api/atlas`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/atlas scan took over/);
  });

  it("retries while a build is stuck join it: no second build is started", async () => {
    const home = await mkdtemp(join(tmpdir(), "atlas-join-"));
    let builds = 0;
    const sources = { ...emptySources, automations: () => (builds++, new Promise<never>(() => undefined)) };
    const boot = await bootTestServer({ configOverrides: { features: [createAtlasFeature({ home, sources, buildTimeoutMs: 150 })] } });
    server = boot.server;
    for (let i = 0; i < 3; i++) expect((await fetch(`${boot.base}/api/atlas`)).status).toBe(503);
    expect((await fetch(`${boot.base}/api/atlas/open/agent%3Ax`, POST_JSON)).status).toBe(503);
    expect(builds).toBe(1);
  });

  it("POST open: a CLI entry opens only as a script or an executable; credentials and hard links never", async () => {
    const home = await fixtureHome();
    const put = async (rel: string, body = "x", mode = 0o644): Promise<string> => {
      const abs = join(home, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, body);
      await chmod(abs, mode);
      return abs;
    };
    await mkCli(home, "vault-note", await put("Documents/vault/10-Sessions/private.md", "a private note"));
    await mkCli(home, "data", await put("tools/data.txt"));
    await mkCli(home, "runner", await put("tools/runner", "#!/bin/sh", 0o755));
    // real credential files, made executable so only the secret list can refuse them
    const creds = [".git-credentials", ".config/gh/hosts.yml", ".docker/config.json", ".kube/config", ".claude.json"];
    for (const [i, rel] of creds.entries()) await mkCli(home, `cred${i}`, await put(rel, "token", 0o755));
    await link(await put(".ssh/id_ed25519", "k", 0o600), join(home, ".claude", "agents", "innocent.md"));
    const opened: string[] = [];
    const boot = await bootTestServer({ openEditorExecutor: (p) => void opened.push(p), configOverrides: { features: [createAtlasFeature({ home, sources: emptySources })] } });
    server = boot.server;
    const body = (await (await fetch(`${boot.base}/api/atlas`)).json()) as AtlasResponse;
    const canOpen = (id: string): boolean | undefined => body.leaves.find((l) => l.id === id)?.canOpen;
    const open = async (id: string): Promise<number> => (await fetch(`${boot.base}/api/atlas/open/${encodeURIComponent(id)}`, POST_JSON)).status;

    const refused = ["cli:vault-note", "cli:data", ...creds.map((_, i) => `cli:cred${i}`), "agent:innocent"];
    for (const id of refused) {
      expect(canOpen(id), id).toBe(false);
      expect(await open(id), id).toBe(403);
    }
    expect(opened).toEqual([]);
    expect(canOpen("cli:runner")).toBe(true);
    expect(await open("cli:runner")).toBe(200);
    expect(opened).toEqual([join(await realpath(home), "tools", "runner")]);
  });

  it("POST open: only a real file inside its kind's root, re-checked at click time (review M1)", async () => {
    const home = await fixtureHome();
    const outside = await mkdtemp(join(tmpdir(), "atlas-outside-"));
    await writeFile(join(outside, "target.md"), "x");
    await symlink(join(outside, "target.md"), join(home, ".claude", "agents", "linked.md"));
    await writeFile(join(home, ".claude", "agents", "id_rsa.md"), "---\nname: keyish\n---\n");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await writeFile(join(home, ".ssh", "id_ed25519"), "k");
    await mkdir(join(home, ".config", "x"), { recursive: true });
    await writeFile(join(home, ".config", "x", ".env"), "A=1");
    await writeFile(join(outside, "tool.sh"), "x");
    await mkCli(home, "secret", join(home, ".ssh", "id_ed25519"));
    await mkCli(home, "envfile", join(home, ".config", "x", ".env"));
    await mkCli(home, "rootdir", "/");
    await mkCli(home, "folder", join(home, "tools"));
    await mkCli(home, "elsewhere", join(outside, "tool.sh"));
    await mkCli(home, "sneaky", "--install-extension=x");
    const opened: string[] = [];
    const feature = createAtlasFeature({ home, sources: emptySources });
    const boot = await bootTestServer({ openEditorExecutor: (p) => void opened.push(p), configOverrides: { features: [feature] } });
    server = boot.server;
    const open = async (id: string): Promise<number> => (await fetch(`${boot.base}/api/atlas/open/${encodeURIComponent(id)}`, POST_JSON)).status;

    const body = (await (await fetch(`${boot.base}/api/atlas`)).json()) as AtlasResponse;
    const refused = ["cli:secret", "cli:envfile", "cli:rootdir", "cli:folder", "cli:elsewhere", "cli:sneaky", "agent:linked", "agent:id_rsa"];
    for (const id of refused) expect(body.leaves.find((l) => l.id === id)?.canOpen, id).toBe(false);
    const statuses = Object.fromEntries(await Promise.all(refused.map(async (id) => [id, await open(id)] as const)));
    expect(statuses).toEqual({ "cli:secret": 403, "cli:envfile": 403, "cli:rootdir": 403, "cli:folder": 400, "cli:elsewhere": 403, "cli:sneaky": 404, "agent:linked": 403, "agent:id_rsa": 403 });
    expect(await open("/etc/passwd")).toBe(404);
    expect(opened).toEqual([]);

    expect(await open("agent:scout")).toBe(200);
    expect(await open("cli:fine")).toBe(200);
    const real = await realpath(home); // macOS tmp dirs sit behind /var → /private/var: the route opens the real path
    expect(opened).toEqual([join(real, ".claude", "agents", "scout.md"), join(real, "tools", "ok.sh")]);

    // the global guards still apply: text/plain and a foreign Origin never reach the route
    expect((await fetch(`${boot.base}/api/atlas/open/${encodeURIComponent("agent:scout")}`, { method: "POST", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await fetch(`${boot.base}/api/atlas/open/${encodeURIComponent("agent:scout")}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" } })).status).toBe(403);
    expect(opened).toHaveLength(2);
  });
});

