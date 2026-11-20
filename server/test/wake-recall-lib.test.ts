// wake-recall-lib on the real line shapes Claude Code 2.1.283 writes (keys, nesting and the
// "- `path` — snippet" content copied from real transcripts on 2026-09-28; the snippets are
// replaced with neutral text so no private note content lands in the repo).

import { describe, expect, it } from "vitest";
import { promptRecallLine, wakeLine, type WakeRecallEntry } from "../../shared/features/wake-recall.js";
import {
  foldIndexLines,
  hookBasename,
  newWakeRecord,
  parseHookLine,
  parseRecallNotes,
  recordFromHead,
  toEntry,
  vaultRelative,
  wakeState,
  wakeSummary,
  wakeTotals,
  type VaultRoots,
} from "../features/wake-recall-lib.js";

const HOME = "/Users/alexboghossian";
const ROOTS: VaultRoots = {
  home: HOME,
  vaultRoot: `${HOME}/Documents/Code/alex_claude`,
  aliases: [{ from: `${HOME}/.claude/projects/-Users-alexboghossian/memory`, to: "60-Meta/claude-config/memory" }],
};
const SID = "d9a3621c-1af1-48cd-b65b-d722066bf908";
const SECRET_SNIPPET = "PRIVATE-NOTE-BODY do not store";

const WAKE_CONTENT = [
  "## Memory recall (auto-pulled at session start)",
  "",
  "_From your second-brain vault. Query: 'main Merge pull request #37 from sboghossian/feat/institute-truth # agent-world '_",
  "",
  `- \`~/Documents/Code/alex_claude/20-Projects/claw3d/roadmap-sync.md\` — # Claw3D **Category:** ai-visualization ${SECRET_SNIPPET}…`,
  "- `~/Documents/Code/alex_claude/20-Projects/agent-world/_index.md` — # project-agent-world _Stub auto-created from [working memory](x.md) by audit_memory_bridge.py --fix._ `~/Documents/Code/agent…",
  "- `~/.claude/projects/-Users-alexboghossian/memory/project_side_prototype.md` — **Side** is a clickable prototype `~/Documents/Code/alex_claude/not-a-listed-note.md` …",
  "",
  "_(Set `MEMORY_RECALL_DISABLED=1` to silence this hook.)_",
].join("\n");

function attachmentLine(attachment: Record<string, unknown>, over: Record<string, unknown> = {}): string {
  const content = typeof attachment.content === "string" ? attachment.content : "";
  return JSON.stringify({
    parentUuid: "44560d74-88a3-4116-9cca-9da4faf54ca0",
    isSidechain: false,
    attachment,
    type: "attachment",
    uuid: "1be8aa4b-f51b-4279-beea-2215da82386a",
    timestamp: "2026-09-28T03:38:10.253Z",
    rendered: [{ content: `<system-reminder>\n${String(attachment.hookName)} hook success: ${content}\n</system-reminder>` }],
    userType: "external",
    entrypoint: "claude-vscode",
    cwd: "/Users/alexboghossian/Documents/Code/agent-world",
    sessionId: SID,
    version: "2.1.283",
    gitBranch: "main",
    slug: "fix-tests-pass-starry-sundae",
    ...over,
  });
}

/** The spec's line: {type:'attachment', attachment:{type:'hook_success', hookEvent:'SessionStart', …, command:'…/memory-recall.py', content, stdout, exitCode, durationMs}}. */
function wakeLineRaw(hookName = "SessionStart:startup", over: Record<string, unknown> = {}): string {
  return attachmentLine(
    {
      type: "hook_success",
      hookName,
      toolUseID: "a003db3e-eaf1-4ab3-835f-8a8000187ba5",
      hookEvent: "SessionStart",
      content: WAKE_CONTENT,
      stdout: `${WAKE_CONTENT}\n`,
      stderr: "",
      exitCode: 0,
      command: "/Users/alexboghossian/.claude/hooks/memory-recall.py",
      durationMs: 691,
    },
    over,
  );
}

/** A headless run's SessionStart hook with empty content (the skills-sync hook, real shape). */
const EMPTY_HOOK = attachmentLine(
  {
    type: "hook_success",
    hookName: "SessionStart:startup",
    toolUseID: "133715b2-7fc4-42b3-838e-6be750ebeac4",
    hookEvent: "SessionStart",
    content: "",
    stdout: "",
    stderr: "skills-sync: 'hyperframes' differs from repo — left in place; resolve by hand.\n",
    exitCode: 0,
    command: 'bash "$HOME/.claude/skills-repo/bin/pull-and-link.sh"',
    durationMs: 2641,
  },
  { entrypoint: "sdk-cli" },
);

