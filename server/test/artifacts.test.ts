import { mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactsResponse } from "../../shared/features/artifacts.js";
import { ARTIFACT_PREVIEW_CSP, ARTIFACT_SCRIPT_HOSTS, createArtifactsFeature } from "../features/artifacts.js";
import { refuseSource, snapshotSource } from "../features/artifacts-snapshot.js";
import { publishLines, S1 } from "./artifacts-fixtures.js";
import { bootTestServer, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

describe("snapshotSource guards", () => {
  async function setup(): Promise<{ home: string; out: string }> {
    const home = await makeTempProjectsDir();
    const out = join(home, "data", "artifacts");
    return { home, out };
  }

  it("refuses secret paths and privacy-guarded folders before touching the disk", async () => {
    const { home } = await setup();
    expect(refuseSource(join(home, ".ssh", "page.html"), { home })).toBe("secret");
    expect(refuseSource(join(home, "proj", ".env.html"), { home })).toBe("secret");
    expect(refuseSource(join(home, "Desktop", "page.html"), { home })).toBe("privacy-guarded");
    expect(refuseSource(join(home, "downloads", "page.html"), { home, platform: "darwin" })).toBe("privacy-guarded");
    expect(refuseSource(join(home, "notes.md"), { home })).toBe("not-html");
    expect(refuseSource("relative/page.html", { home })).toBe("bad-path");
  });

  it("refuses a symlink that resolves into a guarded folder", async () => {
    const { home, out } = await setup();
    await mkdir(join(home, "Desktop"), { recursive: true });
    await writeFile(join(home, "Desktop", "real.html"), "<p>private</p>");
    await mkdir(join(home, "work"), { recursive: true });
    await symlink(join(home, "Desktop", "real.html"), join(home, "work", "link.html"));
    expect(await snapshotSource(join(home, "work", "link.html"), out, "Linked1234", null, { home })).toEqual({ ok: false, error: "privacy-guarded" });
  });

  it("caps the size, redacts secrets, and copies again only when the source changes", async () => {
    const { home, out } = await setup();
    const src = join(home, "work", "page.html");
    await mkdir(join(home, "work"), { recursive: true });
    await writeFile(src, `<p>key sk-ant-api03-${"a".repeat(90)}</p>`);
    expect(await snapshotSource(src, out, "Page123456", null, { home, maxBytes: 10 })).toEqual({ ok: false, error: "too-large" });
    const first = await snapshotSource(src, out, "Page123456", null, { home });
    expect(first).toMatchObject({ ok: true, changed: true });
    const copy = await readFile(join(out, "Page123456.html"), "utf8");
    expect(copy).not.toContain("a".repeat(90));
    if (!first.ok) throw new Error("unreachable");
    expect(await snapshotSource(src, out, "Page123456", { mtimeMs: first.mtimeMs, size: first.size }, { home })).toMatchObject({ ok: true, changed: false });
    await writeFile(src, "<p>v2</p>");
    const later = new Date(Date.now() + 5000);
    await utimes(src, later, later);
    expect(await snapshotSource(src, out, "Page123456", { mtimeMs: first.mtimeMs, size: first.size }, { home })).toMatchObject({ ok: true, changed: true });
    expect(await readFile(join(out, "Page123456.html"), "utf8")).toBe("<p>v2</p>");
    expect(await snapshotSource(join(home, "gone.html"), out, "Gone123456", null, { home })).toEqual({ ok: false, error: "not-found" });
  });
});

describe("artifacts feature on a real server", () => {
  it("lists items, serves the saved copy sandboxed, and adds the Museum island", async () => {
    const sources = await makeTempProjectsDir();
    const page = join(sources, "board.html");
    await writeFile(page, "<h1>Board</h1>");
    const feature = createArtifactsFeature({ tickIntervalMs: 100, home: sources });
    const { base, server, dir } = await bootTestServer({ configOverrides: { features: [feature] } });
    try {
      const at = new Date().toISOString();
      const lines = [
        JSON.stringify({ type: "user", timestamp: at, cwd: "/ws/p", message: { role: "user", content: [{ type: "text", text: "make a board" }] } }),
        ...publishLines("t1", at, "Board", page),
        ...publishLines("t2", at, "Gone page", join(sources, "missing.html"), "https://claude.ai/artifact/NoCopyAb3dEf5h7K9mNp2Q"),
      ];
      await writeSessionFile(join(dir, "projects"), "-ws-p", S1, `${lines.join("\n")}\n`);
      let list: ArtifactsResponse | null = null;
      await vi.waitFor(
        async () => {
          list = (await (await fetch(`${base}/api/artifacts`)).json()) as ArtifactsResponse;
          expect(list.items.find((i) => i.id === "Ab3dEf5h7K9mNp2QrStUvW")?.hasPreview).toBe(true);
        },
        { timeout: 15_000, interval: 200 },
      );
      const items = (list as ArtifactsResponse | null)?.items ?? [];
      expect(items.map((i) => i.id).sort()).toEqual(["Ab3dEf5h7K9mNp2QrStUvW", "NoCopyAb3dEf5h7K9mNp2Q"]);
      expect(items.find((i) => i.id === "NoCopyAb3dEf5h7K9mNp2Q")).toMatchObject({ hasPreview: false, origin: "published", sessions: [S1] });
      expect((await stat(join(dir, "artifacts", "Ab3dEf5h7K9mNp2QrStUvW.html"))).isFile()).toBe(true);

      const preview = await fetch(`${base}/api/artifacts/Ab3dEf5h7K9mNp2QrStUvW/preview`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-security-policy")).toBe(ARTIFACT_PREVIEW_CSP);
      const csp = new Map(ARTIFACT_PREVIEW_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
      // Scripts run, but sandboxed into an opaque origin with no network of their own.
      expect(csp.get("sandbox")).toEqual(["allow-scripts"]);
      expect(csp.get("default-src")).toEqual(["'none'"]);
      expect(csp.get("connect-src")).toEqual(["'none'"]);
      expect(csp.get("form-action")).toEqual(["'none'"]);
      expect(csp.get("base-uri")).toEqual(["'none'"]);
      expect(csp.get("frame-ancestors")).toEqual(["'self'"]);
      expect(csp.get("script-src")).toEqual(["'unsafe-inline'", ...ARTIFACT_SCRIPT_HOSTS]);
      expect(ARTIFACT_PREVIEW_CSP).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|'self' |'unsafe-eval'|http:/);
      for (const src of ["script-src", "style-src", "font-src", "img-src"]) expect(csp.get(src)).not.toContain("'self'");
      expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await preview.text()).toBe("<h1>Board</h1>");
      expect((await fetch(`${base}/api/artifacts/NoCopyAb3dEf5h7K9mNp2Q/preview`)).status).toBe(404);
      expect((await fetch(`${base}/api/artifacts/..%2Fworld.db/preview`)).status).toBe(400);
      // A script in the preview runs in an opaque origin: whatever it sends Alef carries
      // Origin: null (fetch, a WebSocket) or Sec-Fetch-Site: cross-site (an <img>, a navigation).
      for (const path of ["/api/artifacts", "/api/artifacts/Ab3dEf5h7K9mNp2QrStUvW/preview", "/api/world", "/api/health"]) {
        expect((await fetch(`${base}${path}`, { headers: { Origin: "null" } })).status).toBe(403);
        expect((await fetch(`${base}${path}`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
        expect((await fetch(`${base}${path}`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
      }

      const world = (await (await fetch(`${base}/api/world`)).json()) as { islands: { id: string; agentCount: number }[]; extras?: Record<string, unknown> };
      expect(world.islands.find((i) => i.id === "museum")).toMatchObject({ agentCount: 0 });
      expect(world.extras?.["artifacts.summary"]).toMatchObject({ count: 2, published: 2, withPreview: 1 });
    } finally {
      await server.close();
    }
  }, 30_000);
});
