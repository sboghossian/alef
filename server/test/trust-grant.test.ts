// Granting Claude Code folder trust writes ONE key of a ~/.claude.json fixture in a fake $HOME,
// never the real file. Every test checks the rest of the file byte for byte.

import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrustGrantResult, TrustTargetsResponse } from "../../shared/features/trust.js";
import type { RunningServer } from "../index.js";
import { createTrustFeature } from "../features/trust.js";
import {
  defaultTrustedProjectEntry,
  grantFolderTrust,
  onlyTrustKeyChanged,
  roundTripIndent,
  TRUST_WRITE_TRIES,
  validateTrustCwd,
  writeFolderTrust,
  type TrustWriteDeps,
} from "../features/trust-lib.js";
import { folderTrust } from "../trust.js";
import { bootTestServer } from "./helpers.js";

/** The real file's shape (key names from 2026-09-28's ~/.claude.json), values made up: no tokens. */
function fixtureConfig(home: string): Record<string, unknown> {
  return {
    numStartups: 812,
    installMethod: "native",
    autoUpdates: false,
    theme: "dark",
    tipsHistory: { "new-user-warmup": 7, "shift-enter": 3 },
    oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000000", emailAddress: "redacted@example.com", organizationUuid: "redacted" },
    customApiKeyResponses: { approved: [], rejected: ["redacted"] },
    cachedGrowthBookFeatures: { some_flag: true, some_number: 0.25, big: 1234567890123 },
    projects: {
      [join(home, "Documents")]: { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true, lastCost: 1.5 },
      [join(home, "Documents/Code/acme-www")]: {
        allowedTools: ["Bash(npm test)"],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: false,
        hasClaudeMdExternalIncludesApproved: false,
        lastSessionFirstPrompt: "Réécris la FAQ — «chiffrement de bout en bout» ✓",
        lastModelUsage: { "claude-x": { inputTokens: 10, costUSD: 0.000123 } },
      },
      [join(home, "Documents/Code/legal-taxonomy")]: { allowedTools: [], lastCost: 0 },
    },
    userID: "redacted",
  };
}

