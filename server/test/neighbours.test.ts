// The "neighbours" server feature: each session's first and last MESSAGE (a user or assistant
// line), which the agent panel's crew rows window on. The bug it fixes (PR #49 review): crews
// used WorldAgent.startedAt / lastActive, which the indexer moves on ANY timestamped line
// (queue-operation, frame-link, attachment…) and sets to the file's mtime when a pass reads only
// untimestamped lines. Line shapes below are verbatim from ~/.claude/projects transcripts
// (d8ef046a's tail, 2026-09-28), with the session id swapped.

import { readdir, rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NEIGHBOURS_WINDOWS_PATH, type MessageWindow, type NeighboursFeatureMessage, type NeighboursWindowsResponse } from "../../shared/features/neighbours.js";
import type { WorldDb } from "../db.js";
import { createNeighboursFeature } from "../features/neighbours.js";
import { firstMessageAt, lastMessageAt, messageAt, mergeSpan, scanSpan, spanOfLines } from "../features/neighbours-lib.js";
import type { FeatureContext } from "../features/registry.js";
import { runIndexPass } from "../indexer.js";
import { appendToSessionFile, assistantLine, bootTestServer, makeTempDb, makeTempProjectsDir, userLine, writeSessionFile } from "./helpers.js";

const OLD = "d8ef046a-a4b8-4248-a5a5-58d8cd8f8c52"; // messages end 09-25 18:36, bookkeeping on 09-26 09:48
const NEW = "33704cb8-0000-4000-8000-000000000001"; // first message 09-26 09:46
const CWD = "/Users/alexboghossian";

const dequeue = (sid: string, ts: string): string => `{"type":"queue-operation","operation":"dequeue","timestamp":"${ts}","sessionId":"${sid}"}`;
const enqueue = (sid: string, ts: string): string => `{"type":"queue-operation","operation":"enqueue","timestamp":"${ts}","sessionId":"${sid}"}`;
const frameLink = (sid: string, ts: string): string => `{"type":"frame-link","artifactCount":1,"sessionId":"${sid}","timestamp":"${ts}"}`;
const lastPrompt = (sid: string): string => `{"type":"last-prompt","lastPrompt":"Go","leafUuid":"b2426bba-bf6b-4451-9bdb-bd27d75b5d17","sessionId":"${sid}"}`;
const costState = (sid: string): string => `{"type":"cost-state","sessionId":"${sid}","totalCostUSD":3.198252999999999,"totalAPIDuration":552429,"totalLinesAdded":497}`;
const attachment = (sid: string, ts: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, attachment: { type: "hook_success" }, rendered: "", type: "attachment", uuid: "u1", timestamp: ts, userType: "external", entrypoint: "cli", cwd: CWD, sessionId: sid, version: "2.1.283", gitBranch: "main" });
const user = (ts: string, text = "go"): string => userLine({ cwd: CWD, timestamp: ts, text });
const assistant = (ts: string): string => assistantLine({ cwd: CWD, timestamp: ts, messageId: `msg_${ts}` });
const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

