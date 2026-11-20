import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { localDateKey } from "../heuristics.js";
import { runIndexPass } from "../indexer.js";
import { appendToSessionFile, assistantLine, makeTempDb, makeTempProjectsDir, userLine, writeSessionFile } from "./helpers.js";

describe("indexer", () => {
  it("indexes a normal session: cwd, title, model, tool-touched file", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "workspace", "demo-project");
    const sessionId = "11111111-1111-1111-1111-111111111111";

    const body = [
      userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "Please fix the bug in main.ts" }),
      assistantLine({
        cwd,
        timestamp: "2026-09-20T10:00:05.000Z",
        model: "claude-opus-5-5",
        toolUses: [{ name: "Edit", input: { file_path: join(cwd, "main.ts") } }],
      }),
    ].join("\n") + "\n";
    await writeSessionFile(dir, "-workspace-demo-project", sessionId, body);

    const stats = await runIndexPass(db, { projectsDir: dir });
    expect(stats.filesScanned).toBe(1);
    expect(stats.malformedLines).toBe(0);
    expect(stats.sessionsTouched).toBe(1);

    const session = db.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.cwd).toBe(cwd);
    expect(session?.title).toBe("Please fix the bug in main.ts");
    expect(session?.model).toBe("claude-opus-5-5");
    expect(session?.messageCount).toBe(2);
    expect(session?.cntEdit).toBe(1);

    const objects = db.listObjectsWithUsage();
    const fileObj = objects.find((o) => o.id === `file:${join(cwd, "main.ts")}`);
    expect(fileObj).toBeDefined();
    expect(fileObj?.usage).toBe(1);

    const edges = db.listEdges();
    expect(edges.some((e) => e.from === sessionId && e.to === fileObj?.id && e.kind === "touched")).toBe(true);

    db.close();
  });

  it("skips a malformed line but keeps indexing the rest, and counts it", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "broken-project");
    const sessionId = "22222222-2222-2222-2222-222222222222";

    const body =
      [
        userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "hello" }),
        "{not valid json at all",
        assistantLine({ cwd, timestamp: "2026-09-20T10:00:05.000Z" }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-ws-broken-project", sessionId, body);

    const stats = await runIndexPass(db, { projectsDir: dir });
    expect(stats.malformedLines).toBe(1);
    expect(stats.linesProcessed).toBe(3);

    const session = db.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.messageCount).toBe(2); // the malformed line contributed nothing

    db.close();
  });

  it("defers a truncated last line until it is completed, without losing earlier lines", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "trunc-project");
    const sessionId = "33333333-3333-3333-3333-333333333333";

    const completeLine = userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "first message" });
    const truncatedTail = '{"type":"user","timestamp":"2026-09-20T10:05:00.000Z","cwd":"' + cwd + '","message":{"role":"user","content":[{"type":"text","text":"cut off mid-wr';
    const filePath = await writeSessionFile(dir, "-ws-trunc-project", sessionId, completeLine + "\n" + truncatedTail);

    const stats1 = await runIndexPass(db, { projectsDir: dir });
    expect(stats1.linesProcessed).toBe(1); // only the complete line
    const afterFirstPass = db.getSession(sessionId);
    expect(afterFirstPass?.messageCount).toBe(1);

    const offset = db.getFileOffset(filePath);
    expect(offset).not.toBeNull();
    expect(offset!.byteOffset).toBeLessThan(offset!.size); // truncated tail's bytes not yet consumed

    // File grows: the truncated line is completed and a new one is appended.
    const finishedLine = '"}]}}\n';
    const nextLine = userLine({ cwd, timestamp: "2026-09-20T10:06:00.000Z", text: "second message" }) + "\n";
    await appendToSessionFile(filePath, finishedLine + nextLine);

    const stats2 = await runIndexPass(db, { projectsDir: dir });
    expect(stats2.linesProcessed).toBe(2); // the now-completed line + the new one
    expect(stats2.filesSkippedUnchanged).toBe(0);

    const afterSecondPass = db.getSession(sessionId);
    expect(afterSecondPass?.messageCount).toBe(3);

    db.close();
  });

  it("handles an empty projects dir without error", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const stats = await runIndexPass(db, { projectsDir: dir });
    expect(stats.filesScanned).toBe(0);
    expect(stats.sessionsTouched).toBe(0);
    db.close();
  });

  it("handles a nonexistent projects dir without throwing", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const stats = await runIndexPass(db, { projectsDir: join(dir, "does-not-exist") });
    expect(stats.filesScanned).toBe(0);
    db.close();
  });

  it("incremental re-scan only processes newly appended lines", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "incr-project");
    const sessionId = "44444444-4444-4444-4444-444444444444";

    const filePath = await writeSessionFile(
      dir,
      "-ws-incr-project",
      sessionId,
      userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "first" }) + "\n",
    );

    const stats1 = await runIndexPass(db, { projectsDir: dir });
    expect(stats1.linesProcessed).toBe(1);

    // Re-scanning with nothing new should skip the file entirely.
    const stats2 = await runIndexPass(db, { projectsDir: dir });
    expect(stats2.filesSkippedUnchanged).toBe(1);
    expect(stats2.linesProcessed).toBe(0);

    await appendToSessionFile(
      filePath,
      assistantLine({
        cwd,
        timestamp: "2026-09-20T10:01:00.000Z",
        toolUses: [{ name: "Bash", input: { command: "npm test" } }],
      }) + "\n",
    );

    const stats3 = await runIndexPass(db, { projectsDir: dir });
    expect(stats3.linesProcessed).toBe(1); // only the new line, not a re-read of line 1
    expect(stats3.filesSkippedUnchanged).toBe(0);

    const session = db.getSession(sessionId);
    expect(session?.messageCount).toBe(2);
    expect(session?.cntBash).toBe(1);

    db.close();
  });
});

