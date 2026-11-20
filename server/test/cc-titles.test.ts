// Claude Code's own session titles: parsing the real custom-title / ai-title records, the
// incremental indexer picking up a rename made after first indexing (from the stored byte offset),
// and the one-time backfill (backup first, crash-then-rerun converges, flag last, never re-folds).

import Database from "better-sqlite3";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCcTitlesBackfill, scanCcTitles } from "../cc-titles-backfill.js";
import { ccDisplayName, foldCcTitles, type CcTitles } from "../cc-titles-lib.js";
import type { ApprovalView } from "../../shared/features/approvals.js";
import type { WorldDb } from "../db.js";
import { resolveAgentRef, summarizeWorld, validateAction } from "../features/voice-brain-lib.js";
import { buildWorldViews } from "../index.js";
import { runIndexPass } from "../indexer.js";
import { parseLine } from "../jsonl-events.js";
import { appendToSessionFile, makeTempDb, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

const SID = "145212ad-0026-4016-820a-2601d2d05626";

// Verbatim shapes from ~/.claude/projects transcripts (both key orders occur in the same file;
// only the rename text is changed). Claude Code re-appends these records over a session's life.
const AI_TITLE = `{"type":"ai-title","sessionId":"${SID}","aiTitle":"TICK-1635 LinkedIn ABM"}`;
const AI_TITLE_REORDERED = `{"type":"ai-title","aiTitle":"TICK-1635 LinkedIn ABM","sessionId":"${SID}"}`;
const RENAME_1 = `{"type":"custom-title","sessionId":"${SID}","customTitle":"1635 - ABM LinkedIn <> Partner"}`;
const RENAME_2 = `{"type":"custom-title","sessionId":"${SID}","customTitle":"ABM LinkedIn Ads"}`;
const RENAME_3 = `{"type":"custom-title","customTitle":"LinkedIn","sessionId":"${SID}"}`;

// A real interactive user / assistant line's key set (content invented).
function realUserLine(cwd: string, timestamp: string, text: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    promptId: "5f0e6c1e-1d7a-4c1e-9c55-4c3f8f3b2a10",
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    uuid: "0b8c7c2e-2f6a-4a51-8f0e-3d0c1b2a4e11",
    timestamp,
    permissionMode: "default",
    origin: { kind: "human" },
    promptSource: "prompt",
    userType: "external",
    entrypoint: "claude-vscode",
    cwd,
    sessionId: SID,
    version: "2.1.281",
    gitBranch: "main",
  });
}
function realAssistantLine(cwd: string, timestamp: string, id: string): string {
  return JSON.stringify({
    parentUuid: "0b8c7c2e-2f6a-4a51-8f0e-3d0c1b2a4e11",
    isSidechain: false,
    message: {
      model: "claude-opus-5-5",
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "On it." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, cache_creation_input_tokens: 50422, cache_read_input_tokens: 25144, output_tokens: 78 },
    },
    type: "assistant",
    uuid: "9d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6",
    timestamp,
    userType: "external",
    entrypoint: "claude-vscode",
    cwd,
    sessionId: SID,
    version: "2.1.281",
    gitBranch: "main",
  });
}
// The last-prompt record that sits beside title records in real transcripts: not a title.
const LAST_PROMPT = `{"type":"last-prompt","lastPrompt":"make an ai-title for this","leafUuid":"0b8c7c2e-2f6a-4a51-8f0e-3d0c1b2a4e11","sessionId":"${SID}"}`;

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

async function seed(): Promise<{ dir: string; db: WorldDb; cwd: string; file: string }> {
  const dir = await makeTempProjectsDir();
  const db = await makeTempDb(dir);
  const cwd = join(dir, "ws", "growth");
  const file = await writeSessionFile(
    dir,
    "-ws-growth",
    SID,
    lines(realUserLine(cwd, "2026-09-20T10:00:00.000Z", "work on this https://linear.app/acmeai/issue/TICK-1635/abm"), realAssistantLine(cwd, "2026-09-20T10:00:05.000Z", "msg_01")),
  );
  return { dir, db, cwd, file };
}

/** Every session column except the two title columns, plus edges and day tokens. */
function foldedState(dbPath: string): string {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const sessions = raw.prepare(`SELECT * FROM sessions ORDER BY id`).all() as Array<Record<string, unknown>>;
    for (const s of sessions) {
      delete s.custom_title;
      delete s.ai_title;
    }
    return JSON.stringify({
      sessions,
      edges: raw.prepare(`SELECT * FROM edges ORDER BY from_id, to_id, kind`).all(),
      offsets: raw.prepare(`SELECT * FROM file_offsets ORDER BY path`).all(),
      days: raw.prepare(`SELECT * FROM day_tokens ORDER BY date`).all(),
    });
  } finally {
    raw.close();
  }
}

