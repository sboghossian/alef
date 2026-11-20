// webtrips-lib: which tool calls leave the planet, on tool_use blocks shaped exactly like the ones
// Claude Code writes (an assistant line, a toolu_ id, the tool's real input schema: WebFetch
// {url, prompt}, WebSearch {query}, mcp__exa__web_fetch_exa {urls}, mcp__exa__web_search_exa
// {query, objective}, mcp__obscura__browser_navigate {url}, Bash {command}).

import { describe, expect, it } from "vitest";
import { webTripsLine } from "../../shared/features/webtrips.js";
import { addTrip, deniedCallsInLine, denyTrip, newTally, toEntry, tripsInLine, webTripOf } from "../features/webtrips-lib.js";

const AT = "2026-09-29T08:00:00.000Z";
let n = 0;
function assistant(blocks: Array<{ id?: string; name: string; input: Record<string, unknown> }>, at = AT): string {
  return JSON.stringify({
    parentUuid: `u${n}`,
    isSidechain: false,
    type: "assistant",
    uuid: `u${++n}`,
    timestamp: at,
    cwd: "/Users/tester/Documents/Code/agent-world",
    sessionId: "11111111-1111-4111-8111-111111111111",
    message: { model: "claude-opus-5-5", id: `msg_${n}`, type: "message", role: "assistant", content: blocks.map((b) => ({ type: "tool_use", ...(b.id ? { id: b.id } : {}), name: b.name, input: b.input })) },
  });
}
function toolResult(id: string, text: string): string {
  return JSON.stringify({ type: "user", uuid: `u${++n}`, timestamp: AT, message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text }] }] } });
}

describe("webTripOf", () => {
  it("counts the web tools on their real input shapes, with the hosts they name", () => {
    expect(webTripOf("WebFetch", { url: "https://Docs.Anthropic.com/en/hooks", prompt: "summarise" })).toEqual({ tool: "WebFetch", hosts: ["docs.anthropic.com"] });
    expect(webTripOf("WebSearch", { query: "claude code hooks", allowed_domains: ["anthropic.com"] })).toEqual({ tool: "WebSearch", hosts: [] });
    expect(webTripOf("mcp__exa__web_fetch_exa", { urls: ["https://exa.ai/docs", "https://a.test/x", "https://exa.ai/other"], maxCharacters: 3000 })).toEqual({
      tool: "exa",
      hosts: ["exa.ai", "a.test"],
    });
    expect(webTripOf("mcp__exa__web_search_exa", { query: "firecrawl pricing", objective: "the pricing page" })).toEqual({ tool: "exa", hosts: [] });
    expect(webTripOf("mcp__obscura__browser_navigate", { url: "https://news.ycombinator.com/", waitUntil: "load" })).toEqual({ tool: "obscura", hosts: ["news.ycombinator.com"] });
    expect(webTripOf("mcp__firecrawl__firecrawl_scrape", { url: "https://x.test/a" })).toEqual({ tool: "firecrawl", hosts: ["x.test"] });
    expect(webTripOf("mcp__firecrawl__firecrawl_search", { query: "x" })).toEqual({ tool: "firecrawl", hosts: [] });
    expect(webTripOf("Bash", { command: 'curl -sL "https://api.github.com/repos/x/y"' })).toEqual({ tool: "curl", hosts: ["api.github.com"] });
  });

  it("never counts this Mac's own servers, reads of a page already fetched, echoed text or other tools", () => {
    expect(webTripOf("WebFetch", { url: "http://localhost:5179/api/world", prompt: "p" })).toBeNull();
    expect(webTripOf("mcp__obscura__browser_navigate", { url: "http://127.0.0.1:5178/" })).toBeNull();
    expect(webTripOf("mcp__obscura__browser_snapshot", {})).toBeNull();
    expect(webTripOf("mcp__obscura__browser_search", { query: "pricing" })).toBeNull(); // finds text in the open page
    expect(webTripOf("Bash", { command: "curl -s localhost:5179/api/webtrips | jq ." })).toBeNull();
    expect(webTripOf("Bash", { command: 'echo "curl https://x.com"' })).toBeNull();
    expect(webTripOf("Bash", { command: "npm test" })).toBeNull();
    expect(webTripOf("Read", { file_path: "/Users/tester/https-notes.md" })).toBeNull();
    expect(webTripOf("mcp__claude_ai_Gmail__search_threads", { query: "x" })).toBeNull();
    // A javascript: or file: URL names no host (still a trip when the tool itself is a web tool).
    expect(webTripOf("mcp__exa__web_fetch_exa", { urls: ["javascript:alert(1)", "file:///etc/passwd"] })).toEqual({ tool: "exa", hosts: [] });
  });
});

