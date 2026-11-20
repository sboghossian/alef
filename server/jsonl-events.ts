// Parses one line of a Claude Code session .jsonl into the handful of facts
// the indexer cares about. Session jsonl content is untrusted data written by
// past sessions — we only ever read fields out of it, never execute anything
// found inside it.

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  /** tool_use block id (`toolu_…`), pairs the call with its tool_result. */
  id?: string;
}

/** A tool_result block on a user line: the id of the call it answers and its raw content. */
export interface ToolResult {
  toolUseId: string;
  content: unknown;
  /** The block's is_error: the call failed or never ran (a denied permission, a non-zero exit). */
  isError: boolean;
}

/** A `{"type":"pr-link","prRepository":"owner/repo","prNumber":7,…}` record: Claude Code appends
 *  one to a session's transcript when that session (or one of its subagents) opened a PR. */
export interface PrLink {
  repo: string;
  number: number | null;
}

/** input + output + cache_creation tokens on one assistant line's usage block. cache_read is deliberately excluded. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ParsedLine {
  /** Present on user/assistant/system lines emitted by the CLI. */
  cwd: string | null;
  timestamp: string | null;
  /** True for any type:"user" line, regardless of whether it carries extractable text (message-count). */
  isUserLine: boolean;
  /** True only when that user line's first content block is human-readable text (session-title candidate). */
  isUserText: boolean;
  userText: string | null;
  /** True for an assistant turn (used for the text-only vs. tool-use ratio). */
  isAssistant: boolean;
  /** model id reported on an assistant turn, if any. */
  model: string | null;
  toolUses: ToolUse[];
  /** Final text block of an assistant turn with no tool use, if any. */
  assistantText: string | null;
  /** True when an assistant turn carries an extended-thinking block. */
  hasThinking: boolean;
  /** message.usage on an assistant turn, if present. */
  usage: TokenUsage | null;
  /** message.id on an assistant turn, if present. One logical turn is streamed across
   *  several jsonl lines (one per content block — thinking, then tool_use, ...), each
   *  repeating the SAME id and the SAME (cumulative) usage block. Callers must dedupe
   *  usage by this id or they will count the same turn's tokens multiple times. */
  messageId: string | null;
  /** customTitle of a `{"type":"custom-title","customTitle":…,"sessionId":…}` line: the name the
   *  user gave the session with /rename. Claude Code re-appends it later, so the last one wins. */
  customTitle: string | null;
  /** aiTitle of a `{"type":"ai-title","aiTitle":…,"sessionId":…}` line: Claude Code's own generated
   *  title (interactive sessions; headless `claude -p` runs don't get one). */
  aiTitle: string | null;
  /** Set on a pr-link record only. */
  prLink: PrLink | null;
  /** tool_result blocks of a user line (placement-evidence-lib.ts reads the ship commands'). */
  toolResults: ToolResult[];
}

