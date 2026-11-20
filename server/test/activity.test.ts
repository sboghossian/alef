import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bashSummary, deriveActivity, isMemoryOrVaultPath, redactCommand } from "../activity.js";
import { parseLine } from "../jsonl-events.js";
import { assistantLine, userLine } from "./helpers.js";

const CWD = "/Users/alex/Documents/Code/agent-world";
const AT = "2026-09-24T10:00:00.000Z";

function parse(raw: string) {
  const parsed = parseLine(raw);
  if (parsed === null) throw new Error("fixture line failed to parse");
  return parsed;
}

describe("deriveActivity stage mapping", () => {
  it("a new user prompt is stage 'hook'", () => {
    const line = parse(userLine({ cwd: CWD, timestamp: AT, text: "fix the bug in main.ts" }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toEqual([{ at: AT, stage: "hook", toolName: null, targetObjectId: null, summary: "fix the bug in main.ts" }]);
  });

  it("a text-only assistant turn is stage 'reason'", () => {
    const line = parse(assistantLine({ cwd: CWD, timestamp: AT, text: "Looks like a null check is missing." }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toEqual([{ at: AT, stage: "reason", toolName: null, targetObjectId: null, summary: "Looks like a null check is missing." }]);
  });

  it("a thinking-only assistant turn (no text) summarizes as 'thinking…'", () => {
    const line = parse(JSON.stringify({
      type: "assistant",
      timestamp: AT,
      cwd: CWD,
      message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "hmm" }] },
    }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toEqual([{ at: AT, stage: "reason", toolName: null, targetObjectId: null, summary: "thinking…" }]);
  });

  it("Edit on a normal file is stage 'tool' targeting file:<abs path>", () => {
    const line = parse(assistantLine({ cwd: CWD, timestamp: AT, toolUses: [{ name: "Edit", input: { file_path: join(CWD, "client/src/main.ts") } }] }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toEqual([
      { at: AT, stage: "tool", toolName: "Edit", targetObjectId: `file:${join(CWD, "client/src/main.ts")}`, summary: "Edit client/src/main.ts" },
    ]);
  });

  it("Read under ~/.claude/projects/<id>/memory is stage 'brain'", () => {
    const memPath = join(homedir(), ".claude", "projects", "-Users-x-code", "memory", "notes.md");
    const line = parse(assistantLine({ cwd: CWD, timestamp: AT, toolUses: [{ name: "Read", input: { file_path: memPath } }] }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.stage).toBe("brain");
    expect(drafts[0]?.targetObjectId).toBe(`file:${memPath}`);
  });

  it("Grep under ~/Documents/Code/alex_claude is stage 'brain'", () => {
    const vaultPath = join(homedir(), "Documents", "Code", "alex_claude", "60-Meta", "notes.md");
    const line = parse(assistantLine({ cwd: CWD, timestamp: AT, toolUses: [{ name: "Grep", input: { path: vaultPath } }] }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts[0]?.stage).toBe("brain");
  });

  it("Skill is stage 'plan' targeting skill:<name>", () => {
    const line = parse(assistantLine({ cwd: CWD, timestamp: AT, toolUses: [{ name: "Skill", input: { skill: "humanizer" } }] }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toEqual([{ at: AT, stage: "plan", toolName: "Skill", targetObjectId: "skill:humanizer", summary: "Skill humanizer" }]);
  });

  it("TodoWrite/EnterPlanMode/ExitPlanMode are stage 'plan' with no target", () => {
    for (const name of ["TodoWrite", "EnterPlanMode", "ExitPlanMode"]) {
      const line = parse(assistantLine({ cwd: CWD, timestamp: AT, toolUses: [{ name, input: {} }] }));
      const drafts = deriveActivity(line, CWD, AT);
      expect(drafts).toEqual([{ at: AT, stage: "plan", toolName: name, targetObjectId: null, summary: name }]);
    }
  });

  it("an mcp__ tool is stage 'tool' targeting mcp:<server>, summary '<server> · <tool>'", () => {
    const line = parse(assistantLine({ cwd: CWD, timestamp: AT, toolUses: [{ name: "mcp__linear__save_issue", input: {} }] }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toEqual([
      { at: AT, stage: "tool", toolName: "mcp__linear__save_issue", targetObjectId: "mcp:linear", summary: "linear · save_issue" },
    ]);
  });

  it("any other tool_use (e.g. Bash) is stage 'tool' with no target", () => {
    const line = parse(assistantLine({ cwd: CWD, timestamp: AT, toolUses: [{ name: "Bash", input: { command: "npm test" } }] }));
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toEqual([{ at: AT, stage: "tool", toolName: "Bash", targetObjectId: null, summary: "Bash: npm test" }]);
  });

  it("a user line that is only a tool_result (no isUserText) yields nothing", () => {
    const raw = JSON.stringify({
      type: "user",
      timestamp: AT,
      cwd: CWD,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-0", content: "ok" }] },
    });
    const drafts = deriveActivity(parse(raw), CWD, AT);
    expect(drafts).toEqual([]);
  });

  it("multiple tool_use blocks on one line each produce their own draft", () => {
    const line = parse(
      assistantLine({
        cwd: CWD,
        timestamp: AT,
        toolUses: [
          { name: "Edit", input: { file_path: join(CWD, "a.ts") } },
          { name: "Bash", input: { command: "npm test" } },
        ],
      }),
    );
    const drafts = deriveActivity(line, CWD, AT);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.toolName).toBe("Edit");
    expect(drafts[1]?.toolName).toBe("Bash");
  });
});

describe("isMemoryOrVaultPath", () => {
  it("matches ~/.claude/projects/<any>/memory/...", () => {
    expect(isMemoryOrVaultPath(join(homedir(), ".claude", "projects", "-x-y", "memory", "a.md"))).toBe(true);
  });
  it("does not match a sibling directory under the same project id", () => {
    expect(isMemoryOrVaultPath(join(homedir(), ".claude", "projects", "-x-y", "not-memory", "a.md"))).toBe(false);
  });
  it("matches anywhere under ~/Documents/Code/alex_claude", () => {
    expect(isMemoryOrVaultPath(join(homedir(), "Documents", "Code", "alex_claude", "deep", "nested", "a.md"))).toBe(true);
  });
  it("does not match an unrelated path", () => {
    expect(isMemoryOrVaultPath("/Users/x/Documents/Code/agent-world/server/index.ts")).toBe(false);
  });
});

describe("Bash activity summaries", () => {
  it("carries the command, one line, preamble dropped, capped at 80 chars with an ellipsis", () => {
    expect(bashSummary("git commit -m 'fix: header'")).toBe("Bash: git commit -m 'fix: header'");
    expect(bashSummary("cd /Users/me/Documents/Code/app && export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH && git push origin feat/x")).toBe(
      "Bash: git push origin feat/x",
    );
    expect(bashSummary("cd /repo; npx vitest run --reporter=json")).toBe("Bash: npx vitest run --reporter=json");
    expect(bashSummary("npx   tsc\n  --noEmit\t-p .")).toBe("Bash: npx tsc --noEmit -p .");
    const long = bashSummary(`python3 - <<'EOF'\n${"x = 1\n".repeat(40)}EOF`);
    expect(long.length).toBe(80);
    expect(long.endsWith("…")).toBe(true);
    expect(bashSummary("cd /repo")).toBe("Bash: cd /repo"); // a lone cd is the command itself
    expect(bashSummary(undefined)).toBe("Bash");
    expect(bashSummary("   ")).toBe("Bash");
  });
  it("keeps commit / push / test commands recognisable", () => {
    for (const c of ["git -C /r commit -m x", "rtk git push", "npm test", "pytest -q", "npx tsc --noEmit", "bun run vitest"]) {
      expect(bashSummary(c)).toBe(`Bash: ${c}`);
    }
  });
  it("redacts secrets: sk-/ghp_ tokens, Bearer, --password=, NAME=value credentials, auth headers, URL passwords", () => {
    const cases: Array<[string, string]> = [
      ["curl -H 'Authorization: Bearer ${EXAMPLE_TOKEN}' https://api.x", "curl -H 'Authorization: [redacted]' https://api.x"],
      ["curl -H \"X-Api-Key: 12345abcde\" https://api.x", "curl -H \"X-Api-Key: [redacted]\" https://api.x"],
      ["http GET api.x Bearer eyJhbGciOiJIUzI1NiJ9", "http GET api.x Bearer [redacted]"],
      ["mysql --password=hunter2 -u root", "mysql --password=[redacted] -u root"],
      ["gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123", "gh auth login --with-token [redacted]"],
      ["API_KEY=abc123 node run.js", "API_KEY=[redacted] node run.js"],
      ["GITHUB_TOKEN='x y z' gh pr list", "GITHUB_TOKEN=[redacted] gh pr list"],
      ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx && node a.js", "export OPENAI_API_KEY=[redacted] && node a.js"],
      ["echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "echo [redacted]"],
      ["git clone https://me:s3cretpass@github.com/x/y", "git clone https://me:[redacted]@github.com/x/y"],
    ];
    for (const [raw, want] of cases) expect(redactCommand(raw), raw).toBe(want);
    // …and the summary never shows them, even behind a stripped preamble
    const s = bashSummary("cd /r && DB_PASSWORD=pw123 psql -c 'select 1'");
    expect(s).toBe("Bash: DB_PASSWORD=[redacted] psql -c 'select 1'");
    expect(bashSummary("curl -H 'Authorization: Bearer ${EXAMPLE_TOKEN}'")).not.toContain("EXAMPLE-FAKE-1");
  });
  it("leaves ordinary assignments and flags alone", () => {
    expect(redactCommand("NODE_ENV=test npx vitest run --reporter=json")).toBe("NODE_ENV=test npx vitest run --reporter=json");
    expect(redactCommand("git log --author=me --oneline")).toBe("git log --author=me --oneline");
  });
});
