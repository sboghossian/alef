import { describe, expect, it } from "vitest";
import type { CodeTreeEntry } from "../../../shared/features/code";
import type { AgentActivity } from "../../../shared/types";
import { ancestors, buildTree, diffStats, extCounts, mergeTouchedEntries, parseUnifiedDiff, problemsFrom, quickOpen, sideBySide, statusMap } from "./code-lib";

const entries: CodeTreeEntry[] = [
  { path: "src", type: "dir" },
  { path: "src/a.ts", type: "file", size: 10 },
  { path: "src/b.css", type: "file" },
  { path: "src/deep", type: "dir" },
  { path: "src/deep/c.ts", type: "file" },
  { path: "README.md", type: "file" },
  { path: ".env", type: "file", blocked: true },
  { path: "empty", type: "dir" },
];

describe("buildTree", () => {
  it("nests, sorts dirs first, and counts touched files up the tree", () => {
    const t = buildTree(entries, new Set(["src/deep/c.ts", "README.md"]), { touchedOnly: false, exts: [] });
    expect(t.children.map((c) => c.name)).toEqual(["empty", "src", ".env", "README.md"]);
    const src = t.children.find((c) => c.name === "src");
    expect(src?.children.map((c) => c.name)).toEqual(["deep", "a.ts", "b.css"]);
    expect(src?.touched).toBe(1);
    expect(t.touched).toBe(2);
    expect(t.children.find((c) => c.name === ".env")?.blocked).toBe(true);
  });

  it("touched only keeps just touched files and their folders", () => {
    const t = buildTree(entries, new Set(["src/deep/c.ts"]), { touchedOnly: true, exts: [] });
    expect(t.children.map((c) => c.name)).toEqual(["src"]);
    expect(t.children[0]?.children[0]?.children.map((c) => c.path)).toEqual(["src/deep/c.ts"]);
  });

  it("filters by file type and drops empty folders", () => {
    const t = buildTree(entries, new Set(), { touchedOnly: false, exts: ["ts"] });
    expect(t.children.map((c) => c.name)).toEqual(["src"]);
    expect(t.children[0]?.children.map((c) => c.name)).toEqual(["deep", "a.ts"]);
  });

  it("an empty repo is an empty root", () => {
    expect(buildTree([], new Set(), { touchedOnly: false, exts: [] }).children).toEqual([]);
  });

  it("adds touched files missing from a truncated tree; counts extensions; ancestors", () => {
    const m = mergeTouchedEntries(entries, [
      { path: "x/new.py", insideRepo: true, count: 1, edits: 1, lastTool: "Write", lastAt: null },
      { path: "/abs/out.txt", insideRepo: false, count: 1, edits: 0, lastTool: "Read", lastAt: null },
    ]);
    expect(m.map((e) => e.path)).toContain("x/new.py");
    expect(m.map((e) => e.path)).not.toContain("/abs/out.txt");
    expect(extCounts(entries)[0]).toEqual({ ext: "ts", count: 2 });
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
  });
});

describe("quickOpen", () => {
  const files = [
    { path: "client/src/views/code.ts", touched: false },
    { path: "client/src/views/brain.ts", touched: true },
    { path: "server/features/code.ts", touched: true },
    { path: "docs/VIEWS.md", touched: false },
  ];
  it("empty query lists touched first", () => {
    expect(quickOpen("", files).slice(0, 2).every((f) => f.touched)).toBe(true);
  });
  it("fuzzy matches basenames first and skips non-matches", () => {
    const r = quickOpen("code", files);
    expect(r.map((f) => f.path)).toEqual(["server/features/code.ts", "client/src/views/code.ts"]);
    expect(quickOpen("vws", files).map((f) => f.path)).toContain("docs/VIEWS.md");
    expect(quickOpen("zzzz", files)).toEqual([]);
  });
});

describe("diff", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "index 1..2 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,4 +1,4 @@ fn",
    " keep",
    "-old one",
    "-old two",
    "+new one",
    " tail",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  it("numbers old/new lines", () => {
    const l = parseUnifiedDiff(diff);
    expect(l.filter((x) => x.kind === "meta").length).toBe(5);
    expect(l.find((x) => x.kind === "add")).toMatchObject({ text: "new one", newNo: 2, oldNo: null });
    expect(l.filter((x) => x.kind === "del").map((x) => x.oldNo)).toEqual([2, 3]);
    expect(l.filter((x) => x.kind === "ctx").map((x) => [x.oldNo, x.newNo])).toEqual([[1, 1], [4, 3]]);
    expect(diffStats(l)).toEqual({ add: 1, del: 2 });
  });
  it("pairs deletions with additions side by side", () => {
    const rows = sideBySide(parseUnifiedDiff(diff)).filter((r) => !r.span);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["keep", "keep"],
      ["old one", "new one"],
      ["old two", null],
      ["tail", "tail"],
    ]);
  });
  it("an empty diff has no lines", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("status + problems", () => {
  it("maps porcelain codes, renames included", () => {
    const m = statusMap([{ path: "a", status: " M" }, { path: "b", status: "??" }, { path: "c -> d", status: "R " }]);
    expect([m.get("a"), m.get("b"), m.get("d")]).toEqual(["M", "U", "R"]);
  });
  it("keeps only this agent's error-looking tool lines, newest first", () => {
    const act = (id: string, agentId: string, summary: string, stage: AgentActivity["stage"] = "tool"): AgentActivity => ({
      id, agentId, at: "2026-09-25T10:00:00Z", stage, toolName: "Bash", targetObjectId: null, summary,
    });
    const list = [act("1", "a", "Bash: npm test failed"), act("2", "b", "Bash: error"), act("3", "a", "Read x.ts"), act("4", "a", "Bash exit code 2"), act("5", "a", "error in thought", "reason")];
    expect(problemsFrom(list, "a").map((p) => p.id)).toEqual(["4", "1"]);
  });
});
