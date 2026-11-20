// Regression test for a real failure found while verifying against production data:
// real session titles are natural-language prompts full of function words ("on",
// "the", "who", ...). Before stopwords were filtered out of the query, a question
// like "who worked on the Jessica email?" scored every unrelated title that merely
// contained "on" or "the" right alongside the one that actually mentioned Jessica,
// and the real match was crowded out of the top-40 candidates entirely.

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { prefilterCandidates, type AskJevAgentInput } from "../ask-jev.js";
import { makeTempDb, makeTempProjectsDir } from "./helpers.js";
import type { WorldDb } from "../db.js";

const tmpDirs: string[] = [];
const dbs: WorldDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function seededDb(): Promise<WorldDb> {
  const dir = await makeTempProjectsDir();
  tmpDirs.push(dir);
  const db = await makeTempDb(dir);
  dbs.push(db);
  return db;
}

describe("prefilterCandidates", () => {
  it("does not let common words crowd out the one candidate with the distinctive term", async () => {
    const db = await seededDb();
    const target: AskJevAgentInput = {
      id: "target",
      islandId: "acme-ai-next",
      cwd: "/ws/acme-ai-next",
      title: "read the transcript. Hi, Jessica. Hi, Stefan. Finally.",
      lastActive: "2026-09-20T00:00:00.000Z",
    };
    // 50 decoys, each stuffed with the stopwords the real question also contains
    // ("who", "on", "the"), but with nothing distinctive to the real question.
    const decoys: AskJevAgentInput[] = Array.from({ length: 50 }, (_, i) => ({
      id: `decoy-${i}`,
      islandId: "agent-world",
      cwd: "/ws/agent-world",
      title: "who is on the team, and who should work on the renderer and the docs",
      lastActive: "2026-09-22T00:00:00.000Z", // more recent than target — recency alone must not win
    }));

    const top = prefilterCandidates(db, "who worked on the Jessica email?", [target, ...decoys], 40);
    expect(top[0]?.id).toBe("target");
  });

  it("still returns decoys when nothing matches the distinctive term (pure recency tiebreak)", async () => {
    const db = await seededDb();
    const agents: AskJevAgentInput[] = [
      { id: "a", islandId: "x", cwd: "/ws/x", title: "who is on the team", lastActive: "2026-09-20T00:00:00.000Z" },
      { id: "b", islandId: "x", cwd: "/ws/x", title: "who is on the team", lastActive: "2026-09-21T00:00:00.000Z" },
    ];
    const top = prefilterCandidates(db, "who worked on the team?", agents, 40);
    expect(top.map((a) => a.id)).toEqual(["b", "a"]); // tied score (0, all stopwords) -> most recent first
  });

  it("scores a touched-file basename match", async () => {
    const db = await seededDb();
    db.setIslandForCwd("/ws/agent-world", "agent-world");
    db.upsertSession({
      id: "file-match",
      cwd: "/ws/agent-world",
      islandId: "agent-world",
      title: "generic session with no useful title",
      startedAt: "2026-09-20T00:00:00.000Z",
      lastActive: "2026-09-20T00:00:00.000Z",
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 1,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 0,
      cntAssistantTotalDelta: 1,
    });
    db.upsertObjectShell({ id: "file:/ws/agent-world/dispatch.ts", kind: "file", name: "dispatch.ts", islandId: "agent-world" });
    db.upsertEdge({ from: "file-match", to: "file:/ws/agent-world/dispatch.ts", kind: "touched", at: "2026-09-20T00:00:00.000Z" });

    const other: AskJevAgentInput = { id: "other", islandId: "y", cwd: "/ws/y", title: "unrelated", lastActive: "2026-09-22T00:00:00.000Z" };
    const target: AskJevAgentInput = { id: "file-match", islandId: "agent-world", cwd: "/ws/agent-world", title: "generic session with no useful title", lastActive: "2026-09-20T00:00:00.000Z" };

    const top = prefilterCandidates(db, "who touched dispatch.ts?", [other, target], 40);
    expect(top[0]?.id).toBe("file-match");
  });
});
