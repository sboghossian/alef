import { describe, expect, it } from "vitest";
import { buildArchive, islandForSlug, worktreeAliasIslands, parseFrontmatter, parseSessionNote, titleFromFile, type ArchiveNote, type BuildArchiveInput } from "../features/archive-lib.js";
import { parseTaxonomy } from "../features/topics-lib.js";

const HOME = "/Users/me";
const ID = "48b865f7-a2b1-4548-9dd1-2b0a99d08436";
const ID2 = "a631588d-0aae-4961-9c8a-67724c32e35c";
const ID3 = "5d456590-1c66-4d52-8df4-3ccd44a8e666";

function note(fm: string, body = "\n# Title\n\nbody\n"): string {
  return `---\n${fm}\n---${body}`;
}

const REAL = note(`type: session
source: claude-code
session_id: ${ID}
date: 2026-06-08
project: gstack
topics:
  - pricing
  - topic/ai
tags:
  - session/claude-code
contains_code: false
message_count: 86
cwd: /Users/me
summary: for naar

I also thought about having inquiry for full place booking - brunch, night

add this to the landing ;)`);

describe("parseFrontmatter / parseSessionNote", () => {
  it("parses a real-shaped note: id, date, slug, and a multi-line summary as the title", () => {
    const r = parseSessionNote(REAL, "2026-06-08-for-naar.md");
    expect(r).toEqual({
      ok: true,
      note: { id: ID, date: "2026-06-08", project: "gstack", title: "for naar I also thought about having inquiry for full place booking - brunch, night add this to the landing ;)", file: "2026-06-08-for-naar.md" },
    });
  });

  it("strips a quoted summary even when its inner quotes are unescaped, and ignores list lines", () => {
    const r = parseSessionNote(note(`type: session\nsession_id: ${ID}\nproject: "Documents-Code"\nsummary: "You are a triage classifier.\n\nCategories:\n- "project": a thing..."`), "x.md");
    expect(r.ok && r.note.title).toBe("You are a triage classifier. Categories:");
    expect(r.ok && r.note.project).toBe("documents-code");
  });

  it("does not treat a URL line inside a wrapped value as a key", () => {
    const fm = parseFrontmatter(note(`summary: see\nhttps://example.com/x\ntype: session`));
    expect(fm?.get("summary")).toBe("see\nhttps://example.com/x");
    expect(fm?.get("type")).toBe("session");
  });

  it("skips malformed notes with a reason", () => {
    expect(parseSessionNote("no frontmatter here", "a.md")).toEqual({ ok: false, reason: "no-frontmatter" });
    expect(parseSessionNote(`---\ntype: session\nsession_id: ${ID}\n(never closed)`, "a.md")).toEqual({ ok: false, reason: "no-frontmatter" });
    expect(parseSessionNote(note(`type: hub\nsession_id: ${ID}`), "_hub.md")).toEqual({ ok: false, reason: "not-session" });
    expect(parseSessionNote(note("type: session\ndate: 2026-03-26"), "2026-03-26-daily-summary.md")).toEqual({ ok: false, reason: "missing-id" });
    expect(parseSessionNote(note("type: session\nsession_id: ../../etc/passwd"), "a.md")).toEqual({ ok: false, reason: "bad-id" });
    expect(parseSessionNote(note("type: session\nsession_id:"), "a.md")).toEqual({ ok: false, reason: "missing-id" });
  });

  it("falls back: date from the file name, title from the file name, odd slug → home", () => {
    const r = parseSessionNote(note(`type: session\nsession_id: ${ID.toUpperCase()}\nproject: ../../evil slug`), "2026-05-01-fix-the-thing-3.md");
    expect(r).toEqual({ ok: true, note: { id: ID, date: "2026-05-01", project: "home", title: "fix the thing", file: "2026-05-01-fix-the-thing-3.md" } });
    expect(titleFromFile("2026-03-17-can-you-fix-that.md")).toBe("can you fix that");
  });

  it("caps the title and keeps the first of a repeated key", () => {
    const r = parseSessionNote(note(`type: session\nsession_id: ${ID}\nproject: a\nproject: b\nsummary: ${"x".repeat(400)}`), "a.md");
    expect(r.ok && r.note.project).toBe("a");
    expect(r.ok && r.note.title.length).toBe(120);
  });
});

