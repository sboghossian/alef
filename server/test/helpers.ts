// Shared test fixtures: build synthetic ~/.claude/projects-shaped jsonl trees
// in a scratch temp dir so the indexer tests never touch the real ~/.claude.

import { mkdtemp, mkdir, appendFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, WorldDb } from "../db.js";
import { startServer, type RunningServer, type ServerConfig } from "../index.js";
import type { DispatchExecutor, OpenEditorExecutor, ReactivateExecutor } from "../reactivate.js";

export async function makeTempProjectsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-world-test-"));
}

export async function makeTempDb(dir: string): Promise<WorldDb> {
  return new WorldDb(openDb(join(dir, "world.db")));
}

function neverCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be called in this test`);
  };
}

/** Boots a real server against a fresh temp dir, with no-op/throwing executors by
 *  default so a test only has to override the one it cares about. Never opens a
 *  real Terminal or VS Code, and never touches the real ~/.claude. */
export async function bootTestServer(overrides: {
  reactivateExecutor?: ReactivateExecutor;
  dispatchExecutor?: DispatchExecutor;
  openEditorExecutor?: OpenEditorExecutor;
  configOverrides?: Partial<ServerConfig>;
} = {}): Promise<{ base: string; server: RunningServer; dir: string }> {
  const dir = await makeTempProjectsDir();
  const config: ServerConfig = {
    projectsDir: join(dir, "projects"),
    claudeDir: join(dir, "no-claude-dir"),
    claudeJsonPath: join(dir, "no-claude.json"),
    dbPath: join(dir, "world.db"),
    port: 0,
    reactivateExecutor: overrides.reactivateExecutor ?? neverCalled("reactivateExecutor"),
    dispatchExecutor: overrides.dispatchExecutor ?? neverCalled("dispatchExecutor"),
    openEditorExecutor: overrides.openEditorExecutor ?? neverCalled("openEditorExecutor"),
    // "" (not undefined) so a real TYPESAFE_API_KEY on the host is never picked up by
    // accident — tests that want the "online" path override this explicitly.
    typesafeApiKey: "",
    liveDetector: () => new Map(),
    ...overrides.configOverrides,
  };
  const server = await startServer(config);
  return { base: `http://127.0.0.1:${server.port}`, server, dir };
}

export interface UserLineOpts {
  cwd: string;
  timestamp: string;
  text: string;
}

export function userLine(o: UserLineOpts): string {
  return JSON.stringify({
    type: "user",
    timestamp: o.timestamp,
    cwd: o.cwd,
    message: { role: "user", content: [{ type: "text", text: o.text }] },
  });
}

export interface UsageOpts {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number; // included in the fixture, but the indexer must never sum it
}

export interface AssistantLineOpts {
  cwd: string;
  timestamp: string;
  model?: string;
  toolUses?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Text of a text-only turn (ignored when toolUses is non-empty). Defaults to "ok". */
  text?: string;
  thinking?: boolean;
  usage?: UsageOpts;
  /** message.id. Real transcripts repeat the same id (and the same usage block) across
   *  every content-block line of one logical turn — set this explicitly to build that. */
  messageId?: string;
}

export function assistantLine(o: AssistantLineOpts): string {
  const content: Array<Record<string, unknown>> = [];
  if (o.thinking) content.push({ type: "thinking", thinking: "hmm" });
  if (o.toolUses && o.toolUses.length > 0) {
    for (const [i, t] of o.toolUses.entries()) content.push({ type: "tool_use", id: `tool-${i}`, name: t.name, input: t.input });
  } else if (!o.thinking || o.text) {
    content.push({ type: "text", text: o.text ?? "ok" });
  }
  const usage = o.usage
    ? {
        input_tokens: o.usage.inputTokens ?? 0,
        output_tokens: o.usage.outputTokens ?? 0,
        cache_creation_input_tokens: o.usage.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: o.usage.cacheReadInputTokens ?? 0,
      }
    : undefined;
  return JSON.stringify({
    type: "assistant",
    timestamp: o.timestamp,
    cwd: o.cwd,
    message: { role: "assistant", id: o.messageId, model: o.model ?? "claude-test", content, usage },
  });
}

/** Writes `<projectsDir>/<projectDirName>/<sessionId>.jsonl` with the given raw lines (no trailing newline added beyond what's given). */
export async function writeSessionFile(
  projectsDir: string,
  projectDirName: string,
  sessionId: string,
  body: string,
): Promise<string> {
  const dir = join(projectsDir, projectDirName);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  await writeFile(filePath, body, "utf8");
  return filePath;
}

export async function appendToSessionFile(filePath: string, body: string): Promise<void> {
  await appendFile(filePath, body, "utf8");
  // Nudge mtime forward so size+mtime-based change detection reliably sees a diff
  // even when the filesystem's mtime resolution is coarse.
  const future = new Date(Date.now() + 2000);
  await utimes(filePath, future, future);
}