const PROMPT_RECALL_CONTENT = [
  "## Memory Recall",
  "",
  "Top 3 chunks semantically matched to this prompt (vector similarity over memory + vault).",
  "",
  `- **[vault]** \`vibemind/landing-page-audit-2026-09-24.md\` — 2026-09-24 — ${SECRET_SNIPPET}…`,
  "- **[memory]** `memory/project_side_prototype.md` — 2026-09-12 — **Side** …",
].join("\n");

const PROMPT_RECALL = attachmentLine(
  {
    type: "hook_success",
    hookName: "UserPromptSubmit",
    toolUseID: "d2fbf6a0-2472-4c83-8f27-35f6f8b32e6d",
    hookEvent: "UserPromptSubmit",
    content: PROMPT_RECALL_CONTENT,
    stdout: `${PROMPT_RECALL_CONTENT}\n`,
    stderr: "",
    exitCode: 0,
    command: "$HOME/.claude/hooks/prompt-memory-recall.py",
    durationMs: 1116,
  },
  { timestamp: "2026-09-28T03:38:13.291Z" },
);

const ROUTER_HINT = attachmentLine({
  type: "hook_success",
  hookName: "UserPromptSubmit",
  hookEvent: "UserPromptSubmit",
  content: "## Skill Router (Jev)\n\nJev suggests **/health** (fits 46%)",
  command: "$HOME/.claude/skill-router/route.mjs",
  exitCode: 0,
});

const CANCELLED = attachmentLine(
  {
    type: "hook_cancelled",
    hookName: "SessionStart:startup",
    toolUseID: "7d915123-c14a-4901-8334-cd2ca503f532",
    hookEvent: "SessionStart",
    command: "/Users/alexboghossian/.claude/hooks/memory-recall.py",
    durationMs: 10589,
    timedOut: true,
    timeoutMs: 6000,
  },
  { entrypoint: "sdk-cli" },
);

const FAILED = attachmentLine({
  type: "hook_non_blocking_error",
  hookName: "SessionStart:startup",
  toolUseID: "d2d3a3bb-b67a-4791-b4ca-3a3a4ed1dd29",
  hookEvent: "SessionStart",
  stderr: "Failed with non-blocking status code: You have not agreed to the Xcode license agreements.",
  stdout: "",
  exitCode: 69,
  command: "/Users/alexboghossian/.claude/hooks/memory-recall.py",
  durationMs: 2995,
});

function userTurn(ts: string, entrypoint = "claude-vscode"): string {
  return JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: "fix the tests" }, timestamp: ts, entrypoint, sessionId: SID });
}

const QUEUE_OP = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-28T03:38:08.000Z", sessionId: SID, content: "hello" });

describe("hookBasename", () => {
  it("names the script, not the interpreter or its quoting", () => {
    expect(hookBasename("/Users/alexboghossian/.claude/hooks/memory-recall.py")).toBe("memory-recall.py");
    expect(hookBasename("$HOME/.claude/hooks/prompt-memory-recall.py")).toBe("prompt-memory-recall.py");
    expect(hookBasename('bash "$HOME/.claude/skills-repo/bin/pull-and-link.sh"')).toBe("pull-and-link.sh");
    expect(hookBasename('$HOME/.claude/hooks/with-lock.sh skillsrepo bash "$HOME/x/commit-and-push.sh"')).toBe("with-lock.sh");
    expect(hookBasename("rtk hook claude")).toBe("rtk");
    expect(hookBasename("env FOO=1 python3 /x/memory-recall.py --quiet")).toBe("memory-recall.py");
    expect(hookBasename("")).toBe("");
  });
});

describe("vaultRelative", () => {
  it("resolves ~/ and absolute vault paths, and the memory symlink, to vault-relative .md paths", () => {
    expect(vaultRelative("~/Documents/Code/alex_claude/20-Projects/claw3d/roadmap-sync.md", ROOTS)).toBe("20-Projects/claw3d/roadmap-sync.md");
    expect(vaultRelative(`${HOME}/Documents/Code/alex_claude/Home.md`, ROOTS)).toBe("Home.md");
    expect(vaultRelative("~/.claude/projects/-Users-alexboghossian/memory/project_side_prototype.md", ROOTS)).toBe("60-Meta/claude-config/memory/project_side_prototype.md");
  });

  it("drops anything outside the vault, relative, non-.md, traversing or control-char paths", () => {
    expect(vaultRelative("~/Documents/Code/agent-world/README.md", ROOTS)).toBeNull();
    expect(vaultRelative("~/Documents/Code/alex_claude/../agent-world/README.md", ROOTS)).toBeNull();
    expect(vaultRelative("~/.claude/projects/-Users-alexboghossian/memory/../../../.ssh/x.md", ROOTS)).toBeNull();
    expect(vaultRelative("vibemind/landing-page-audit-2026-09-24.md", ROOTS)).toBeNull();
    expect(vaultRelative("~/Documents/Code/alex_claude/60-Meta/brain-graph.json", ROOTS)).toBeNull();
    expect(vaultRelative("~/Documents/Code/alex_claude/a\u0007b.md", ROOTS)).toBeNull();
  });
});