/** What a db indexed before this feature looks like: title columns NULL, offsets at the end. */
function forgetTitles(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.prepare(`UPDATE sessions SET custom_title = NULL, ai_title = NULL`).run();
  raw.close();
}

describe("parseLine: Claude Code title records", () => {
  it("reads customTitle / aiTitle in either key order, and nothing else from them", () => {
    expect(parseLine(RENAME_1)).toMatchObject({ customTitle: "1635 - ABM LinkedIn <> Partner", aiTitle: null, isUserLine: false, isAssistant: false });
    expect(parseLine(RENAME_3)?.customTitle).toBe("LinkedIn");
    expect(parseLine(AI_TITLE)).toMatchObject({ aiTitle: "TICK-1635 LinkedIn ABM", customTitle: null });
    expect(parseLine(AI_TITLE_REORDERED)?.aiTitle).toBe("TICK-1635 LinkedIn ABM");
    expect(parseLine(LAST_PROMPT)).toMatchObject({ customTitle: null, aiTitle: null });
    expect(parseLine(`{"type":"custom-title","customTitle":42}`)?.customTitle).toBeNull();
  });

  it("a user message that merely mentions ai-title is not a title record", () => {
    const p = parseLine(realUserLine("/w", "2026-09-20T10:00:00.000Z", '{"type":"ai-title","aiTitle":"spoof"}'));
    expect(p?.aiTitle).toBeNull();
    expect(p?.isUserText).toBe(true);
  });
});

describe("ccDisplayName", () => {
  const t = (customTitle: string | null, aiTitle: string | null): CcTitles => ({ customTitle, aiTitle });
  const PROMPT = "work on this https://linear.app/acmeai/issue/TICK-1916/map-customer-journey";
  // A real /upskill step session (sanitized first prompt) that Claude Code gave an AI title.
  const UPSKILL = "You are the autonomous authoring step of Alex's `/upskill` loop. A determin…";
  it("an automation prompt keeps its readable name over the AI title; a /rename still wins", () => {
    expect(ccDisplayName(t(null, "Alex's upskill loop"), UPSKILL)).toBeNull(); // client shows "/upskill · autonomous authoring"
    expect(ccDisplayName(t("upskill: pdf skill", "Alex's upskill loop"), UPSKILL)).toBe("upskill: pdf skill");
  });
  it("the user's rename wins over the AI title, whatever order they arrived in", () => {
    const acc = t(null, null);
    for (const l of [AI_TITLE, RENAME_1, RENAME_2, RENAME_3, AI_TITLE_REORDERED]) foldCcTitles(acc, parseLine(l)!);
    expect(acc).toEqual({ customTitle: "LinkedIn", aiTitle: "TICK-1635 LinkedIn ABM" });
    expect(ccDisplayName(acc, PROMPT)).toBe("LinkedIn");
  });
  it("falls back to the AI title, then to null (caller shows the first prompt)", () => {
    expect(ccDisplayName(t(null, "Justinian research and cross-linking improvements"), PROMPT)).toBe("Justinian research and cross-linking improvements");
    expect(ccDisplayName(t("   ", "Frequent permission modal prompts"), PROMPT)).toBe("Frequent permission modal prompts");
    expect(ccDisplayName(t(null, null), PROMPT)).toBeNull();
    expect(ccDisplayName(t("", "  "), PROMPT)).toBeNull();
  });
  it("sanitizes untrusted text: tags stripped, secrets redacted, 80 chars, '<>' kept", () => {
    expect(ccDisplayName(t("1635 - ABM LinkedIn <> Partner", null), PROMPT)).toBe("1635 - ABM LinkedIn <> Partner");
    expect(ccDisplayName(t('<img src=x onerror="alert(1)">Vibemind', null), PROMPT)).toBe("Vibemind");
    expect(ccDisplayName(t("key sk-ant-abcdefghijklmnopqrstu here", null), PROMPT)).toBe("key [redacted] here");
    expect(ccDisplayName(t(null, "x".repeat(200)), PROMPT)?.length).toBeLessThanOrEqual(80);
  });
});

