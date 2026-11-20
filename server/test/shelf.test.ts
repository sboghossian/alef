import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHELF_PREVIEW_CSP, type ShelfResponse } from "../../shared/features/shelf.js";
import { createShelfFeature } from "../features/shelf.js";
import { sanitizeUrl } from "../features/shelf-lib.js";
import type { RunningServer } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { assistantLine, bootTestServer, userLine, writeSessionFile } from "./helpers.js";

const AGENT = "11111111-2222-4333-8444-666666666666";

describe("shelf-lib sanitizeUrl", () => {
  it("keeps http(s), strips credentials + sensitive params + trailing punctuation", () => {
    expect(sanitizeUrl("https://example.com/a?x=1&token=abc.")).toBe("https://example.com/a?x=1");
    expect(sanitizeUrl("https://user:pw@example.com/")).toBe("https://example.com/");
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("shelf", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function setup(): Promise<{ base: string; repo: string; vault: string; outputs: string; scratch: string; home: string }> {
    const scratch = await mkdtemp(join(tmpdir(), "aw-shelf-"));
    const home = join(scratch, "home");
    const repo = join(scratch, "repo");
    const vault = join(scratch, "vault");
    const outputs = join(scratch, "outputs");
    const memory = join(home, ".claude", "projects", "-proj", "memory");
    for (const d of [join(repo, ".git"), join(repo, "out"), vault, outputs, memory, join(scratch, "outside")]) await mkdir(d, { recursive: true });
    await writeFile(join(repo, "out", "report.html"), '<h1>hi</h1><script>alert(1)</script><p>sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789</p>');
    await writeFile(join(repo, "out", "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(repo, ".env"), "SECRET=1");
    await writeFile(join(repo, "out", "data.bin"), "x");
    await writeFile(join(vault, "note.md"), "# note");
    await writeFile(join(outputs, "brief.html"), "<p>brief</p>");
    await writeFile(join(memory, "feedback_x.md"), "learned");
    await writeFile(join(scratch, "outside", "x.html"), "<p>outside</p>");
    await symlink(join(scratch, "outside", "x.html"), join(repo, "out", "escape.html"));

    const feature = createShelfFeature({ vaultRoot: vault, extraRoots: () => [outputs], home });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    const projects = join(b.dir, "projects");
    const now = new Date().toISOString();
    await writeSessionFile(
      projects,
      "-repo",
      AGENT,
      [
        userLine({ cwd: repo, timestamp: now, text: "read https://docs.example.com/guide?token=secret123 and https://docs.example.com/guide?token=other" }),
        assistantLine({ cwd: repo, timestamp: now, text: "Published https://claude.ai/artifact/C2L7vKBxACoabe9T267kuK — see also https://github.com/x/y." }),
        assistantLine({ cwd: repo, timestamp: now, toolUses: [{ name: "WebFetch", input: { url: "https://news.example.org/a" } }] }),
        assistantLine({ cwd: repo, timestamp: now, toolUses: [{ name: "Write", input: { file_path: join(repo, "out", "report.html"), content: "x" } }] }),
        assistantLine({ cwd: repo, timestamp: now, toolUses: [{ name: "Write", input: { file_path: "out/chart.png", content: "x" } }] }),
        assistantLine({ cwd: repo, timestamp: now, toolUses: [{ name: "Edit", input: { file_path: join(memory, "feedback_x.md"), old_string: "a", new_string: "b" } }] }),
      ].join("\n") + "\n",
    );
    await runIndexPass(b.server.db, { projectsDir: projects });
    return { base: b.base, repo, vault, outputs, scratch, home };
  }

  it("lists urls (deduped, sanitized), artifacts, files, media and learnings", async () => {
    const { base, repo, home } = await setup();
    const res = await fetch(`${base}/api/shelf/${AGENT}`);
    const body = (await res.json()) as ShelfResponse;
    expect(res.status).toBe(200);
    const urls = body.urls.map((u) => u.url);
    expect(urls).toContain("https://docs.example.com/guide");
    expect(body.urls.find((u) => u.url === "https://docs.example.com/guide")?.count).toBe(2);
    expect(urls).toContain("https://github.com/x/y");
    expect(urls).toContain("https://news.example.org/a");
    expect(urls.some((u) => u.includes("secret123"))).toBe(false);
    expect(body.artifacts).toEqual([{ url: "https://claude.ai/artifact/C2L7vKBxACoabe9T267kuK", firstAt: expect.any(String) }]);
    expect(body.media.map((f) => f.path).sort()).toEqual([join(repo, "out", "chart.png"), join(repo, "out", "report.html")]);
    expect(body.media.every((f) => f.previewable)).toBe(true);
    expect(body.learnings.map((f) => f.path)).toEqual([join(home, ".claude", "projects", "-proj", "memory", "feedback_x.md")]);
    expect(body.learnings[0]?.previewable).toBe(true);
  });

  it("previews HTML with the strict CSP, nosniff and secrets redacted", async () => {
    const { base, repo } = await setup();
    const res = await fetch(`${base}/api/shelf/preview?agentId=${AGENT}&path=${encodeURIComponent(join(repo, "out", "report.html"))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(SHELF_PREVIEW_CSP);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).not.toContain("sk-ant-api03");
    const img = await fetch(`${base}/api/shelf/preview?agentId=${AGENT}&path=${encodeURIComponent(join(repo, "out", "chart.png"))}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toBe(SHELF_PREVIEW_CSP);
  });

  it("previews vault and automation-output files without an agent", async () => {
    const { base, vault, outputs } = await setup();
    expect((await fetch(`${base}/api/shelf/preview?path=${encodeURIComponent(join(vault, "note.md"))}`)).status).toBe(200);
    expect((await fetch(`${base}/api/shelf/preview?path=${encodeURIComponent(join(outputs, "brief.html"))}`)).status).toBe(200);
  });

  it("refuses outside roots, traversal, symlink escapes, secrets, bad types and relative paths", async () => {
    const { base, repo, scratch } = await setup();
    const p = (path: string, agent = true): Promise<Response> =>
      fetch(`${base}/api/shelf/preview?${agent ? `agentId=${AGENT}&` : ""}path=${encodeURIComponent(path)}`);
    expect((await p(join(scratch, "outside", "x.html"))).status).toBe(403);
    expect((await p(`${repo}/../outside/x.html`)).status).toBe(403);
    expect((await p(join(repo, "out", "escape.html"))).status).toBe(403);
    expect((await p(join(repo, "out", "report.html"), false)).status).toBe(403); // repo root only with its agent
    expect((await p(join(repo, ".env"))).status).toBe(415);
    expect((await p(join(repo, ".env.html"))).status).toBe(403);
    expect((await p(join(repo, "out", "data.bin"))).status).toBe(415);
    expect((await p("out/report.html")).status).toBe(400);
    expect((await fetch(`${base}/api/shelf/preview?agentId=bad&path=${encodeURIComponent(join(repo, "out", "report.html"))}`)).status).toBe(400);
  });
});