describe("tripsInLine", () => {
  it("finds every web call in an assistant line, keyed by its tool_use id", () => {
    const line = assistant([
      { id: "toolu_01Fetch", name: "WebFetch", input: { url: "https://a.test/x", prompt: "p" } },
      { id: "toolu_01Read", name: "Read", input: { file_path: "/tmp/x" } },
      { id: "toolu_01Search", name: "WebSearch", input: { query: "q" } },
    ]);
    const found = tripsInLine(line);
    expect(found.map((f) => [f.key, f.trip.tool, f.at])).toEqual([
      ["toolu_01Fetch", "WebFetch", AT],
      ["toolu_01Search", "WebSearch", AT],
    ]);
    // The same bytes as a Buffer (the cold pass reads Buffers).
    expect(tripsInLine(Buffer.from(line)).map((f) => f.key)).toEqual(["toolu_01Fetch", "toolu_01Search"]);
  });

  it("ignores tool results, user text that quotes a tool call, torn lines, and a call it cannot key", () => {
    expect(tripsInLine(toolResult("toolu_01Fetch", 'the page said {"type":"tool_use","name":"WebFetch"}'))).toEqual([]);
    expect(tripsInLine(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: '"tool_use" WebSearch' }] } }))).toEqual([]);
    expect(tripsInLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebSearch"')).toEqual([]);
    const noKey = JSON.stringify({ type: "assistant", timestamp: AT, message: { role: "assistant", content: [{ type: "tool_use", name: "WebSearch", input: { query: "q" } }] } });
    expect(tripsInLine(noKey)).toEqual([]);
    // No tool_use id but a line uuid: keyed by uuid + block index.
    expect(tripsInLine(assistant([{ name: "WebSearch", input: { query: "q" } }])).map((f) => f.key)).toEqual([`u${n}#0`]);
  });
});

describe("the tally", () => {
  it("counts a call once however many times its line is read, and keeps own vs subagent trips apart", () => {
    const t = newTally();
    const a = tripsInLine(assistant([{ id: "toolu_A", name: "WebFetch", input: { url: "https://a.test/1", prompt: "p" } }], "2026-09-29T09:00:00.000Z"))[0]!;
    const b = tripsInLine(assistant([{ id: "toolu_B", name: "mcp__exa__web_fetch_exa", input: { urls: ["https://a.test/2", "https://b.test/"] } }]))[0]!;
    const c = tripsInLine(assistant([{ id: "toolu_C", name: "WebSearch", input: { query: "q" } }]))[0]!;
    expect(addTrip(t, a, false)).toBe(true);
    expect(addTrip(t, a, false)).toBe(false); // the cold pass and the indexer both saw it
    expect(addTrip(t, b, true)).toBe(true);
    expect(addTrip(t, c, true)).toBe(true);
    const e = toEntry("s1", t);
    expect(e).toEqual({
      sessionId: "s1",
      trips: 3,
      subagentTrips: 2,
      hosts: 2,
      topHosts: [
        { host: "a.test", trips: 2 },
        { host: "b.test", trips: 1 },
      ],
      byTool: { WebSearch: 1, WebFetch: 1, exa: 1 },
      lastAt: "2026-09-29T09:00:00.000Z",
    });
    expect(webTripsLine(e)).toBe("3 web trips · 2 hosts");
    expect(webTripsLine({ trips: 1, hosts: 0 })).toBe("1 web trip · no named host");
    expect(webTripsLine({ trips: 0, hosts: 0 })).toBe("No web trips");
  });
});