describe("parseHookLine: the real attachment shapes", () => {
  it("the SessionStart memory-recall line → event, hook, vault-relative notes, count (listed notes only)", () => {
    const h = parseHookLine(wakeLineRaw(), ROOTS);
    expect(h).toMatchObject({ kind: "success", event: "SessionStart", hookName: "SessionStart:startup", hook: "memory-recall.py", at: "2026-09-28T03:38:10.253Z", count: 3 });
    // The backticked path inside a snippet ("not-a-listed-note.md") is not a listed note.
    expect(h?.notes).toEqual(["20-Projects/claw3d/roadmap-sync.md", "20-Projects/agent-world/_index.md", "60-Meta/claude-config/memory/project_side_prototype.md"]);
    expect(JSON.stringify(h)).not.toContain(SECRET_SNIPPET);
  });

  it("a headless run's hook with empty content → no notes", () => {
    const h = parseHookLine(EMPTY_HOOK, ROOTS);
    expect(h).toMatchObject({ kind: "success", event: "SessionStart", hook: "pull-and-link.sh", notes: [], count: 0, hasContent: false });
  });

  it("cancelled at its timeout, and a non-blocking error, keep their kind", () => {
    expect(parseHookLine(CANCELLED, ROOTS)).toMatchObject({ kind: "cancelled", hook: "memory-recall.py", timedOut: true, notes: [] });
    expect(parseHookLine(FAILED, ROOTS)).toMatchObject({ kind: "error", hook: "memory-recall.py", exitCode: 69 });
  });

  it("anything that isn't a hook attachment → null", () => {
    expect(parseHookLine(userTurn("2026-09-28T03:38:12.170Z"), ROOTS)).toBeNull();
    expect(parseHookLine(JSON.stringify({ type: "attachment", attachment: { type: "environment" } }), ROOTS)).toBeNull();
    expect(parseHookLine('{"type":"attachment","attachment":{"type":"hook_success"', ROOTS)).toBeNull();
  });

  it("parseRecallNotes dedupes and keeps order", () => {
    expect(parseRecallNotes(`${WAKE_CONTENT}\n${WAKE_CONTENT}`, ROOTS)).toHaveLength(3);
  });
});