const islands = [
  { id: "alexboghossian", name: "alexboghossian", path: HOME },
  { id: "root", name: "/", path: "/" },
  { id: "acme-ai-next", name: "acme-ai-next", path: `${HOME}/Documents/Code/acme-ai-next` },
  { id: "alex-claude", name: "alex_claude", path: `${HOME}/Documents/Code/alex_claude` },
  { id: "harness", name: "Harness City", path: "" },
];

describe("islandForSlug", () => {
  it("matches by id, then by folder name, never a catch-all or harness", () => {
    expect(islandForSlug("acme-ai-next", islands, HOME)).toBe("acme-ai-next");
    expect(islandForSlug("alex_claude", islands, HOME)).toBe("alex-claude");
    expect(islandForSlug("alexboghossian", islands, HOME)).toBeNull();
    expect(islandForSlug("root", islands, HOME)).toBeNull();
    expect(islandForSlug("harness", islands, HOME)).toBeNull();
    expect(islandForSlug("crucible", islands, HOME)).toBeNull();
  });
});

const taxonomy = parseTaxonomy({
  groups: [
    { key: "WEB", name: "Website" },
    { key: "RESEARCH", name: "Research" },
    { key: "AUTO", name: "Automations" },
  ],
  rules: [{ pattern: "^You are a triage classifier", group: "AUTO" }],
});

function n(id: string, project: string, title: string, file = `${id}.md`, date = "2026-06-01"): ArchiveNote {
  return { id, project, title, file, date };
}

function input(notes: ArchiveNote[], over: Partial<BuildArchiveInput> = {}): BuildArchiveInput {
  return { notes, files: notes.length, skipped: 0, liveIds: new Set(), islands, taxonomy, assignments: new Map(), homeDir: HOME, notesDir: "10-Sessions/claude-code", vault: "alex_claude", now: 0, ...over };
}