// A tool_result line the way Claude Code 2.1.284 writes it when a call never ran (read from the
// installed CLI's source, not from a transcript): `Ae({content:[{type:"tool_result", content,
// is_error:true, tool_use_id}], toolUseResult, toolDenialKind, sourceToolAssistantUUID})`.
// `toolDenialKind` is one of user-rejected, permission-rule, automode-blocked,
// automode-unavailable, automode-parsing-error, interrupted, cancelled. Older transcripts have
// no toolDenialKind: only the harness's wording tells a denial apart.
function result(id: string, content: unknown, opts: { isError?: boolean; kind?: string } = {}): string {
  return JSON.stringify({
    parentUuid: `u${n}`,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content, ...(opts.isError === false ? {} : { is_error: true }), tool_use_id: id }] },
    uuid: `u${++n}`,
    timestamp: AT,
    toolUseResult: `Error: ${typeof content === "string" ? content : "x"}`,
    ...(opts.kind ? { toolDenialKind: opts.kind } : {}),
    sourceToolAssistantUUID: `u${n - 1}`,
  });
}

describe("deniedCallsInLine: a call the harness refused never left the Mac", () => {
  it("finds the calls denied by a rule, a hook, the user, the auto-mode classifier, a headless run or WebFetch's domain check", () => {
    // A permission rule (deny list, or `claude -p` with no allow rule), wrapped as the CLI wraps it.
    expect(deniedCallsInLine(result("toolu_R", "<tool_use_error>Permission to use WebFetch with domain:x.test has been denied.</tool_use_error>", { kind: "permission-rule" }))).toEqual(["toolu_R"]);
    // A PreToolUse hook's own reason: any text, the kind alone says it.
    expect(deniedCallsInLine(result("toolu_H", "no web from this repo", { kind: "permission-rule" }))).toEqual(["toolu_H"]);
    expect(deniedCallsInLine(result("toolu_U", "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.", { kind: "user-rejected" }))).toEqual(["toolu_U"]);
    expect(deniedCallsInLine(result("toolu_C", "Permission for this action was denied by the Claude Code auto mode classifier. Reason: fetches an unknown host", { kind: "automode-blocked" }))).toEqual(["toolu_C"]);
    expect(deniedCallsInLine(result("toolu_V", "x", { kind: "automode-unavailable" }))).toEqual(["toolu_V"]);
    // Older transcripts, no toolDenialKind: the wording, at the start of an is_error result.
    expect(deniedCallsInLine(result("toolu_P", "Claude requested permissions to use WebFetch, but you haven't granted it yet."))).toEqual(["toolu_P"]);
    expect(deniedCallsInLine(result("toolu_B", "Permission to use Bash with command curl -s https://x.test has been denied."))).toEqual(["toolu_B"]);
    expect(deniedCallsInLine(result("toolu_K", "Execution stopped by PreToolUse hook: web is off"))).toEqual(["toolu_K"]);
    // WebFetch's blocked-domain check throws before the page is fetched (no toolDenialKind).
    expect(deniedCallsInLine(result("toolu_D", "<tool_use_error>Error calling tool (WebFetch): Claude Code is unable to fetch from blocked.test</tool_use_error>"))).toEqual(["toolu_D"]);
    expect(deniedCallsInLine(result("toolu_E", [{ type: "text", text: "Error calling tool (WebFetch): Unable to verify if domain x.test is safe to fetch. This may be due to network restrictions" }]))).toEqual(["toolu_E"]);
  });

  it("keeps a call that ran, failed on the web, or was cut off mid-run, and ignores quoted denial text", () => {
    // Interrupted or cancelled: it may already have left, so it stays a trip.
    expect(deniedCallsInLine(result("toolu_I", "[Request interrupted by user for tool use]", { kind: "interrupted" }))).toEqual([]);
    expect(deniedCallsInLine(result("toolu_X", "[Request interrupted by user for tool use]", { kind: "cancelled" }))).toEqual([]);
    // It ran and the network said no: still a trip.
    expect(deniedCallsInLine(result("toolu_F", "Exit code 6\ncurl: (6) Could not resolve host: x.test"))).toEqual([]);
    // A page that quotes the harness is not a denial: not an error, or not at the start.
    expect(deniedCallsInLine(result("toolu_Q", "The user doesn't want to proceed with this tool use.", { isError: false }))).toEqual([]);
    expect(deniedCallsInLine(result("toolu_M", "Exit code 1\nlog: Permission to use WebFetch has been denied."))).toEqual([]);
    // Not a result line at all, or torn.
    expect(deniedCallsInLine(assistant([{ id: "toolu_A", name: "WebFetch", input: { url: "https://a.test/", prompt: "p" } }]))).toEqual([]);
    expect(deniedCallsInLine('{"type":"user","toolDenialKind":"permission-rule","message":{"content":[{"type":"tool_result"')).toEqual([]);
    // The same bytes as a Buffer (the cold pass reads Buffers).
    expect(deniedCallsInLine(Buffer.from(result("toolu_R2", "x", { kind: "permission-rule" })))).toEqual(["toolu_R2"]);
  });
});

