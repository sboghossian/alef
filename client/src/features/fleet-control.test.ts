import { describe, expect, it } from "vitest";
import { parseApproval } from "./approvals";
import { parsePairs } from "./conflicts";
import { parseTodoList, todoHeadline } from "./todos";

const list = (statuses: ("pending" | "in_progress" | "completed")[], activeForm: string | null = "Running tests") => ({
  agentId: "a",
  updatedAt: "2026-09-24T10:00:00.000Z",
  items: statuses.map((status, i) => ({ content: `Task ${i + 1}`, status, activeForm })),
});

describe("todoHeadline", () => {
  it("shows progress and the in-progress activeForm", () => {
    expect(todoHeadline(list(["completed", "completed", "completed", "in_progress", "pending", "pending", "pending"]))).toBe("3/7 · Now: Running tests");
  });
  it("falls back to the content, then Next:, then All done", () => {
    expect(todoHeadline(list(["in_progress"], null))).toBe("0/1 · Now: Task 1");
    expect(todoHeadline(list(["completed", "pending"]))).toBe("1/2 · Next: Task 2");
    expect(todoHeadline(list(["completed", "completed"]))).toBe("2/2 · All done");
  });
});

describe("parsers drop malformed server payloads", () => {
  it("parseTodoList filters bad items and rejects bad shapes", () => {
    const parsed = parseTodoList({ ...list(["pending"]), items: [{ content: "ok", status: "pending", activeForm: null }, { content: 1, status: "pending" }, "x"] });
    expect(parsed?.items).toEqual([{ content: "ok", status: "pending", activeForm: null }]);
    expect(parseTodoList({ agentId: "a" })).toBeNull();
    expect(parseTodoList(null)).toBeNull();
  });

  it("parsePairs keeps only well-formed pairs", () => {
    const good = { a: "x", b: "y", files: ["/f"], at: "2026-09-24T10:00:00.000Z" };
    expect(parsePairs([good, { a: "x", b: "y", files: [1], at: "t" }, null])).toEqual([good]);
    expect(parsePairs("nope")).toEqual([]);
  });

  it("parseApproval validates every field, including the preview kind", () => {
    const good = {
      id: "1",
      agentId: "s",
      cwd: "/r",
      toolName: "Bash",
      preview: { kind: "command", title: "t", body: "ls" },
      createdAt: "2026-09-24T10:00:00.000Z",
      expiresAt: "2026-09-24T10:01:05.000Z",
    };
    expect(parseApproval(good)).toEqual(good);
    expect(parseApproval({ ...good, preview: { kind: "html", title: "t", body: "<b>" } })).toBeNull();
    expect(parseApproval({ ...good, id: 5 })).toBeNull();
  });
});

describe("occludedByPlanet", () => {
  it("hides points on the far side and keeps near-side and low-camera points", async () => {
    const THREE = await import("three");
    const { occludedByPlanet } = await import("./fleet-overlay");
    const cam = new THREE.Vector3(0, 0, 150);
    expect(occludedByPlanet(cam, new THREE.Vector3(0, 0, 51))).toBe(false); // facing us
    expect(occludedByPlanet(cam, new THREE.Vector3(0, 0, -51))).toBe(true); // behind the planet
    // Camera skimming low next to a roof on high terrain: still visible.
    expect(occludedByPlanet(new THREE.Vector3(55, 0, 0), new THREE.Vector3(56, 3, 0))).toBe(false);
  });
});
