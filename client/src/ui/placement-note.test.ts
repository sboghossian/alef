import { describe, expect, it } from "vitest";
import type { Island } from "../../../shared/types";
import { placementNote } from "./placement-note";

const island = (id: string, path: string): Island => ({ id, name: path.split("/").pop() ?? id, path, agentCount: 1, lastActive: "" });
const islands = [island("alexboghossian", "/Users/s"), island("acme-ai-next", "/Users/s/Documents/Code/acme-ai-next"), island("root", "/")];

describe("placementNote", () => {
  it("says nothing when the cwd is the city's own path", () => {
    expect(placementNote({ cwd: "/Users/s/Documents/Code/acme-ai-next", islandId: "acme-ai-next" }, islands)).toBeUndefined();
  });
  it("names a subfolder relative to the repo", () => {
    expect(placementNote({ cwd: "/Users/s/Documents/Code/acme-ai-next/apps/main", islandId: "acme-ai-next" }, islands)).toBe("in apps/main");
  });
  it("names a linked worktree without its worktrees folder", () => {
    expect(placementNote({ cwd: "/Users/s/.acme-worktrees/tick-1791", islandId: "acme-ai-next" }, islands)).toBe("worktree: tick-1791");
    expect(placementNote({ cwd: "/Users/s/.acme-worktrees/tick-1982/apps/main", islandId: "acme-ai-next" }, islands)).toBe("worktree: tick-1982/apps/main");
  });
  it("keeps the touched-files note for a re-homed home session", () => {
    expect(placementNote({ cwd: "/Users/s", islandId: "acme-ai-next" }, islands)).toBe("placed by touched files: acme-ai-next");
  });
  it("never calls a catch-all a worktree, even without its own city", () => {
    expect(placementNote({ cwd: "/Users/s", islandId: "acme-ai-next" }, islands.filter((i) => i.id !== "alexboghossian"))).toBeUndefined();
    expect(placementNote({ cwd: "/", islandId: "acme-ai-next" }, islands.filter((i) => i.id !== "root"))).toBeUndefined();
  });
});