describe("a session's wake record", () => {
  const head = (lines: string[]): Buffer => Buffer.from(lines.join("\n") + "\n");

  it("fed: notes from SessionStart, prompt recalls counted, the router hint is not a recall", () => {
    const lines = [QUEUE_OP, wakeLineRaw(), userTurn("2026-09-28T03:38:12.170Z"), PROMPT_RECALL, ROUTER_HINT];
    const rec = recordFromHead(SID, head(lines), 5000, ROOTS);
    const e = toEntry(rec);
    expect(e).toMatchObject({
      sessionId: SID,
      state: "fed",
      reason: null,
      headless: false,
      startedAt: "2026-09-28T03:38:08.000Z",
      wokeAt: "2026-09-28T03:38:10.253Z",
      wakeEvent: "SessionStart:startup",
      hook: "memory-recall.py",
      count: 3,
      promptRecalls: 1,
      newSinceBoot: false,
    });
    // Prompt-time notes never join the wake's notes, and no content is kept anywhere.
    expect(e.notes).not.toContain("vibemind/landing-page-audit-2026-09-24.md");
    expect(JSON.stringify(rec)).not.toContain(SECRET_SNIPPET);
    expect(wakeLine(e)).toBe("Woke with 3 notes from the Institute of Truth");
    // Counted in the head only (a long session can hold 100+ past it): the line names that scope.
    expect(promptRecallLine(e)).toBe("1 recall at prompt time (first 256 KB of the transcript)");
  });

  it("a resume hook counts as the wake, and says so", () => {
    const rec = recordFromHead(SID, head([wakeLineRaw("SessionStart:resume"), userTurn("2026-09-28T03:40:00.000Z")]), 3000, ROOTS);
    const e = toEntry(rec);
    expect(e).toMatchObject({ state: "fed", wakeEvent: "SessionStart:resume", count: 3 });
    expect(wakeLine(e)).toBe("Woke with 3 notes from the Institute of Truth (on resume)");
  });

  it("a headless run with empty content and no recall line → nothing, no trace, headless", () => {
    const rec = recordFromHead(SID, head([EMPTY_HOOK, userTurn("2026-09-28T05:10:21.984Z", "sdk-cli")]), 3000, ROOTS);
    expect(wakeState(rec)).toEqual({ state: "nothing", reason: "no-trace" });
    const e = toEntry(rec);
    expect(e.headless).toBe(true);
    expect(wakeLine(e)).toBe("Woke with nothing (headless run): the recall hook left no trace");
    expect(promptRecallLine(e)).toBeNull();
  });

  it("the recall hook timed out / failed → nothing, with that reason", () => {
    expect(wakeState(recordFromHead(SID, head([CANCELLED, userTurn("2026-09-28T05:10:21.984Z", "sdk-cli")]), 3000, ROOTS))).toEqual({ state: "nothing", reason: "timed-out" });
    expect(wakeState(recordFromHead(SID, head([FAILED, userTurn("2026-09-28T05:10:21.984Z")]), 3000, ROOTS))).toEqual({ state: "nothing", reason: "failed" });
  });

  it("no prompt yet → pending; a head that is one oversized line → unread", () => {
    expect(wakeState(recordFromHead(SID, head([QUEUE_OP]), 200, ROOTS)).state).toBe("pending");
    const giant = Buffer.from(`{"type":"queue-operation","content":"${"x".repeat(300)}`); // no newline inside the head
    const rec = recordFromHead(SID, giant, 352_194, ROOTS, 256);
    expect(rec.bytes).toBe(0);
    expect(wakeState(rec).state).toBe("unread");
  });

  it("index lines fold only while they end inside the head, like the cold read", () => {
    const lines = [QUEUE_OP, wakeLineRaw(), userTurn("2026-09-28T03:38:12.170Z"), PROMPT_RECALL];
    const full = Buffer.byteLength(lines.slice(0, 3).join("\n") + "\n");
    const rec = newWakeRecord(SID, true);
    foldIndexLines(rec, lines, ROOTS, full); // PROMPT_RECALL would end past the head
    expect(rec.headFull).toBe(true);
    expect(toEntry(rec)).toMatchObject({ state: "fed", promptRecalls: 0, newSinceBoot: true });
    expect(toEntry(rec)).toEqual({ ...toEntry(recordFromHead(SID, Buffer.from(lines.join("\n") + "\n").subarray(0, full), 10_000, ROOTS, full)), newSinceBoot: true });

    const giant = newWakeRecord(SID, true);
    foldIndexLines(giant, ["x".repeat(400), wakeLineRaw()], ROOTS, 256);
    expect(wakeState(giant).state).toBe("unread");
  });

  it("the broadcast summary", () => {
    expect(wakeSummary(8)).toBe("woke with 8 vault notes");
    expect(wakeSummary(1)).toBe("woke with 1 vault note");
  });
});

describe("wakeTotals", () => {
  const base: WakeRecallEntry = {
    sessionId: "s",
    state: "fed",
    reason: null,
    headless: false,
    startedAt: "2026-09-28T08:00:00.000Z",
    wokeAt: "2026-09-28T08:00:00.000Z",
    wakeEvent: "SessionStart:startup",
    hook: "memory-recall.py",
    notes: ["a.md", "b.md"],
    count: 2,
    promptRecalls: 2,
    newSinceBoot: false,
  };
  it("counts states, headless misses, reasons, notes, prompt recalls and today", () => {
    const since = Date.parse("2026-09-28T00:00:00.000Z");
    const t = wakeTotals(
      [
        base,
        { ...base, sessionId: "b", state: "nothing", reason: "timed-out", headless: true, notes: [], count: 0, promptRecalls: 0 },
        { ...base, sessionId: "c", state: "nothing", reason: "no-trace", headless: false, notes: [], count: 0, promptRecalls: 1, startedAt: "2026-09-20T00:00:00.000Z" },
        { ...base, sessionId: "d", state: "unread", notes: [], count: 0, promptRecalls: 0, startedAt: null },
      ],
      since,
    );
    expect(t).toEqual({
      sessions: 4,
      fed: 1,
      nothing: 2,
      unread: 1,
      pending: 0,
      headlessMisses: 1,
      reasons: { "timed-out": 1, failed: 0, "no-trace": 1 },
      notes: 2,
      promptRecalls: 3,
      promptRecallSessions: 2,
      today: { sessions: 2, fed: 1, nothing: 1 },
    });
  });
});
