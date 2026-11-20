import { describe, expect, it } from "vitest";
import type { SkillEvent } from "../../shared/features/skills.js";
import { SkillsStore, skillsStorePathFor } from "../features/skills-store.js";

function ev(o: Partial<SkillEvent> & Pick<SkillEvent, "skillName" | "at">): SkillEvent {
  return { sessionId: "s1", kind: "invoke", ...o };
}

describe("SkillsStore", () => {
  it("inserts new events and returns exactly the ones that were new", () => {
    const store = new SkillsStore(":memory:");
    const a = ev({ skillName: "grill-me", at: "2026-09-25T10:00:00.000Z" });
    const b = ev({ skillName: "linear", at: "2026-09-25T10:01:00.000Z", kind: "slash" });
    expect(store.insertEvents([a, b])).toEqual([a, b]);
    // exact re-processing of the same lines (same session+skill+kind+timestamp) is a no-op
    expect(store.insertEvents([a, b])).toEqual([]);
    // a third, genuinely new event alongside two dupes: only it comes back
    const c = ev({ skillName: "grill-me", at: "2026-09-25T10:02:00.000Z" });
    expect(store.insertEvents([a, b, c])).toEqual([c]);
    store.close();
  });

  it("eventsForSession returns only that session's events, oldest first", () => {
    const store = new SkillsStore(":memory:");
    const s1a = ev({ sessionId: "s1", skillName: "b", at: "2026-09-25T10:02:00.000Z" });
    const s1b = ev({ sessionId: "s1", skillName: "a", at: "2026-09-25T10:00:00.000Z" });
    const s2 = ev({ sessionId: "s2", skillName: "c", at: "2026-09-25T10:01:00.000Z" });
    store.insertEvents([s1a, s1b, s2]);
    expect(store.eventsForSession("s1")).toEqual([s1b, s1a]);
    expect(store.eventsForSession("s2")).toEqual([s2]);
    expect(store.eventsForSession("unknown")).toEqual([]);
    store.close();
  });

  it("recentEvents returns newest first, capped at the limit", () => {
    const store = new SkillsStore(":memory:");
    const events = [0, 1, 2, 3].map((i) => ev({ skillName: `s${i}`, at: `2026-09-25T10:0${i}:00.000Z` }));
    store.insertEvents(events);
    expect(store.recentEvents(2)).toEqual([events[3], events[2]]);
    expect(store.recentEvents(100)).toHaveLength(4);
    store.close();
  });

  it("eventsSince filters by timestamp and by kind", () => {
    const store = new SkillsStore(":memory:");
    const old = ev({ skillName: "old", at: "2026-01-01T00:00:00.000Z", kind: "invoke" });
    const recentInvoke = ev({ skillName: "recent", at: "2026-09-25T00:00:00.000Z", kind: "invoke" });
    const recentSuggested = ev({ skillName: "recent2", at: "2026-09-25T00:00:00.000Z", kind: "suggested" });
    store.insertEvents([old, recentInvoke, recentSuggested]);
    expect(store.eventsSince("2026-06-01T00:00:00.000Z", ["invoke", "slash", "suggested"])).toEqual([recentInvoke, recentSuggested]);
    expect(store.eventsSince("2026-06-01T00:00:00.000Z", ["invoke"])).toEqual([recentInvoke]);
    expect(store.eventsSince("1970-01-01T00:00:00.000Z", ["invoke", "slash", "suggested"])).toHaveLength(3);
    store.close();
  });

  it("skillsStorePathFor: alongside world.db, or :memory: for a :memory: world db", () => {
    expect(skillsStorePathFor("/x/y/world.db")).toBe("/x/y/skills.db");
    expect(skillsStorePathFor(":memory:")).toBe(":memory:");
  });

  it("file offsets and meta default to 0 / null, then round-trip", () => {
    const store = new SkillsStore(":memory:");
    expect(store.getFileOffset("/x/y.jsonl")).toBe(0);
    expect(store.getMeta("backfill_done")).toBeNull();
    store.setFileOffset("/x/y.jsonl", 42);
    store.setMeta("backfill_done", "1");
    expect(store.getFileOffset("/x/y.jsonl")).toBe(42);
    expect(store.getMeta("backfill_done")).toBe("1");
    store.setFileOffset("/x/y.jsonl", 100); // overwrites, doesn't add a second row
    expect(store.getFileOffset("/x/y.jsonl")).toBe(100);
    store.close();
  });

  it("applyBackfillBatch inserts events and advances the file offset in one transaction", () => {
    const store = new SkillsStore(":memory:");
    const a = ev({ sessionId: "s1", skillName: "grill-me", at: "2026-01-01T00:00:00.000Z" });
    store.applyBackfillBatch({ path: "/x/y.jsonl", fileOffset: 123, events: [a] });
    expect(store.eventsForSession("s1")).toEqual([a]);
    expect(store.getFileOffset("/x/y.jsonl")).toBe(123);
    // re-applying the same batch (e.g. a retried pass) doesn't duplicate the event, but the
    // offset still moves — an empty events list is a valid, common batch (a file whose only
    // new lines carried no skill activity).
    store.applyBackfillBatch({ path: "/x/y.jsonl", fileOffset: 200, events: [a] });
    expect(store.eventsForSession("s1")).toEqual([a]);
    expect(store.getFileOffset("/x/y.jsonl")).toBe(200);
    store.close();
  });
});