const EMPTY: ParsedLine = {
  cwd: null,
  timestamp: null,
  isUserLine: false,
  isUserText: false,
  userText: null,
  isAssistant: false,
  model: null,
  toolUses: [],
  assistantText: null,
  hasThinking: false,
  messageId: null,
  usage: null,
  customTitle: null,
  aiTitle: null,
  prLink: null,
  toolResults: [],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns null when the line is not valid JSON (caller counts that as malformed). */
export function parseLine(raw: string): ParsedLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return { ...EMPTY }; // blank lines are not malformed, just empty
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return { ...EMPTY };

  const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : null;
  const type = typeof obj.type === "string" ? obj.type : null;
  const message = isRecord(obj.message) ? obj.message : null;

  if (type === "user" && message) {
    const text = extractText(message.content);
    return {
      cwd,
      timestamp,
      isUserLine: true,
      isUserText: text !== null,
      userText: text,
      isAssistant: false,
      model: null,
      toolUses: [],
      assistantText: null,
      hasThinking: false,
      usage: null,
      messageId: null,
      customTitle: null,
      aiTitle: null,
      prLink: null,
      toolResults: extractToolResults(message.content),
    };
  }

  if (type === "assistant" && message) {
    const model = typeof message.model === "string" ? message.model : null;
    const toolUses = extractToolUses(message.content);
    return {
      cwd,
      timestamp,
      isUserLine: false,
      isUserText: false,
      userText: null,
      isAssistant: true,
      model,
      toolUses,
      assistantText: toolUses.length === 0 ? extractText(message.content) : null,
      hasThinking: hasThinkingBlock(message.content),
      usage: extractUsage(message.usage),
      messageId: typeof message.id === "string" ? message.id : null,
      customTitle: null,
      aiTitle: null,
      prLink: null,
      toolResults: [],
    };
  }

  if (type === "custom-title") return { ...EMPTY, cwd, timestamp, customTitle: typeof obj.customTitle === "string" ? obj.customTitle : null };
  if (type === "ai-title") return { ...EMPTY, cwd, timestamp, aiTitle: typeof obj.aiTitle === "string" ? obj.aiTitle : null };
  if (type === "pr-link" && typeof obj.prRepository === "string") {
    return { ...EMPTY, cwd, timestamp, prLink: { repo: obj.prRepository, number: typeof obj.prNumber === "number" ? obj.prNumber : null } };
  }

  // Any other line type (queue-operation, attachment, system, ...):
  // still carry cwd/timestamp if present, nothing else.
  return { ...EMPTY, cwd, timestamp };
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return null;
}

function hasThinkingBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type === "thinking");
}

/** input+output+cache_creation only — cache_read is a discount on input, not new spend. */
function extractUsage(usage: unknown): TokenUsage | null {
  if (!isRecord(usage)) return null;
  if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") return null;
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cacheCreationInputTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
  };
}

function extractToolUses(content: unknown): ToolUse[] {
  if (!Array.isArray(content)) return [];
  const uses: ToolUse[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
      const use: ToolUse = { name: block.name, input: isRecord(block.input) ? block.input : {} };
      if (typeof block.id === "string") use.id = block.id;
      uses.push(use);
    }
  }
  return uses;
}

function extractToolResults(content: unknown): ToolResult[] {
  if (!Array.isArray(content)) return [];
  const out: ToolResult[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      out.push({ toolUseId: block.tool_use_id, content: block.content, isError: block.is_error === true });
    }
  }
  return out;
}

const FILE_PATH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PATH_ARG_TOOLS = new Set(["Glob", "Grep"]);

/** File/repo-relevant path referenced by a tool call, if any. */
export function filePathFromToolUse(use: ToolUse): string | null {
  if (FILE_PATH_TOOLS.has(use.name)) {
    const v = use.input.file_path;
    return typeof v === "string" ? v : null;
  }
  if (PATH_ARG_TOOLS.has(use.name)) {
    const v = use.input.path;
    return typeof v === "string" ? v : null;
  }
  return null;
}

/** skill:<name> target, if this tool call is a Skill invocation. */
export function skillFromToolUse(use: ToolUse): string | null {
  if (use.name !== "Skill") return null;
  const v = use.input.skill;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** mcp:<server> target, if this tool call is an MCP tool (mcp__<server>__<tool>). */
export function mcpServerFromToolUse(use: ToolUse): string | null {
  if (!use.name.startsWith("mcp__")) return null;
  const rest = use.name.slice("mcp__".length);
  const idx = rest.indexOf("__");
  const server = idx === -1 ? rest : rest.slice(0, idx);
  return server.length > 0 ? server : null;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const RESEARCH_TOOLS = new Set(["WebFetch", "WebSearch", "Grep"]);

export function toolCategory(name: string): "edit" | "research" | "bash" | "other" {
  if (EDIT_TOOLS.has(name)) return "edit";
  if (RESEARCH_TOOLS.has(name)) return "research";
  if (name === "Bash") return "bash";
  return "other";
}