describe("indexer: tokens", () => {
  it("sums input+output+cache_creation across assistant turns, excluding cache_read", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "tokens-project");
    const sessionId = "55555555-5555-5555-5555-555555555555";

    const body =
      [
        userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "go" }),
        assistantLine({
          cwd,
          timestamp: "2026-09-20T10:00:01.000Z",
          usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 999_999 },
        }),
        assistantLine({
          cwd,
          timestamp: "2026-09-20T10:00:02.000Z",
          usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 100 },
        }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-ws-tokens-project", sessionId, body);

    await runIndexPass(db, { projectsDir: dir });
    const session = db.getSession(sessionId);
    // (10+20+5) + (1+2+0) = 38 — the two cache_read fields must not appear in this sum.
    expect(session?.tokens).toBe(38);

    db.close();
  });

  it("does not double-count one turn streamed across multiple lines with the same message.id", async () => {
    // Real transcripts split one logical assistant turn into several jsonl lines
    // (e.g. a "thinking" line, then a "tool_use" line) that all repeat the same
    // message.id and the same cumulative usage block.
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "dedup-project");
    const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const body =
      [
        userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "go" }),
        assistantLine({
          cwd,
          timestamp: "2026-09-20T10:00:01.000Z",
          thinking: true,
          messageId: "msg_A",
          usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5 },
        }),
        assistantLine({
          cwd,
          timestamp: "2026-09-20T10:00:01.500Z",
          toolUses: [{ name: "Bash", input: { command: "echo hi" } }],
          messageId: "msg_A", // same turn, same (repeated) usage snapshot
          usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5 },
        }),
        assistantLine({
          cwd,
          timestamp: "2026-09-20T10:00:03.000Z",
          messageId: "msg_B", // a genuinely new turn must still be counted
          usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0 },
        }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-ws-dedup-project", sessionId, body);

    await runIndexPass(db, { projectsDir: dir });
    // msg_A counted once (35) + msg_B (3) = 38, not 35+35+3=73.
    expect(db.getSession(sessionId)?.tokens).toBe(38);

    db.close();
  });

  it("dedup survives an incremental pass boundary landing mid-turn", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "dedup-boundary-project");
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    const filePath = await writeSessionFile(
      dir,
      "-ws-dedup-boundary-project",
      sessionId,
      assistantLine({
        cwd,
        timestamp: "2026-09-20T10:00:01.000Z",
        thinking: true,
        messageId: "msg_A",
        usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5 },
      }) + "\n",
    );
    await runIndexPass(db, { projectsDir: dir });
    expect(db.getSession(sessionId)?.tokens).toBe(35);

    // The second half of the SAME turn arrives in a later incremental pass.
    await appendToSessionFile(
      filePath,
      assistantLine({
        cwd,
        timestamp: "2026-09-20T10:00:01.500Z",
        toolUses: [{ name: "Bash", input: { command: "echo hi" } }],
        messageId: "msg_A",
        usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5 },
      }) + "\n",
    );
    await runIndexPass(db, { projectsDir: dir });
    expect(db.getSession(sessionId)?.tokens).toBe(35); // still 35, the repeat was not re-counted

    db.close();
  });

  it("buckets tokensToday per local calendar day, and re-indexing does not double-count", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "midnight-project");
    const sessionId = "66666666-6666-6666-6666-666666666666";

    // Two timestamps 3 days apart at UTC noon land on different local calendar days
    // in every timezone (max UTC offset is +/-14h), so this is not tz-flaky.
    const day1 = "2026-09-20T12:00:00.000Z";
    const day2 = "2026-09-23T12:00:00.000Z";
    const key1 = localDateKey(new Date(day1));
    const key2 = localDateKey(new Date(day2));
    expect(key1).not.toBe(key2);

    const body =
      [
        userLine({ cwd, timestamp: day1, text: "go" }),
        assistantLine({ cwd, timestamp: day1, usage: { inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 0 } }),
        assistantLine({ cwd, timestamp: day2, usage: { inputTokens: 7, outputTokens: 0, cacheCreationInputTokens: 0 } }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-ws-midnight-project", sessionId, body);

    await runIndexPass(db, { projectsDir: dir });
    expect(db.getDayTokens(key1)).toBe(100);
    expect(db.getDayTokens(key2)).toBe(7);

    // Re-scanning with nothing new must not bump either bucket again.
    await runIndexPass(db, { projectsDir: dir });
    expect(db.getDayTokens(key1)).toBe(100);
    expect(db.getDayTokens(key2)).toBe(7);

    db.close();
  });
});

