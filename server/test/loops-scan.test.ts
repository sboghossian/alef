import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTodoMd, scanTodoFiles } from "../features/loops-scan.js";

describe("parseTodoMd", () => {
  it("keeps only unchecked items and cleans markdown links/ticks/emphasis/trailing dots", () => {
    const md = ["## Open", "- [ ] Ship the **thing** via [the doc](http://x) `now`.", "- [x] already done", "- [ ] ok"].join("\n");
    const items = parseTodoMd(md, "proj", "/p/tasks/todo.md", 42);
    // "ok" cleans to 2 chars, below the >=4 floor, so only the first line survives.
    expect(items).toEqual([{ task: "Ship the thing via the doc now", project: "proj", section: "Open", sourceFile: "/p/tasks/todo.md", mtimeMs: 42 }]);
  });

  it("skips a Deferred (and someday/backlog/icebox/...) heading's whole section", () => {
    const md = ["## Deferred", "- [ ] not now", "## Someday", "- [ ] also not now", "## Today", "- [ ] real task"].join("\n");
    expect(parseTodoMd(md, "p", "f", 0).map((i) => i.task)).toEqual(["real task"]);
  });

  it("skips a Done/Completed/Archived heading's whole section", () => {
    const md = ["## Done", "- [ ] shouldn't count", "## Archived", "- [ ] neither should this", "## Next", "- [ ] real task"].join("\n");
    expect(parseTodoMd(md, "p", "f", 0).map((i) => i.task)).toEqual(["real task"]);
  });

  it("resumes reading once a later heading is not a skipped one", () => {
    const md = ["## Deferred", "- [ ] skip me", "## Active", "- [ ] count me"].join("\n");
    expect(parseTodoMd(md, "p", "f", 0).map((i) => i.task)).toEqual(["count me"]);
  });

  it("ignores checkboxes inside fenced code blocks", () => {
    const md = ["## Notes", "```", "- [ ] not a real todo", "```", "- [ ] real one"].join("\n");
    expect(parseTodoMd(md, "p", "f", 0).map((i) => i.task)).toEqual(["real one"]);
  });
});

describe("scanTodoFiles", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function makeProject(root: string, name: string, body: string): Promise<string> {
    const tasksDir = join(root, name, "tasks");
    await mkdir(tasksDir, { recursive: true });
    const file = join(tasksDir, "todo.md");
    await writeFile(file, body, "utf8");
    return file;
  }

  it("finds todo.md one level under codeDir, skipping node_modules/.git and a linked worktree", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-scan-"));
    await makeProject(dir, "alpha", "## Open\n- [ ] alpha task\n");

    await mkdir(join(dir, "node_modules", "tasks"), { recursive: true });
    await writeFile(join(dir, "node_modules", "tasks", "todo.md"), "- [ ] nope\n");

    // A linked git worktree: its `.git` is a FILE (points at the real repo's gitdir), not a directory.
    await mkdir(join(dir, "wt", "tasks"), { recursive: true });
    await writeFile(join(dir, "wt", ".git"), "gitdir: /somewhere/.git/worktrees/wt\n");
    await writeFile(join(dir, "wt", "tasks", "todo.md"), "- [ ] worktree task\n");

    const items = await scanTodoFiles({ codeDir: dir });
    expect(items.map((i) => i.project)).toEqual(["alpha"]);
    expect(items[0]?.task).toBe("alpha task");
  });

  it("skips a todo.md not touched within the active-days window", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-scan-"));
    const file = await makeProject(dir, "stale", "## Open\n- [ ] old task\n");
    const old = new Date(Date.now() - 90 * 86_400_000);
    await utimes(file, old, old);
    expect(await scanTodoFiles({ codeDir: dir, activeDays: 45 })).toEqual([]);
  });

  it("keeps a todo.md touched inside the active-days window", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-scan-"));
    await makeProject(dir, "fresh", "## Open\n- [ ] fresh task\n");
    const items = await scanTodoFiles({ codeDir: dir, activeDays: 45 });
    expect(items.map((i) => i.task)).toEqual(["fresh task"]);
  });

  it("caps each project at projectCap items, keeping file order", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-scan-"));
    const lines = Array.from({ length: 20 }, (_, i) => `- [ ] task ${i}`).join("\n");
    await makeProject(dir, "big", `## Open\n${lines}\n`);
    const items = await scanTodoFiles({ codeDir: dir, projectCap: 12 });
    expect(items).toHaveLength(12);
    expect(items[0]?.task).toBe("task 0");
    expect(items[11]?.task).toBe("task 11");
  });

  it("returns [] for a codeDir that does not exist, without throwing", async () => {
    expect(await scanTodoFiles({ codeDir: "/no/such/dir/at/all" })).toEqual([]);
  });
});
