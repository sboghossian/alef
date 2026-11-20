import { describe, expect, it } from "vitest";
import { claudeAncestorPids, filterClaudeProcesses, parseProcessTree } from "../live.js";

const row = (command: string) => ({ pid: 1, command });

describe("filterClaudeProcesses", () => {
  it("matches real claude executables", () => {
    const hits = filterClaudeProcesses([
      row("claude"),
      row("/opt/homebrew/bin/claude --resume abc"),
      row("/Users/x/.vscode/extensions/anthropic.claude-code-2.1.280-darwin-arm64/resources/native-binary/claude --output-format stream-json"),
      row("claude -p You are the narrative step"),
    ]);
    expect(hits).toHaveLength(4);
  });
  it("ignores processes that merely mention claude", () => {
    const hits = filterClaudeProcesses([
      row("/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot.sh"),
      row("node /Users/x/.claude/plugins/cache/grok-plugin/grok/0.4.0/bin/grok-bridge.js mcp"),
      row("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/private/tmp/claude-501/x"),
      row("/bin/zsh /Users/x/.claude/skills/daily-recap/run.sh"),
      row("/Applications/Claude.app/Contents/MacOS/Claude"),
    ]);
    expect(hits).toHaveLength(0);
  });
  // Regression 2026-09-27: `ps` showed 4 live `claude` processes for pid 66742's shape while
  // liveCount reported 2 — the npm-installed CLI's real binary is named claude.exe (not a Windows
  // check; historical name), and the old pattern had no `.exe` branch at all.
  it("matches the real claude.exe binary (npm-installed CLI), bare or with a full path and args", () => {
    const hits = filterClaudeProcesses([
      row("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --permission-mode plan"),
      row("claude.exe"),
    ]);
    expect(hits).toHaveLength(2);
  });
  it("still rejects the Claude.app GUI and a claude-helper binary", () => {
    const hits = filterClaudeProcesses([row("/Applications/Claude.app/Contents/MacOS/Claude"), row("/usr/local/bin/claude-helper")]);
    expect(hits).toHaveLength(0);
  });
});

// `ps -Ao pid=,ppid=,command=` rows as they were on 2026-09-28 (commands trimmed): three Alef
// launches, each `zsh -c 'claude …; rm -f …'` under tmux (66725), plus two VS Code claudes.
const REAL_PS = [
  "  66725     1 tmux new-session -d -s aw-68597ce4 -c /Users/alexboghossian/Documents/Code/acme-www",
  `  66726 66725 zsh -c claude --permission-mode plan "$(cat '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/c2031f70.txt')"; rm -f '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/c2031f70.txt'`,
  "  66742 66726 /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --permission-mode plan",
  "  39735 66742 node /Users/alexboghossian/.claude/plugins/pencil/mcp.js",
  `  90077 66725 zsh -c claude --permission-mode plan "$(cat '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/6ec3061a.txt')"; rm -f '…'`,
  "  90093 90077 claude --permission-mode plan Cutover (HARD STOP moment, pre-approved 2026-09-25): tunnel ingress removed",
  `  90545 66725 zsh -c claude --permission-mode plan "$(cat '/var/folders/jv/glb2_j851d12s88pwtwp1q4r0000gn/T/agent-world-dispatch/cc09cb82.txt')"; rm -f '…'`,
  "  90561 90545 claude --permission-mode plan Fix: Tests pass — Last run 43h ago — run again to be sure.",
  "  97011   900 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
  "  67356 97011 /Users/alexboghossian/.vscode/extensions/anthropic.claude-code-2.1.280-darwin-arm64/resources/native-binary/claude --output-format stream-json -",
  "  99163 97011 /Users/alexboghossian/.vscode/extensions/anthropic.claude-code-2.1.280-darwin-arm64/resources/native-binary/claude --output-format stream-json -",
  "  12345 66725 zsh",
].join("\n");

describe("claudeAncestorPids", () => {
  it("parses ps rows with pid, ppid and the full command", () => {
    const rows = parseProcessTree(REAL_PS);
    expect(rows).toHaveLength(12);
    expect(rows[2]).toEqual({ pid: 66742, ppid: 66726, command: "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --permission-mode plan" });
  });
  it("every Alef launch's zsh -c wrapper hosts a claude, although tmux reports it as plain 'zsh'", () => {
    const hosts = claudeAncestorPids(parseProcessTree(REAL_PS));
    for (const panePid of [66726, 90077, 90545]) expect(hosts.has(panePid)).toBe(true);
    expect(hosts.has(97011)).toBe(true); // VS Code's helper runs two
    expect(hosts.has(12345)).toBe(false); // a shell with no claude below it
    expect(hosts.has(66742)).toBe(false); // the claude itself is not its own host (only its MCP child is below it)
    expect(hosts.has(1)).toBe(false);
  });
});