describe("indexer: Claude Code titles", () => {
  it("a rename made after the session was first indexed lands on the next pass, reading only new bytes", async () => {
    const { dir, db, file } = await seed();
    await runIndexPass(db, { projectsDir: dir });
    const first = db.getSession(SID)!;
    expect(first).toMatchObject({ customTitle: null, aiTitle: null, messageCount: 2 });
    const firstTitle = first.title;

    await appendToSessionFile(file, lines(AI_TITLE, LAST_PROMPT));
    let stats = await runIndexPass(db, { projectsDir: dir });
    expect(stats.linesProcessed).toBe(2); // resumed from the stored offset, not byte 0
    expect(db.getSession(SID)).toMatchObject({ aiTitle: "TICK-1635 LinkedIn ABM", customTitle: null, messageCount: 2, title: firstTitle });

    await appendToSessionFile(file, lines(RENAME_1, RENAME_2, RENAME_3, AI_TITLE_REORDERED));
    stats = await runIndexPass(db, { projectsDir: dir });
    expect(stats.linesProcessed).toBe(4);
    const s = db.getSession(SID)!;
    expect(s).toMatchObject({ customTitle: "LinkedIn", aiTitle: "TICK-1635 LinkedIn ABM", messageCount: 2, title: firstTitle, tokens: first.tokens });

    // A pass with no title record leaves both alone.
    await appendToSessionFile(file, lines(realUserLine(join(dir, "ws", "growth"), "2026-09-20T11:00:00.000Z", "and the ads?")));
    await runIndexPass(db, { projectsDir: dir });
    expect(db.getSession(SID)).toMatchObject({ customTitle: "LinkedIn", aiTitle: "TICK-1635 LinkedIn ABM", messageCount: 3 });

    const agent = buildWorldViews(db, new Map(), new Date("2026-09-20T12:00:00.000Z")).agents.find((a) => a.id === SID)!;
    expect(agent.displayName).toBe("LinkedIn");
    expect(agent.title).toBe("work on this https://linear.app/acmeai/issue/TICK-1635/abm"); // classification input untouched
    db.close();
  });

  it("a session with no Claude Code title gets displayName null", async () => {
    const { dir, db } = await seed();
    await runIndexPass(db, { projectsDir: dir });
    expect(buildWorldViews(db, new Map(), new Date()).agents[0]?.displayName).toBeNull();
    db.close();
  });
});

describe("voice brain (Alef): Claude Code titles", () => {
  it("the brain sees and speaks the /rename, finds the session by it, and still by its first prompt", async () => {
    const { dir, db, file } = await seed();
    await appendToSessionFile(file, lines(AI_TITLE, RENAME_3));
    await runIndexPass(db, { projectsDir: dir });
    const views = buildWorldViews(db, new Map(), new Date()); // just written, so live
    const approvals: ApprovalView[] = [
      { id: "ap1", agentId: SID, cwd: "/b", toolName: "Bash", preview: { title: "", body: "" } as ApprovalView["preview"], createdAt: "", expiresAt: "" },
    ];
    const summary = summarizeWorld({ agents: views.agents, islands: views.islands, approvals, now: new Date() });
    expect(summary).toContain('[145212ad] "LinkedIn" (prompt: "work on this');
    expect(summary).toContain('Oldest: Bash for "LinkedIn"');

    expect(resolveAgentRef("LinkedIn", views.agents)?.id).toBe(SID);
    expect(resolveAgentRef("TICK-1635", views.agents)?.id).toBe(SID); // the first prompt stays an alias
    expect(validateAction({ type: "open_room", agent: "LinkedIn" }, views)).toEqual({ ok: true, action: { type: "open_room", agentId: SID, title: "LinkedIn" } });
    expect(validateAction({ type: "fly_to_agent", agent: "tick 1635" }, views)).toMatchObject({ ok: true, action: { agentId: SID, title: "LinkedIn" } });
    db.close();
  });
});