describe("the tally takes a denied call back", () => {
  it("a denial read after its call un-counts it: trips, own/subagent, tool, hosts and last time", () => {
    const t = newTally();
    const a = tripsInLine(assistant([{ id: "toolu_A", name: "WebFetch", input: { url: "https://a.test/1", prompt: "p" } }], "2026-09-29T09:00:00.000Z"))[0]!;
    const b = tripsInLine(assistant([{ id: "toolu_B", name: "mcp__exa__web_fetch_exa", input: { urls: ["https://a.test/2", "https://b.test/"] } }]))[0]!;
    const c = tripsInLine(assistant([{ id: "toolu_C", name: "WebSearch", input: { query: "q" } }]))[0]!;
    addTrip(t, a, false);
    addTrip(t, b, true);
    addTrip(t, c, true);
    expect(denyTrip(t, "toolu_A")).toBe(true);
    expect(denyTrip(t, "toolu_A")).toBe(false); // read twice: taken back once
    expect(addTrip(t, a, false)).toBe(false); // the other path re-reads the call: still not counted
    expect(toEntry("s1", t)).toEqual({
      sessionId: "s1",
      trips: 2,
      subagentTrips: 2,
      hosts: 2,
      topHosts: [
        { host: "a.test", trips: 1 },
        { host: "b.test", trips: 1 },
      ],
      byTool: { WebSearch: 1, exa: 1 },
      lastAt: AT,
    });
    expect(denyTrip(t, "toolu_B")).toBe(true);
    expect(denyTrip(t, "toolu_C")).toBe(true);
    const none = toEntry("s1", t);
    expect(none).toEqual({ sessionId: "s1", trips: 0, subagentTrips: 0, hosts: 0, topHosts: [], byTool: {}, lastAt: null });
    expect(webTripsLine(none)).toBe("No web trips");
  });

  it("a denial read before its call (the two paths split a session) keeps the call from ever counting", () => {
    const t = newTally();
    expect(denyTrip(t, "toolu_D")).toBe(false); // nothing to take back yet
    const d = tripsInLine(assistant([{ id: "toolu_D", name: "WebFetch", input: { url: "https://d.test/", prompt: "p" } }]))[0]!;
    expect(addTrip(t, d, false)).toBe(false);
    expect(addTrip(t, d, false)).toBe(false);
    expect(toEntry("s1", t)).toMatchObject({ trips: 0, hosts: 0, lastAt: null });
  });
});