describe("folder trust grant (trust-lib.ts)", () => {
  let home = "";
  let claudeJson = "";
  let deps: TrustWriteDeps;
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "aw-trust-home-")));
    claudeJson = join(home, ".claude.json");
    await mkdir(join(home, "Documents/Code/acme-www/.git"), { recursive: true });
    await mkdir(join(home, "Documents/Code/legal-taxonomy"), { recursive: true });
    await mkdir(join(home, "Documents/Code/new-repo"), { recursive: true });
    await writeFile(claudeJson, JSON.stringify(fixtureConfig(home), null, 2), { encoding: "utf8", mode: 0o600 });
    deps = { claudeJsonPath: claudeJson, homeDir: home, now: () => new Date("2026-09-28T09:00:00Z"), sleep: async () => {} };
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** Bytes of `after` that differ from `before`: the one changed region, as [start, beforeEnd, afterEnd). */
  function diffRegion(before: string, after: string): { prefix: number; suffix: number } {
    let prefix = 0;
    while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    return { prefix, suffix };
  }

  it("an existing entry: only its hasTrustDialogAccepted changes (false → true), every other byte identical", async () => {
    const before = await readFile(claudeJson, "utf8");
    const r = await grantFolderTrust(deps, join(home, "Documents/Code/acme-www"));
    expect(r).toMatchObject({ ok: true, path: join(home, "Documents/Code/acme-www"), alreadyTrusted: false });
    const after = await readFile(claudeJson, "utf8");
    const { prefix, suffix } = diffRegion(before, after);
    expect(before.slice(prefix, before.length - suffix)).toBe("fals");
    expect(after.slice(prefix, after.length - suffix)).toBe("tru");
    expect(before.slice(0, prefix)).toMatch(/"hasTrustDialogAccepted": $/);
    expect(await folderTrust(claudeJson, join(home, "Documents/Code/acme-www"))).toBe("trusted");
    expect((await stat(claudeJson)).mode & 0o777).toBe(0o600);
  });

  it("an entry without the key: the key is added to that entry and nothing else changes", async () => {
    const before = JSON.parse(await readFile(claudeJson, "utf8")) as Record<string, unknown>;
    const r = await grantFolderTrust(deps, join(home, "Documents/Code/legal-taxonomy"));
    expect(r.ok).toBe(true);
    const after = JSON.parse(await readFile(claudeJson, "utf8")) as { projects: Record<string, Record<string, unknown>> };
    expect(after.projects[join(home, "Documents/Code/legal-taxonomy")]).toEqual({ allowedTools: [], lastCost: 0, hasTrustDialogAccepted: true });
    expect(onlyTrustKeyChanged(before, after, join(home, "Documents/Code/legal-taxonomy"))).toBe(true);
  });

  it("a folder with no entry gets Claude Code's own default entry with the key set, and nothing else changes", async () => {
    const before = await readFile(claudeJson, "utf8");
    const r = await grantFolderTrust(deps, join(home, "Documents/Code/new-repo"));
    expect(r.ok).toBe(true);
    const after = await readFile(claudeJson, "utf8");
    const parsed = JSON.parse(after) as { projects: Record<string, unknown> };
    expect(parsed.projects[join(home, "Documents/Code/new-repo")]).toEqual(defaultTrustedProjectEntry());
    expect(onlyTrustKeyChanged(JSON.parse(before), parsed, join(home, "Documents/Code/new-repo"))).toBe(true);
    // Only an insertion: everything before and after the new entry is byte-identical.
    const { prefix, suffix } = diffRegion(before, after);
    expect(prefix + suffix).toBe(before.length);
  });

  it("already trusted: nothing is written, no copy is made", async () => {
    const st = await stat(claudeJson);
    const r = await grantFolderTrust(deps, join(home, "Documents"));
    expect(r).toEqual({ ok: true, path: join(home, "Documents"), alreadyTrusted: true, backup: null });
    expect((await stat(claudeJson)).mtimeMs).toBe(st.mtimeMs);
    await expect(readdir(join(home, ".alef-trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a 0600 copy of the exact bytes before the first write of the day, and only that one", async () => {
    const before = await readFile(claudeJson, "utf8");
    const first = await grantFolderTrust(deps, join(home, "Documents/Code/acme-www"));
    expect(first.ok && first.backup).toBeTruthy();
    const backup = first.ok ? (first.backup ?? "") : "";
    expect(backup.startsWith(join(home, ".alef-trash", "2026-09-28", "claude-json") + "/")).toBe(true);
    expect(await readFile(backup, "utf8")).toBe(before);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    const second = await grantFolderTrust(deps, join(home, "Documents/Code/new-repo"));
    expect(second).toMatchObject({ ok: true, backup: null });
    expect(await readdir(join(home, ".alef-trash", "2026-09-28", "claude-json"))).toHaveLength(1);
  });

  it("takes Claude Code's own lock (<file>.lock) and removes only the one it made", async () => {
    let lockSeen = false;
    const r = await writeFolderTrust({ ...deps, beforeRename: async () => void (lockSeen = (await stat(`${claudeJson}.lock`)).isDirectory()) }, join(home, "Documents/Code/acme-www"));
    expect(r.ok).toBe(true);
    expect(lockSeen).toBe(true);
    await expect(stat(`${claudeJson}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Review finding (PR #55): renaming the temp file onto a symlinked ~/.claude.json (stow, chezmoi)
  // replaced the link with a regular file; the dotfile target never got the key and fell behind for
  // good. Claude Code itself writes through the link (its writer runs with allowSymlink: true).
  it("a symlinked ~/.claude.json: writes through the link to its target, keeps the link, locks next to the link", async () => {
    const dotfiles = join(home, "dotfiles");
    await mkdir(dotfiles);
    const target = join(dotfiles, "claude.json");
    await rename(claudeJson, target);
    await symlink(target, claudeJson);
    const before = await readFile(target, "utf8");
    let lockSeen = false;
    const r = await writeFolderTrust({ ...deps, beforeRename: async () => void (lockSeen = (await stat(`${claudeJson}.lock`)).isDirectory()) }, join(home, "Documents/Code/acme-www"));
    expect(r).toMatchObject({ ok: true, alreadyTrusted: false });
    expect((await lstat(claudeJson)).isSymbolicLink()).toBe(true);
    expect(await readlink(claudeJson)).toBe(target);
    const after = await readFile(target, "utf8");
    const { prefix, suffix } = diffRegion(before, after);
    expect(before.slice(prefix, before.length - suffix)).toBe("fals");
    expect(after.slice(prefix, after.length - suffix)).toBe("tru");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(lockSeen).toBe(true);
    await expect(stat(`${claudeJson}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    for (const dir of [home, dotfiles]) expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("while Claude Code holds its lock: waits, then fails visibly without writing, and leaves the lock alone", async () => {
    await mkdir(`${claudeJson}.lock`);
    const before = await readFile(claudeJson, "utf8");
    const waits: number[] = [];
    const r = await grantFolderTrust({ ...deps, sleep: async (ms) => void waits.push(ms) }, join(home, "Documents/Code/acme-www"));
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(r.ok ? "" : r.error).toMatch(/lock is held/);
    expect(waits.length).toBeGreaterThan(0);
    expect(await readFile(claudeJson, "utf8")).toBe(before);
    expect((await stat(`${claudeJson}.lock`)).isDirectory()).toBe(true);
  });

  it("a write that races it (file changed after the read): starts over from the new content and keeps it", async () => {
    let raced = false;
    const r = await writeFolderTrust(
      {
        ...deps,
        beforeRename: async () => {
          if (raced) return;
          raced = true;
          const cfg = fixtureConfig(home);
          cfg.numStartups = 813; // what Claude Code writes on its next start
          await writeFile(claudeJson, JSON.stringify(cfg, null, 2), "utf8");
        },
      },
      join(home, "Documents/Code/acme-www"),
    );
    expect(r.ok).toBe(true);
    const after = JSON.parse(await readFile(claudeJson, "utf8")) as { numStartups: number };
    expect(after.numStartups).toBe(813); // the racing writer's change survived
    expect(await folderTrust(claudeJson, join(home, "Documents/Code/acme-www"))).toBe("trusted");
    expect((await readdir(home)).filter((f) => f.includes(".alef-") && f.endsWith(".tmp"))).toEqual([]);
  });

  it(`a file that keeps changing: gives up after ${TRUST_WRITE_TRIES} tries, writes nothing of its own`, async () => {
    let n = 0;
    const r = await writeFolderTrust(
      {
        ...deps,
        beforeRename: async () => {
          const cfg = fixtureConfig(home);
          cfg.numStartups = 900 + ++n;
          await writeFile(claudeJson, JSON.stringify(cfg, null, 2), "utf8");
        },
      },
      join(home, "Documents/Code/acme-www"),
    );
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(n).toBe(TRUST_WRITE_TRIES);
    expect(await folderTrust(claudeJson, join(home, "Documents/Code/acme-www"))).toBe("untrusted");
    expect((await readdir(home)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a file that wouldn't round-trip byte for byte (hand-edited spacing), writing nothing", async () => {
    const odd = JSON.stringify(fixtureConfig(home), null, 2).replace('"theme": "dark"', '"theme":  "dark"');
    await writeFile(claudeJson, odd, "utf8");
    const r = await grantFolderTrust(deps, join(home, "Documents/Code/acme-www"));
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(await readFile(claudeJson, "utf8")).toBe(odd);
  });

  it("keeps a trailing newline and tab indentation when the file has them", async () => {
    const tabbed = `${JSON.stringify(fixtureConfig(home), null, "\t")}\n`;
    await writeFile(claudeJson, tabbed, "utf8");
    expect(roundTripIndent(tabbed, JSON.parse(tabbed))).toBe("\t");
    const r = await grantFolderTrust(deps, join(home, "Documents/Code/acme-www"));
    expect(r.ok).toBe(true);
    const after = await readFile(claudeJson, "utf8");
    expect(after.endsWith("}\n")).toBe(true);
    expect(after.replace('"hasTrustDialogAccepted": true,\n\t\t\t"hasClaudeMdExternalIncludesApproved"', '"hasTrustDialogAccepted": false,\n\t\t\t"hasClaudeMdExternalIncludesApproved"')).toBe(tabbed);
  });

  it("refuses invalid JSON and a file without a projects map, writing nothing", async () => {
    await writeFile(claudeJson, "{ not json", "utf8");
    expect(await grantFolderTrust(deps, join(home, "Documents/Code/acme-www"))).toMatchObject({ ok: false, status: 409 });
    expect(await readFile(claudeJson, "utf8")).toBe("{ not json");
    await writeFile(claudeJson, JSON.stringify({ numStartups: 1 }, null, 2), "utf8");
    expect(await grantFolderTrust(deps, join(home, "Documents/Code/acme-www"))).toMatchObject({ ok: false, status: 409 });
  });

  describe("which folders it accepts (validateTrustCwd)", () => {
    it("an existing folder strictly under $HOME, realpath'd", async () => {
      expect(await validateTrustCwd(home, join(home, "Documents/Code/acme-www/"))).toEqual({ ok: true, path: join(home, "Documents/Code/acme-www") });
    });

    it("never $HOME itself or /", async () => {
      expect(await validateTrustCwd(home, home)).toMatchObject({ ok: false, status: 403 });
      expect(await validateTrustCwd(home, `${home}/`)).toMatchObject({ ok: false, status: 403 });
      expect(await validateTrustCwd(home, "/")).toMatchObject({ ok: false, status: 403 });
    });

    it("nothing outside $HOME, lexically or through a symlink", async () => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), "aw-trust-outside-")));
      try {
        expect(await validateTrustCwd(home, outside)).toMatchObject({ ok: false, status: 403 });
        expect(await validateTrustCwd(home, join(home, "..", "elsewhere"))).toMatchObject({ ok: false, status: 403 });
        await symlink(outside, join(home, "Documents/escape"));
        expect(await validateTrustCwd(home, join(home, "Documents/escape"))).toMatchObject({ ok: false, status: 403 });
        await symlink(home, join(home, "Documents/home-again"));
        expect(await validateTrustCwd(home, join(home, "Documents/home-again"))).toMatchObject({ ok: false, status: 403 });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("not a missing path, a file, a relative path, or a secrets folder", async () => {
      await writeFile(join(home, "Documents/file.txt"), "x");
      await mkdir(join(home, ".ssh"), { recursive: true });
      expect(await validateTrustCwd(home, join(home, "Documents/nope"))).toMatchObject({ ok: false, status: 404 });
      expect(await validateTrustCwd(home, join(home, "Documents/file.txt"))).toMatchObject({ ok: false, status: 400 });
      expect(await validateTrustCwd(home, "Documents/Code/acme-www")).toMatchObject({ ok: false, status: 400 });
      expect(await validateTrustCwd(home, join(home, ".ssh"))).toMatchObject({ ok: false, status: 403 });
      expect(await validateTrustCwd(home, 42)).toMatchObject({ ok: false, status: 400 });
    });

    it("a refused folder never touches the file", async () => {
      const before = await readFile(claudeJson, "utf8");
      expect((await grantFolderTrust(deps, home)).ok).toBe(false);
      expect(await readFile(claudeJson, "utf8")).toBe(before);
    });
  });
});

describe("POST /api/trust and GET /api/trust/targets (fake $HOME, booted server)", () => {
  let server: RunningServer | null = null;
  let home = "";
  afterEach(async () => {
    await server?.close();
    server = null;
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("grants trust for a district folder, lists the ones left, and refuses $HOME", async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "aw-trust-route-")));
    const claudeJson = join(home, ".claude.json");
    // Both git repos: a trusted ~/Documents above a repo root doesn't count (Claude Code stops at the root).
    await mkdir(join(home, "Documents/Code/acme-www/.git"), { recursive: true });
    await mkdir(join(home, "Documents/Code/legal-taxonomy/.git"), { recursive: true });
    await writeFile(claudeJson, JSON.stringify(fixtureConfig(home), null, 2), "utf8");
    const booted = await bootTestServer({ configOverrides: { claudeJsonPath: claudeJson, features: [createTrustFeature({ homeDir: home, sleep: async () => {} })] } });
    server = booted.server;
    const db = booted.server.db;
    for (const [cwd, id] of [
      [join(home, "Documents/Code/acme-www"), "acme-www"],
      [join(home, "Documents/Code/legal-taxonomy"), "legal-taxonomy"],
      [join(home, "Documents"), "documents"],
      [home, "home"],
    ] as const) {
      db.setIslandForCwd(cwd, id);
      db.upsertSession({ id: `0000000${id.length}-0000-4000-8000-00000000000${id.length % 10}`, cwd, islandId: id, title: id, startedAt: "2026-09-27T00:00:00Z", lastActive: "2026-09-27T00:00:00Z", jsonlMtime: 0, messageCountDelta: 1, model: null, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 0, cntAssistantTotalDelta: 0 });
    }
    const targets = (await (await fetch(`${booted.base}/api/trust/targets`)).json()) as TrustTargetsResponse;
    expect(targets.ok).toBe(true);
    expect(targets.untrusted.map((t) => t.islandId)).toEqual(["acme-www", "legal-taxonomy"]); // $HOME is never a target
    const post = (cwd: string): Promise<Response> => fetch(`${booted.base}/api/trust`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
    const granted = await post(join(home, "Documents/Code/acme-www"));
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as TrustGrantResult).path).toBe(join(home, "Documents/Code/acme-www"));
    const left = (await (await fetch(`${booted.base}/api/trust/targets`)).json()) as TrustTargetsResponse;
    expect(left.untrusted.map((t) => t.islandId)).toEqual(["legal-taxonomy"]);
    const refused = await post(home);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as TrustGrantResult).ok).toBe(false);
  });
});