describe("runCcTitlesBackfill", () => {
  async function indexedBeforeFeature(): Promise<{ dir: string; db: WorldDb; file: string; dbPath: string }> {
    const { dir, db, file } = await seed();
    await appendToSessionFile(file, lines(AI_TITLE, RENAME_1, RENAME_3, AI_TITLE_REORDERED));
    await runIndexPass(db, { projectsDir: dir });
    const dbPath = join(dir, "world.db");
    forgetTitles(dbPath);
    expect(db.getSession(SID)).toMatchObject({ customTitle: null, aiTitle: null });
    return { dir, db, file, dbPath };
  }

  it("fills titles from bytes already indexed, re-folds nothing, backs up once, sets the flag", async () => {
    const { dir, db, dbPath } = await indexedBeforeFeature();
    const before = foldedState(dbPath);
    await runCcTitlesBackfill(db);
    expect(db.getSession(SID)).toMatchObject({ customTitle: "LinkedIn", aiTitle: "TICK-1635 LinkedIn ABM" });
    expect(foldedState(dbPath)).toBe(before); // tokens, counts, edges, offsets untouched
    expect(db.getMeta("cc_titles_backfilled")).toBe("1");
    const backups = (await readdir(dir)).filter((f) => /^world\.db\.pre-cc-titles-.+\.bak$/.test(f));
    expect(backups).toHaveLength(1);
    // Done means done: a later NULL is not refilled by a second call.
    forgetTitles(dbPath);
    await runCcTitlesBackfill(db);
    expect(db.getSession(SID)?.customTitle).toBeNull();
    db.close();
  });

  it("converges after a crash before the transaction, or inside it, with one backup", async () => {
    const { dir, db } = await indexedBeforeFeature();
    await expect(runCcTitlesBackfill(db, { beforeCommit: () => { throw new Error("simulated crash"); } })).rejects.toThrow("simulated crash");
    expect(db.getMeta("cc_titles_backfilled")).toBeNull();
    expect(db.getSession(SID)).toMatchObject({ customTitle: null, aiTitle: null });

    const realFill = db.fillCcTitles.bind(db);
    db.fillCcTitles = (id, c, a) => {
      realFill(id, c, a);
      throw new Error("simulated crash mid-transaction");
    };
    await expect(runCcTitlesBackfill(db)).rejects.toThrow("mid-transaction");
    db.fillCcTitles = realFill;
    expect(db.getMeta("cc_titles_backfilled")).toBeNull();
    expect(db.getSession(SID)).toMatchObject({ customTitle: null, aiTitle: null }); // rolled back

    await runCcTitlesBackfill(db);
    expect(db.getSession(SID)).toMatchObject({ customTitle: "LinkedIn", aiTitle: "TICK-1635 LinkedIn ABM" });
    expect(db.getMeta("cc_titles_backfilled")).toBe("1");
    expect((await readdir(dir)).filter((f) => f.includes(".pre-cc-titles-"))).toHaveLength(1);
    db.close();
  });

  it("never overwrites a newer title the indexer read while the backfill was scanning", async () => {
    const { db } = await indexedBeforeFeature();
    const newer = `{"type":"custom-title","customTitle":"LinkedIn (final)","sessionId":"${SID}"}`;
    await runCcTitlesBackfill(db, {
      beforeCommit: () => {
        // Simulate a pass landing mid-backfill: it read a rename past the offset the scan used.
        db.upsertSession({ ...upsertBase(db), customTitle: parseLine(newer)!.customTitle! });
      },
    });
    expect(db.getSession(SID)).toMatchObject({ customTitle: "LinkedIn (final)", aiTitle: "TICK-1635 LinkedIn ABM" });
    db.close();
  });

  it("skips a transcript that is gone, and a failed backup means no migration this boot", async () => {
    const { db, file } = await indexedBeforeFeature();
    const realBackup = db.backupTo.bind(db);
    db.backupTo = async () => {
      throw new Error("read-only dir");
    };
    await runCcTitlesBackfill(db);
    expect(db.getMeta("cc_titles_backfilled")).toBeNull();
    db.backupTo = realBackup;

    await rm(file);
    await runCcTitlesBackfill(db);
    expect(db.getMeta("cc_titles_backfilled")).toBe("1");
    expect(db.getSession(SID)).toMatchObject({ customTitle: null, aiTitle: null }); // keeps its first-prompt title
    db.close();
  });

  it("scanCcTitles stops at the offset: a record past it is left to the incremental indexer", async () => {
    const { file } = await seed();
    await appendToSessionFile(file, lines(AI_TITLE));
    const { size } = await stat(file);
    await appendToSessionFile(file, lines(RENAME_3));
    expect(await scanCcTitles(file, size)).toEqual({ customTitle: null, aiTitle: "TICK-1635 LinkedIn ABM" });
    expect(await scanCcTitles(file, 0)).toEqual({ customTitle: null, aiTitle: null });
  });
});

/** A zero-delta upsert for SID, as an incremental pass with no counted lines would write it. */
function upsertBase(db: WorldDb): Parameters<WorldDb["upsertSession"]>[0] {
  const s = db.getSession(SID)!;
  return {
    id: s.id,
    cwd: s.cwd,
    islandId: s.islandId,
    startedAt: s.startedAt,
    lastActive: s.lastActive,
    jsonlMtime: s.jsonlMtime,
    messageCountDelta: 0,
    model: s.model,
    cntEditDelta: 0,
    cntResearchDelta: 0,
    cntBashDelta: 0,
    cntTextOnlyDelta: 0,
    cntAssistantTotalDelta: 0,
  };
}