describe("messageAt / spanOfLines: only user and assistant lines are messages", () => {
  it("bookkeeping lines are never messages, however recent their timestamp", () => {
    expect(messageAt(user("2026-09-25T18:30:00.000Z"))).toBe("2026-09-25T18:30:00.000Z");
    expect(messageAt(assistant("2026-09-25T18:36:10.000Z"))).toBe("2026-09-25T18:36:10.000Z");
    for (const l of [dequeue(OLD, "2026-09-26T09:48:36.132Z"), enqueue(OLD, "2026-09-26T09:48:00.000Z"), frameLink(OLD, "2026-09-26T09:48:36.268Z"), attachment(OLD, "2026-09-26T09:48:37.000Z"), lastPrompt(OLD), costState(OLD), "not json", ""]) {
      expect(messageAt(l)).toBeNull();
    }
  });

  it("a message line with no or a bad timestamp is not placed in time; a good one is normalized", () => {
    expect(messageAt(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }))).toBeNull();
    expect(messageAt(user("yesterday"))).toBeNull();
    expect(messageAt(user("2026-09-25T18:30:00Z"))).toBe("2026-09-25T18:30:00.000Z");
  });

  it("the span is the first to the last message; trailing bookkeeping does not stretch it", () => {
    const ls = [enqueue(OLD, "2026-09-25T09:59:00.000Z"), user("2026-09-25T10:00:00.000Z"), assistant("2026-09-25T18:36:10.000Z"), dequeue(OLD, "2026-09-26T09:48:36.132Z"), frameLink(OLD, "2026-09-26T09:48:36.268Z"), lastPrompt(OLD)];
    expect(spanOfLines(ls)).toEqual({ first: "2026-09-25T10:00:00.000Z", last: "2026-09-25T18:36:10.000Z" });
    expect(spanOfLines([dequeue(OLD, "2026-09-26T09:48:36.132Z"), lastPrompt(OLD)])).toBeNull();
    expect(spanOfLines([])).toBeNull();
  });

  it("merging keeps the earliest first and the latest last", () => {
    const a = { first: "2026-09-25T10:00:00.000Z", last: "2026-09-25T18:36:10.000Z" };
    expect(mergeSpan(undefined, a)).toEqual(a);
    expect(mergeSpan(a, { first: "2026-09-26T09:00:00.000Z", last: "2026-09-26T09:30:00.000Z" })).toEqual({ first: a.first, last: "2026-09-26T09:30:00.000Z" });
    expect(mergeSpan(a, { first: "2026-09-25T09:00:00.000Z", last: "2026-09-25T09:30:00.000Z" })).toEqual({ first: "2026-09-25T09:00:00.000Z", last: a.last });
  });
});

describe("scanning a transcript for its span", () => {
  async function file(body: string): Promise<string> {
    const dir = await makeTempProjectsDir();
    return writeSessionFile(dir, "-Users-alexboghossian", OLD, body);
  }

  it("reads the first message from the head and the last from the tail, within [0, end)", async () => {
    const path = await file(lines(enqueue(OLD, "2026-09-25T09:59:00.000Z"), user("2026-09-25T10:00:00.000Z"), assistant("2026-09-25T18:36:10.000Z"), dequeue(OLD, "2026-09-26T09:48:36.132Z"), frameLink(OLD, "2026-09-26T09:48:36.268Z"), lastPrompt(OLD), costState(OLD)));
    const { size } = await stat(path);
    expect(await scanSpan(path, size)).toEqual({ first: "2026-09-25T10:00:00.000Z", last: "2026-09-25T18:36:10.000Z" });
    await appendToSessionFile(path, lines(user("2026-09-26T11:00:00.000Z")));
    expect(await lastMessageAt(path, size)).toBe("2026-09-25T18:36:10.000Z"); // past `end` is the indexer's
    expect(await scanSpan(path, 0)).toBeNull();
  });

  it("finds the last message when lines span chunk boundaries and the last one is bigger than a chunk", async () => {
    const big = assistantLine({ cwd: CWD, timestamp: "2026-09-25T18:36:10.000Z", text: "x".repeat(5_000) });
    const path = await file(lines(user("2026-09-25T10:00:00.000Z"), big, dequeue(OLD, "2026-09-26T09:48:36.132Z"), lastPrompt(OLD)));
    const { size } = await stat(path);
    for (const chunk of [7, 64, 1024, 65_536]) expect(await lastMessageAt(path, size, chunk)).toBe("2026-09-25T18:36:10.000Z");
    expect(await firstMessageAt(path, size)).toBe("2026-09-25T10:00:00.000Z");
  });

  it("a transcript with no message has no span", async () => {
    const path = await file(lines(dequeue(OLD, "2026-09-26T09:48:36.132Z"), lastPrompt(OLD), costState(OLD)));
    const { size } = await stat(path);
    expect(await scanSpan(path, size)).toBeNull();
    expect(await lastMessageAt(path, size, 5)).toBeNull();
  });
});

