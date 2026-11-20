// forgetSession: a retired session leaves the index (row, edges, file offsets) in one go,
// and never over-matches another session's paths.

import { describe, expect, it } from "vitest";
import { openDb, WorldDb } from "../db.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "99999999-2222-3333-4444-555555555555";

function seed(db: WorldDb, id: string): void {
  db.upsertSession({
    id,
    cwd: "/ws/p",
    islandId: "p",
    title: id,
    startedAt: "2026-09-24T00:00:00.000Z",
    lastActive: "2026-09-24T00:00:00.000Z",
    jsonlMtime: 0,
    messageCountDelta: 3,
    model: null,
    cntEditDelta: 0,
    cntResearchDelta: 0,
    cntBashDelta: 0,
    cntTextOnlyDelta: 0,
    cntAssistantTotalDelta: 0,
    tokensDelta: 1,
  });
  db.setFileOffset({ path: `/p/-ws-p/${id}.jsonl`, size: 10, mtime: 1, byteOffset: 10, malformedCount: 0 });
  db.setFileOffset({ path: `/p/-ws-p/${id}/subagents/agent-x.jsonl`, size: 5, mtime: 1, byteOffset: 5, malformedCount: 0 });
}

describe("WorldDb.forgetSession", () => {
  it("deletes the row and both offsets, leaves other sessions alone", () => {
    const db = new WorldDb(openDb(":memory:"));
    seed(db, A);
    seed(db, B);
    expect(db.forgetSession(A)).toEqual({ sessionsDeleted: 1, offsetsDeleted: 2 });
    expect(db.getSession(A)).toBeNull();
    expect(db.getFileOffset(`/p/-ws-p/${A}.jsonl`)).toBeNull();
    expect(db.getSession(B)).not.toBeNull();
    expect(db.getFileOffset(`/p/-ws-p/${B}.jsonl`)).not.toBeNull();
    expect(db.getFileOffset(`/p/-ws-p/${B}/subagents/agent-x.jsonl`)).not.toBeNull();
    db.close();
  });

  it("is a no-op for an unknown id and refuses non-ids", () => {
    const db = new WorldDb(openDb(":memory:"));
    expect(db.forgetSession(A)).toEqual({ sessionsDeleted: 0, offsetsDeleted: 0 });
    expect(() => db.forgetSession("%")).toThrow();
    expect(() => db.forgetSession("../x")).toThrow();
    db.close();
  });
});