describe("indexer: last-line state (awaitingInput support)", () => {
  it("an AskUserQuestion tool call is the last meaningful line", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "ask-project");
    const sessionId = "77777777-7777-7777-7777-777777777777";

    const body =
      [
        userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "pick one" }),
        assistantLine({ cwd, timestamp: "2026-09-20T10:00:01.000Z", toolUses: [{ name: "AskUserQuestion", input: {} }] }),
      ].join("\n") + "\n";
    const filePath = await writeSessionFile(dir, "-ws-ask-project", sessionId, body);

    await runIndexPass(db, { projectsDir: dir });
    let session = db.getSession(sessionId);
    expect(session?.lastLineKind).toBe("assistant_tool");
    expect(session?.lastToolName).toBe("AskUserQuestion");

    // A later plain user line resolves it — this is the "no tool_result after it" clearing.
    await appendToSessionFile(
      filePath,
      userLine({ cwd, timestamp: "2026-09-20T10:00:05.000Z", text: "the first one" }) + "\n",
    );
    await runIndexPass(db, { projectsDir: dir });
    session = db.getSession(sessionId);
    expect(session?.lastLineKind).toBe("user");
    expect(session?.lastToolName).toBeNull();

    db.close();
  });

  it("a text-only assistant turn ending in '?' sets textIsQuestion", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "question-project");
    const sessionId = "88888888-8888-8888-8888-888888888888";

    const body =
      [
        userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "go" }),
        assistantLine({ cwd, timestamp: "2026-09-20T10:00:01.000Z", text: "Should I use tabs or spaces?" }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-ws-question-project", sessionId, body);

    await runIndexPass(db, { projectsDir: dir });
    const session = db.getSession(sessionId);
    expect(session?.lastLineKind).toBe("assistant_text");
    expect(session?.lastTextIsQuestion).toBe(true);

    db.close();
  });

  it("a pass with only non-meaningful lines leaves the prior state untouched", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "noop-project");
    const sessionId = "99999999-9999-9999-9999-999999999999";

    await writeSessionFile(
      dir,
      "-ws-noop-project",
      sessionId,
      assistantLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", toolUses: [{ name: "AskUserQuestion", input: {} }] }) + "\n",
    );
    const filePath = join(dir, "-ws-noop-project", `${sessionId}.jsonl`);
    await runIndexPass(db, { projectsDir: dir });
    expect(db.getSession(sessionId)?.lastLineKind).toBe("assistant_tool");

    await appendToSessionFile(filePath, JSON.stringify({ type: "queue-operation", timestamp: "2026-09-20T10:00:02.000Z" }) + "\n");
    await runIndexPass(db, { projectsDir: dir });
    expect(db.getSession(sessionId)?.lastLineKind).toBe("assistant_tool");
    expect(db.getSession(sessionId)?.lastToolName).toBe("AskUserQuestion");

    db.close();
  });
});

describe("indexer: activity collection", () => {
  it("derives nothing during the cold first pass even though collectActivity defaults were not set", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "activity-cold-project");
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    const body =
      [
        userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "fix the bug" }),
        assistantLine({ cwd, timestamp: "2026-09-20T10:00:01.000Z", toolUses: [{ name: "Edit", input: { file_path: join(cwd, "a.ts") } }] }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-ws-activity-cold-project", sessionId, body);

    const stats = await runIndexPass(db, { projectsDir: dir }); // collectActivity omitted -> false
    expect(stats.activities).toEqual([]);

    db.close();
  });

  it("derives activity for new lines when collectActivity is explicitly true, tagged with the session id", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const cwd = join(dir, "ws", "activity-hot-project");
    const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const filePath = await writeSessionFile(
      dir,
      "-ws-activity-hot-project",
      sessionId,
      userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "fix the bug" }) + "\n",
    );
    // Cold pass: never collects, regardless of the option, matches production wiring.
    await runIndexPass(db, { projectsDir: dir });

    await appendToSessionFile(
      filePath,
      assistantLine({ cwd, timestamp: "2026-09-20T10:00:05.000Z", toolUses: [{ name: "Edit", input: { file_path: join(cwd, "a.ts") } }] }) + "\n",
    );
    const stats = await runIndexPass(db, { projectsDir: dir, collectActivity: true });

    expect(stats.activities).toHaveLength(1);
    expect(stats.activities[0]).toMatchObject({
      agentId: sessionId,
      stage: "tool",
      toolName: "Edit",
      targetObjectId: `file:${join(cwd, "a.ts")}`,
      summary: "Edit a.ts",
    });
    expect(typeof stats.activities[0]?.id).toBe("string");

    db.close();
  });
});
