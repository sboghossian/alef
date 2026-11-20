import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWhatsupBoard } from "../features/loops-whatsup.js";

describe("readWhatsupBoard", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("reports ok:false, without throwing, when the file does not exist", async () => {
    const result = await readWhatsupBoard("/no/such/file/todos.json");
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.error).toContain("cannot read");
  });

  it("reports ok:false, without throwing, on invalid JSON", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-whatsup-"));
    const file = join(dir, "todos.json");
    await writeFile(file, "{not json", "utf8");
    const result = await readWhatsupBoard(file);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });

  it("reports ok:false when the parsed JSON has no items array", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-whatsup-"));
    const file = join(dir, "todos.json");
    await writeFile(file, JSON.stringify({ generated: "2026-09-25T08:00" }), "utf8");
    const result = await readWhatsupBoard(file);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("items array");
  });

  it("parses valid items and drops malformed ones (missing fields, unknown lens)", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-whatsup-"));
    const file = join(dir, "todos.json");
    await writeFile(
      file,
      JSON.stringify({
        generated: "2026-09-25T08:50",
        items: [
          { id: "abc123", task: "Ship the thing", project: "demo", lens: "do_today", score: 84, source_type: "todo_md", source_file: "/x/tasks/todo.md" },
          { id: "live1", task: "TICK-1 — do X", project: "acme-growth", lens: "waiting", score: 50, source_type: "live", source_file: "linear:TICK-1" },
          { task: "missing id", project: "demo", lens: "do_today", score: 1 },
          { id: "badlens", task: "bad lens", project: "demo", lens: "not_a_real_lens", score: 1 },
          "not even an object",
        ],
      }),
      "utf8",
    );
    const result = await readWhatsupBoard(file);
    expect(result.ok).toBe(true);
    expect(result.generatedAt).toBe("2026-09-25T08:50");
    expect(result.items).toEqual([
      { id: "abc123", task: "Ship the thing", project: "demo", lens: "do_today", score: 84, sourceType: "todo_md", sourceFile: "/x/tasks/todo.md" },
      { id: "live1", task: "TICK-1 — do X", project: "acme-growth", lens: "waiting", score: 50, sourceType: "live", sourceFile: "linear:TICK-1" },
    ]);
  });

  it("defaults a missing/invalid score to 0 and a missing source_file to null", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-loops-whatsup-"));
    const file = join(dir, "todos.json");
    await writeFile(file, JSON.stringify({ items: [{ id: "a1", task: "t", project: "p", lens: "one_step" }] }), "utf8");
    const result = await readWhatsupBoard(file);
    expect(result.items).toEqual([{ id: "a1", task: "t", project: "p", lens: "one_step", score: 0, sourceType: "unknown", sourceFile: null }]);
  });
});
