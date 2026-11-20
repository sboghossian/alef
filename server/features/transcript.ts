// Read-only access to one session's transcript (<projectsDir>/<project>/<sessionId>.jsonl)
// for the code "touched" list and the shelf. Transcript content is untrusted data: we only
// read fields out of it, never execute it. Large files are read whole but capped.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../http.js";
import { isValidUuid } from "../reactivate.js";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const pathCache = new Map<string, string>();

/** Absolute path of the session's jsonl, or null. Scans project dirs once per id (cached). */
export async function findSessionJsonl(projectsDir: string, sessionId: string): Promise<string | null> {
  if (!isValidUuid(sessionId)) return null;
  const cached = pathCache.get(`${projectsDir}\n${sessionId}`);
  if (cached) {
    try {
      await stat(cached);
      return cached;
    } catch {
      pathCache.delete(`${projectsDir}\n${sessionId}`);
    }
  }
  let dirs: string[];
  try {
    dirs = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(projectsDir, d, `${sessionId}.jsonl`);
    try {
      const st = await stat(p);
      if (st.isFile()) {
        pathCache.set(`${projectsDir}\n${sessionId}`, p);
        return p;
      }
    } catch {
      /* not here */
    }
  }
  return null;
}

export interface TranscriptToolUse {
  name: string;
  input: Record<string, unknown>;
  at: string | null;
}

export interface TranscriptEntry {
  at: string | null;
  role: "user" | "assistant";
  /** Human-readable text blocks (user prompt text, assistant text). Tool results are excluded. */
  texts: string[];
  toolUses: TranscriptToolUse[];
}

/** Parses a transcript into user/assistant entries. Skips malformed lines. */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const type = obj.type;
    if (type !== "user" && type !== "assistant") continue;
    const at = typeof obj.timestamp === "string" ? obj.timestamp : null;
    const message = isRecord(obj.message) ? obj.message : null;
    if (!message) continue;
    const texts: string[] = [];
    const toolUses: TranscriptToolUse[] = [];
    const content = message.content;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if (block.type === "tool_use" && typeof block.name === "string" && isRecord(block.input)) {
          toolUses.push({ name: block.name, input: block.input, at });
        }
      }
    }
    out.push({ at, role: type, texts, toolUses });
  }
  return out;
}

/** Reads and parses the session transcript, or null when there is none. */
export async function readTranscript(projectsDir: string, sessionId: string): Promise<TranscriptEntry[] | null> {
  const p = await findSessionJsonl(projectsDir, sessionId);
  if (!p) return null;
  try {
    const st = await stat(p);
    if (st.size > MAX_TRANSCRIPT_BYTES) return null;
    return parseTranscript(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}
