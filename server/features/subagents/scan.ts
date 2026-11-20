// Filesystem side of the subagents feature: finds subagent transcripts (flat and
// workflows/ nesting) and streams complete lines from a byte offset. Read-only.

import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentMeta } from "./fold.js";

export interface SubagentFileRef {
  path: string;
  metaPath: string;
  agentId: string;
  parentSessionId: string;
  workflowId: string | null;
  /** The parent's own transcript: <project>/<sessionId>.jsonl (may not exist any more). */
  parentPath: string;
}

const AGENT_FILE_RE = /^agent-([A-Za-z0-9_-]{4,64})\.jsonl$/;
const SESSION_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function names(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function refsIn(dir: string, fileNames: string[], parentSessionId: string, workflowId: string | null, parentPath: string): SubagentFileRef[] {
  const out: SubagentFileRef[] = [];
  for (const f of fileNames) {
    const m = AGENT_FILE_RE.exec(f);
    if (!m?.[1]) continue;
    out.push({
      path: join(dir, f),
      metaPath: join(dir, `agent-${m[1]}.meta.json`),
      agentId: m[1],
      parentSessionId,
      workflowId,
      parentPath,
    });
  }
  return out;
}

/** Every subagent transcript under `projectsDir`:
 *  <project>/<sessionId>/subagents/agent-<id>.jsonl and
 *  <project>/<sessionId>/subagents/workflows/<wfId>/agent-<id>.jsonl (journal.jsonl is skipped). */
export async function listSubagentFiles(projectsDir: string): Promise<SubagentFileRef[]> {
  const out: SubagentFileRef[] = [];
  for (const project of await dirs(projectsDir)) {
    const projectPath = join(projectsDir, project);
    for (const session of await dirs(projectPath)) {
      if (!SESSION_DIR_RE.test(session)) continue;
      const subDir = join(projectPath, session, "subagents");
      const entries = await names(subDir);
      if (entries.length === 0) continue;
      const parentPath = join(projectPath, `${session}.jsonl`);
      out.push(...refsIn(subDir, entries, session, null, parentPath));
      if (entries.includes("workflows")) {
        for (const wf of await dirs(join(subDir, "workflows"))) {
          const wfDir = join(subDir, "workflows", wf);
          out.push(...refsIn(wfDir, await names(wfDir), session, wf, parentPath));
        }
      }
    }
  }
  return out;
}

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Every top-level session transcript under `projectsDir`: <project>/<sessionId>.jsonl. */
export async function listSessionFiles(projectsDir: string): Promise<Array<{ path: string; sessionId: string }>> {
  const out: Array<{ path: string; sessionId: string }> = [];
  for (const project of await dirs(projectsDir)) {
    for (const f of await names(join(projectsDir, project))) {
      const id = SESSION_FILE_RE.exec(f)?.[1];
      if (id) out.push({ path: join(projectsDir, project, f), sessionId: id });
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** agent-<id>.meta.json → { agentType, description, toolUseId, model }; null when missing/garbled. */
export async function readMeta(metaPath: string): Promise<SubagentMeta | null> {
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return { agentType: str(o.agentType), description: str(o.description), toolUseId: str(o.toolUseId), model: str(o.model) };
  } catch {
    return null;
  }
}

const NEWLINE = 0x0a;

/** Streams `path` from `start`, calling `onLine` for each COMPLETE line (a trailing partial
 *  line is left for the next pass). Returns the offset just past the last complete line. */
export async function streamLines(path: string, start: number, onLine: (line: Buffer) => void): Promise<number> {
  let consumed = start; // offset just past the last complete line
  let read = start; // offset of the current chunk's first byte
  // A partial line spanning chunks is kept as a list of pieces and joined once, when its
  // newline shows up, so one 30 MB tool-result line never costs quadratic copying.
  const pending: Buffer[] = [];
  const stream = createReadStream(path, { start, highWaterMark: 1 << 20 });
  for await (const raw of stream) {
    const chunk = raw as Buffer;
    let s = 0;
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, s);
      if (nl === -1) break;
      if (pending.length) {
        pending.push(chunk.subarray(s, nl));
        const line = Buffer.concat(pending);
        pending.length = 0;
        if (line.length) onLine(line);
      } else if (nl > s) {
        onLine(chunk.subarray(s, nl));
      }
      s = nl + 1;
      consumed = read + s;
    }
    if (s < chunk.length) pending.push(Buffer.from(chunk.subarray(s)));
    read += chunk.length;
  }
  return consumed;
}