function fakeCtx(db: WorldDb, emitted: NeighboursFeatureMessage[]): FeatureContext {
  return {
    db,
    featureId: "neighbours",
    emit: (payload: unknown) => emitted.push(payload as NeighboursFeatureMessage),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as FeatureContext;
}

const served = (r: NeighboursWindowsResponse): MessageWindow[] => r.windows.slice().sort((a, b) => (a.id < b.id ? -1 : 1));

describe("the neighbours feature", () => {
  async function world(): Promise<{ dir: string; db: WorldDb; oldFile: string; newFile: string }> {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const oldFile = await writeSessionFile(
      dir,
      "-Users-alexboghossian",
      OLD,
      lines(user("2026-09-25T10:00:00.000Z"), assistant("2026-09-25T18:36:10.000Z"), dequeue(OLD, "2026-09-26T09:48:36.132Z"), frameLink(OLD, "2026-09-26T09:48:36.268Z"), lastPrompt(OLD)),
    );
    const newFile = await writeSessionFile(dir, "-Users-alexboghossian", NEW, lines(attachment(NEW, "2026-09-26T09:40:00.000Z"), user("2026-09-26T09:46:00.000Z"), assistant("2026-09-26T12:00:00.000Z")));
    await runIndexPass(db, { projectsDir: dir }); // the boot pass: no onIndexPass
    return { dir, db, oldFile, newFile };
  }

  it("serves message windows, not the indexer's [startedAt, lastActive] (the d8ef046a | 33704cb8 false crew)", async () => {
    const { db } = await world();
    // The source of the bug: bookkeeping lines move lastActive a day past the last message.
    expect(db.getSession(OLD)?.lastActive).toBe("2026-09-26T09:48:36.268Z");
    expect(db.getSession(NEW)?.startedAt).toBe("2026-09-26T09:40:00.000Z");

    const emitted: NeighboursFeatureMessage[] = [];
    const ctx = fakeCtx(db, emitted);
    const feature = createNeighboursFeature();
    expect(feature.windows(ctx)).toEqual({ ready: false, windows: [] }); // nothing until the scan is done: no crew beats a false one
    expect(feature.snapshotExtras).toBeUndefined(); // one row per session: not in /api/world
    await feature.scanned(ctx);
    const windows = served(feature.windows(ctx));
    expect(windows).toEqual([
      { id: NEW, first: "2026-09-26T09:46:00.000Z", last: "2026-09-26T12:00:00.000Z" },
      { id: OLD, first: "2026-09-25T10:00:00.000Z", last: "2026-09-25T18:36:10.000Z" },
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe("windows");
    expect(emitted[0]?.windows).toHaveLength(2);
    db.close();
  });

  it("new messages move the window on the next pass; bookkeeping and untimestamped lines don't (no mtime fallback)", async () => {
    const { dir, db, oldFile } = await world();
    const emitted: NeighboursFeatureMessage[] = [];
    const ctx = fakeCtx(db, emitted);
    const feature = createNeighboursFeature();
    await feature.scanned(ctx);
    emitted.length = 0;

    await appendToSessionFile(oldFile, lines(lastPrompt(OLD), costState(OLD)));
    let pass = await runIndexPass(db, { projectsDir: dir, collectLines: true });
    expect((db.getSession(OLD)?.lastActive ?? "") > "2026-09-26T09:48:36.268Z").toBe(true); // the indexer's mtime fallback
    await feature.onIndexPass?.(ctx, pass.linesBySession);
    expect(emitted).toEqual([]);
    expect(served(feature.windows(ctx)).find((w) => w.id === OLD)?.last).toBe("2026-09-25T18:36:10.000Z");

    await appendToSessionFile(oldFile, lines(enqueue(OLD, "2026-09-26T13:00:00.000Z"), user("2026-09-26T13:00:05.000Z"), dequeue(OLD, "2026-09-26T13:00:06.000Z")));
    pass = await runIndexPass(db, { projectsDir: dir, collectLines: true });
    await feature.onIndexPass?.(ctx, pass.linesBySession);
    expect(emitted).toEqual([{ kind: "windows", windows: [{ id: OLD, first: "2026-09-25T10:00:00.000Z", last: "2026-09-26T13:00:05.000Z" }] }]);
    db.close();
  });

  it("lines that arrive before the scan finishes are merged, and a session first seen by a pass is windowed from its first line", async () => {
    const { dir, db } = await world();
    const emitted: NeighboursFeatureMessage[] = [];
    const ctx = fakeCtx(db, emitted);
    const feature = createNeighboursFeature();
    const later = "5e4d3c2b-0000-4000-8000-000000000002";
    await writeSessionFile(dir, "-Users-alexboghossian", later, lines(enqueue(later, "2026-09-27T08:00:00.000Z"), user("2026-09-27T08:00:01.000Z"), assistant("2026-09-27T08:20:00.000Z")));
    const pass = await runIndexPass(db, { projectsDir: dir, collectLines: true });
    await feature.onIndexPass?.(ctx, pass.linesBySession); // starts the scan; nothing is emitted before it is done
    expect(emitted).toEqual([]);
    await feature.scanned(ctx);
    expect(served(feature.windows(ctx)).find((w) => w.id === later)).toEqual({ id: later, first: "2026-09-27T08:00:01.000Z", last: "2026-09-27T08:20:00.000Z" });
    db.close();
  });

  it("a transcript that is gone is skipped: that session has no window, the others do", async () => {
    const { db, oldFile } = await world();
    await rm(oldFile);
    const feature = createNeighboursFeature();
    const ctx = fakeCtx(db, []);
    await feature.scanned(ctx);
    expect(served(feature.windows(ctx)).map((w) => w.id)).toEqual([NEW]);
    db.close();
  });

  it("the boot scan is a read: the db is unchanged and no backup or migration is written", async () => {
    const { dir, db } = await world();
    const before = JSON.stringify([db.listSessions(), db.listFileOffsets(), db.listEdges()]);
    const filesBefore = await readdir(dir);
    await createNeighboursFeature().scanned(fakeCtx(db, []));
    expect(JSON.stringify([db.listSessions(), db.listFileOffsets(), db.listEdges()])).toBe(before);
    expect((await readdir(dir)).filter((f) => !filesBefore.includes(f) && !f.startsWith("world.db"))).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.endsWith(".bak"))).toEqual([]);
    db.close();
  });
});

describe("registered in the real feature list", () => {
  it("GET /api/neighbours/windows serves the message windows once the scan is done; /api/world no longer carries them", async () => {
    const projectsDir = await makeTempProjectsDir();
    await writeSessionFile(projectsDir, "-Users-alexboghossian", OLD, lines(user("2026-09-25T10:00:00.000Z"), assistant("2026-09-25T18:36:10.000Z"), dequeue(OLD, "2026-09-26T09:48:36.132Z")));
    const { base, server } = await bootTestServer({ configOverrides: { projectsDir } });
    try {
      let answer: NeighboursWindowsResponse | undefined;
      for (let i = 0; i < 100 && !answer?.ready; i++) {
        answer = (await (await fetch(`${base}${NEIGHBOURS_WINDOWS_PATH}`)).json()) as NeighboursWindowsResponse;
        if (!answer.ready) await new Promise((r) => setTimeout(r, 20));
      }
      expect(answer?.windows).toEqual([{ id: OLD, first: "2026-09-25T10:00:00.000Z", last: "2026-09-25T18:36:10.000Z" }]);
      const world = (await (await fetch(`${base}/api/world`)).json()) as { agents: Array<{ id: string; lastActive: string }>; extras?: Record<string, unknown> };
      expect(world.agents.find((a) => a.id === OLD)?.lastActive).toBe("2026-09-26T09:48:36.132Z");
      expect(world.extras?.["neighbours.messageWindows"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