describe("buildArchive", () => {
  it("sends a note named after a worktree to the repo that worktree now lives in", () => {
    const aliases = [
      { cwd: "/Users/me/.acme-worktrees/tick-1791", root: "/Users/me/Documents/Code/acme-ai-next", islandId: "acme-ai-next" },
      { cwd: "/Users/me/Documents/Code/acme-ai-next/apps/out", root: "/Users/me/Documents/Code/acme-ai-next", islandId: "acme-ai-next" }, // subfolder: never claims
      { cwd: "/a/wt/dup", root: "/r1", islandId: "acme-ai-next" },
      { cwd: "/b/wt/dup", root: "/r2", islandId: "alexboghossian" }, // conflicting slug: dropped
    ];
    const worktreeIslands = worktreeAliasIslands(aliases);
    expect([...worktreeIslands]).toEqual([["tick-1791", "acme-ai-next"]]);
    const { sessions } = buildArchive(input([n(ID, "tick-1791", "fix"), n(ID2, "out", "x")], { worktreeIslands }));
    expect(sessions.find((s) => s.id === ID)?.place).toBe("island:acme-ai-next");
    expect(sessions.find((s) => s.id === ID2)?.place).toBe("archived:out");
  });

  it("maps a repo slug to its island, an unknown slug to an archived district, home to a topic group", () => {
    const { summary, sessions } = buildArchive(
      input([n(ID, "acme-ai-next", "fix the nav"), n(ID2, "crucible", "run the benchmark on openrouter"), n(ID3, "home", "You are a triage classifier for ideas")]),
    );
    const place = (id: string): string | undefined => sessions.find((s) => s.id === id)?.place;
    expect(place(ID)).toBe("island:acme-ai-next");
    expect(place(ID2)).toBe("archived:crucible");
    expect(place(ID3)).toBe("topic:AUTO");
    expect(summary.places.find((p) => p.key === "archived:crucible")?.group).toBe("RESEARCH"); // keyword majority
    expect(summary.homeIslandId).toBe("alexboghossian");
    expect(sessions.find((s) => s.id === ID)?.note).toBe(`10-Sessions/claude-code/${ID}.md`);
  });

  it("home/root runs no rule places fall back to the catch-all group, and an assignment wins over rules", () => {
    const { sessions } = buildArchive(input([n(ID, "root", "reply with the word ok"), n(ID2, "documents-code", "You are a triage classifier")], { assignments: new Map([[ID2, "WEB"]]) }));
    expect(sessions.find((s) => s.id === ID)?.place).toBe(`topic:${taxonomy.fallback}`);
    expect(sessions.find((s) => s.id === ID2)?.place).toBe("topic:WEB");
  });

  it("an archived district's folder rule beats its sessions' majority", () => {
    const { summary } = buildArchive(input([n(ID, "acme-ai", "run the benchmark")]));
    expect(summary.places[0]).toMatchObject({ key: "archived:acme-ai", group: "WEB", count: 1 });
  });

  it("skips live ids and merges duplicate notes (the unsuffixed note wins)", () => {
    const { summary, sessions } = buildArchive(
      input([n(ID, "crucible", "second copy", "2026-05-17-foo-1.md"), n(ID, "crucible", "canonical", "2026-05-17-foo.md"), n(ID2, "acme-ai-next", "live one")], { liveIds: new Set([ID2]) }),
    );
    expect(summary).toMatchObject({ parsed: 3, duplicates: 1, skippedLive: 1, total: 1 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("canonical");
  });

  it("an empty vault yields an empty, well-formed summary", () => {
    const { summary, sessions } = buildArchive(input([], { islands: [] }));
    expect(sessions).toEqual([]);
    expect(summary).toMatchObject({ total: 0, places: [], homeIslandId: null });
  });

  it("sorts sessions newest first and places by size", () => {
    const { summary, sessions } = buildArchive(input([n(ID, "crucible", "a", "a.md", "2026-01-01"), n(ID2, "crucible", "b", "b.md", "2026-03-01"), n(ID3, "acme-ai-next", "c", "c.md", "2026-02-01")]));
    expect(sessions.map((s) => s.date)).toEqual(["2026-03-01", "2026-02-01", "2026-01-01"]);
    expect(summary.places.map((p) => [p.key, p.count])).toEqual([
      ["archived:crucible", 2],
      ["island:acme-ai-next", 1],
    ]);
  });
});

describe("buildArchive + cached Jev answers", () => {
  const taxJ = parseTaxonomy({ groups: [{ key: "WEB", name: "Web" }, { key: "AUTO", name: "Auto" }], rules: [] });
  const mk = (n: number, title: string): ArchiveNote => ({ id: `00000000-0000-4000-8000-00000000000${n}`, date: "2026-06-01", project: "home", title, file: `n${n}.md` });
  const base = { files: 3, skipped: 0, liveIds: new Set<string>(), islands: [], taxonomy: taxJ, assignments: new Map<string, string>(), homeDir: "/Users/me", notesDir: "n", vault: "v", now: 0 };
  const notes = [mk(1, "Reply with exactly: OK"), mk(2, "mystery one"), mk(3, "mystery two")];

  it("rules only: unplaced home runs fall back to OTHER and are queued for Jev", () => {
    const b = buildArchive({ ...base, notes });
    expect(b.needJev.map((x) => x.id)).toEqual([mk(2, "").id, mk(3, "").id]);
    expect(b.needJev.every((x) => x.catchAll && x.islandId === "home")).toBe(true);
    expect(b.summary.places.map((p) => [p.key, p.count])).toEqual([["topic:OTHER", 2], ["topic:AUTO", 1]]);
  });
  it("a cached answer places the session and takes it off the queue; a cached OTHER stays OTHER", () => {
    const jev = new Map([[mk(2, "").id, "WEB"], [mk(3, "").id, "OTHER"]]);
    const b = buildArchive({ ...base, notes, jev });
    expect(b.needJev).toEqual([]);
    expect(b.summary.places.map((p) => [p.key, p.count]).sort()).toEqual([["topic:AUTO", 1], ["topic:OTHER", 1], ["topic:WEB", 1]]);
  });
});
