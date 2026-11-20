// Per-session signals that the core indexer does not keep, read from the same jsonl
// lines: the latest todo list (TodoWrite, or TaskCreate/TaskUpdate), tool calls still
// waiting for their tool_result, and recent file writes. Shared by the todos,
// agent-state and conflicts features (not a feature itself).
//
// State lives in memory. On boot it is rebuilt by a cold scan of sessions written in
// the last few hours (the core indexer only hands features lines appended after boot).
// Why not a table: every input is re-derivable from the jsonl, the scan is bounded
// (≤60 files), and nothing here must survive a restart that the jsonl doesn't already hold.
//
// Transcript content is untrusted: we only read fields out of it, never execute it.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TodoItem, TodoList, TodoStatus } from "../../shared/features/todos.js";
import { redactSecrets } from "../heuristics.js";
import { isRecord } from "../http.js";
import type { FeatureContext } from "./registry.js";
import type { WorldAgent } from "../../shared/types.js";

export const WRITE_WINDOW_MS = 30 * 60_000;
const PENDING_MAX_AGE_MS = 30 * 60_000;
const MAX_TODO_ITEMS = 30;
const COLD_SCAN_WINDOW_MS = 6 * 3600_000;
const COLD_SCAN_MAX_FILES = 60;

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface PendingTool {
  name: string;
  atMs: number;
}

interface TodoEntry {
  taskId: string | null; // set for TaskCreate-style items
  item: TodoItem;
}

export interface SessionTrack {
  todos: TodoEntry[] | null;
  todosAt: string | null;
  todoVersion: number;
  nextTaskId: number;
  createdByToolUse: Map<string, TodoEntry>; // TaskCreate tool_use id → entry (to adopt "Task #N" ids)
  appliedTaskOps: Set<string>; // tool_use ids already applied (cold scan + live lines may overlap)
  pending: Map<string, PendingTool>;
  lastLineMs: number;
  writes: Map<string, number>; // abs path → ms of latest write
}

function newTrack(): SessionTrack {
  return {
    todos: null,
    todosAt: null,
    todoVersion: 0,
    nextTaskId: 1,
    createdByToolUse: new Map(),
    appliedTaskOps: new Set(),
    pending: new Map(),
    lastLineMs: 0,
    writes: new Map(),
  };
}

/** Collapse whitespace, strip control chars, redact secrets, cap length. */
export function cleanText(raw: unknown, max = 120): string {
  if (typeof raw !== "string") return "";
  let t = redactSecrets(raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim());
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

function todoStatus(v: unknown): TodoStatus | null {
  return v === "pending" || v === "in_progress" || v === "completed" ? v : null;
}

const TIMESTAMP_RE = /"timestamp":"([^"]{10,40})"/;

export class FleetTracker {
  readonly sessions = new Map<string, SessionTrack>();
  private readonly seenBatches = new WeakSet<object>();
  private coldScan: Promise<void> | null = null;
  private readonly scannedSessions = new Set<string>();

  track(sessionId: string): SessionTrack {
    let t = this.sessions.get(sessionId);
    if (!t) {
      t = newTrack();
      this.sessions.set(sessionId, t);
    }
    return t;
  }

  /** Feeds one indexer batch. Every feature calls this; a batch is applied once. */
  ingestBatch(batch: ReadonlyMap<string, readonly string[]>): void {
    if (this.seenBatches.has(batch)) return;
    this.seenBatches.add(batch);
    for (const [sessionId, lines] of batch) for (const line of lines) this.ingestLine(sessionId, line);
  }

  ingestLine(sessionId: string, raw: string, nowMs = Date.now()): void {
    const hasTool = raw.includes('"tool_use"') || raw.includes('"tool_result"');
    const t = this.track(sessionId);
    if (!hasTool) {
      // Lines without a timestamp (snapshots, summaries) say nothing about activity.
      const m = TIMESTAMP_RE.exec(raw);
      const ms = m?.[1] ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(ms)) t.lastLineMs = Math.max(t.lastLineMs, ms);
      // A fresh human prompt means any earlier unanswered tool call was abandoned.
      if (raw.includes('"type":"user"') && !raw.includes('"isMeta":true')) t.pending.clear();
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(obj)) return;
    const tsMs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    const atMs = Number.isFinite(tsMs) ? tsMs : nowMs;
    const atIso = new Date(atMs).toISOString();
    if (Number.isFinite(tsMs)) t.lastLineMs = Math.max(t.lastLineMs, tsMs);
    const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
    const message = isRecord(obj.message) ? obj.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        const id = typeof block.id === "string" ? block.id : null;
        const input = isRecord(block.input) ? block.input : {};
        if (id) t.pending.set(id, { name: block.name, atMs });
        this.applyToolUse(t, block.name, input, id, atIso, atMs, cwd);
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        t.pending.delete(block.tool_use_id);
        this.adoptTaskNumber(t, block.tool_use_id, block.content);
      }
    }
    for (const [id, p] of t.pending) if (nowMs - p.atMs > PENDING_MAX_AGE_MS) t.pending.delete(id);
  }

  private setTodos(t: SessionTrack, entries: TodoEntry[], atIso: string): void {
    t.todos = entries.slice(0, MAX_TODO_ITEMS);
    t.todosAt = atIso;
    t.todoVersion += 1;
  }

  private applyToolUse(
    t: SessionTrack,
    name: string,
    input: Record<string, unknown>,
    toolUseId: string | null,
    atIso: string,
    atMs: number,
    cwd: string | null,
  ): void {
    if (WRITE_TOOLS.has(name)) {
      const p = input.file_path ?? input.notebook_path;
      if (typeof p === "string" && p.length > 0 && p.length < 4096) {
        const abs = isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null;
        if (abs) t.writes.set(abs, Math.max(t.writes.get(abs) ?? 0, atMs));
      }
      return;
    }
    if (name === "TodoWrite") {
      if (!Array.isArray(input.todos)) return;
      const entries: TodoEntry[] = [];
      for (const raw of input.todos) {
        if (!isRecord(raw)) continue;
        const status = todoStatus(raw.status);
        const content = cleanText(raw.content);
        if (!status || !content) continue;
        const activeForm = cleanText(raw.activeForm) || null;
        entries.push({ taskId: null, item: { content, status, activeForm } });
      }
      this.setTodos(t, entries, atIso);
      return;
    }
    if (name !== "TaskCreate" && name !== "TaskUpdate") return;
    if (toolUseId) {
      if (t.appliedTaskOps.has(toolUseId)) return;
      t.appliedTaskOps.add(toolUseId);
    }
    // Task-style items replace a TodoWrite-style list rather than mixing with it.
    const base = (t.todos ?? []).filter((e) => e.taskId !== null);
    if (name === "TaskCreate") {
      const content = cleanText(input.subject ?? input.content ?? input.description);
      if (!content) return;
      const entry: TodoEntry = {
        taskId: String(t.nextTaskId++),
        item: { content, status: "pending", activeForm: cleanText(input.activeForm) || null },
      };
      if (toolUseId) t.createdByToolUse.set(toolUseId, entry);
      this.setTodos(t, [...base, entry], atIso);
      return;
    }
    const taskId = typeof input.taskId === "string" || typeof input.taskId === "number" ? String(input.taskId) : null;
    if (!taskId) return;
    const idx = base.findIndex((e) => e.taskId === taskId);
    if (idx === -1) return;
    const cur = base[idx];
    if (!cur) return;
    if (input.status === "deleted") {
      this.setTodos(t, base.filter((_, i) => i !== idx), atIso);
      return;
    }
    const next: TodoEntry = {
      taskId,
      item: {
        content: cleanText(input.subject) || cur.item.content,
        status: todoStatus(input.status) ?? cur.item.status,
        activeForm: cleanText(input.activeForm) || cur.item.activeForm,
      },
    };
    this.setTodos(t, base.map((e, i) => (i === idx ? next : e)), atIso);
  }

  /** "Task #7 created successfully: …" → give the entry the real id. */
  private adoptTaskNumber(t: SessionTrack, toolUseId: string, content: unknown): void {
    const entry = t.createdByToolUse.get(toolUseId);
    if (!entry) return;
    t.createdByToolUse.delete(toolUseId);
    const text = typeof content === "string" ? content : Array.isArray(content) ? JSON.stringify(content) : "";
    const m = /Task #(\d+) created/.exec(text);
    if (!m?.[1]) return;
    entry.taskId = m[1];
    t.nextTaskId = Math.max(t.nextTaskId, Number(m[1]) + 1);
  }

  todoList(sessionId: string): TodoList | null {
    const t = this.sessions.get(sessionId);
    if (!t?.todos || !t.todosAt) return null;
    return { agentId: sessionId, items: t.todos.map((e) => ({ ...e.item })), updatedAt: t.todosAt };
  }

  allTodoLists(): TodoList[] {
    const out: TodoList[] = [];
    for (const id of this.sessions.keys()) {
      const l = this.todoList(id);
      if (l) out.push(l);
    }
    return out;
  }

  /** Session → (abs path → latest write ms), writes inside the window only. */
  recentWrites(nowMs: number, windowMs = WRITE_WINDOW_MS): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const [id, t] of this.sessions) {
      for (const [p, at] of t.writes) if (nowMs - at > windowMs) t.writes.delete(p);
      if (t.writes.size > 0) out.set(id, new Map(t.writes));
    }
    return out;
  }

  /** Rebuilds state from sessions written in the last few hours. Runs once per tracker. */
  ensureColdScan(projectsDir: string, nowMs = Date.now(), windowMs = COLD_SCAN_WINDOW_MS): Promise<void> {
    if (!this.coldScan) this.coldScan = this.runColdScan(projectsDir, nowMs, windowMs);
    return this.coldScan;
  }

  /** Reads one session's whole file on demand (the agent panel asks for an old agent's list). Once per session. */
  async scanSession(projectsDir: string, sessionId: string): Promise<void> {
    if (this.scannedSessions.has(sessionId)) return;
    this.scannedSessions.add(sessionId);
    let dirs: string[] = [];
    try {
      dirs = await readdir(projectsDir);
    } catch {
      return;
    }
    for (const d of dirs) {
      const p = join(projectsDir, d, `${sessionId}.jsonl`);
      try {
        await stat(p);
      } catch {
        continue;
      }
      await this.ingestFile(p, sessionId, Date.now());
      return;
    }
  }

  private async ingestFile(path: string, sessionId: string, nowMs: number): Promise<void> {
    try {
      const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) this.ingestLine(sessionId, line, nowMs);
    } catch {
      // unreadable file: skip, it only costs us this session's signals
    }
  }

  private async runColdScan(projectsDir: string, nowMs: number, windowMs: number): Promise<void> {
    const files: { path: string; mtimeMs: number }[] = [];
    let dirs: string[] = [];
    try {
      dirs = await readdir(projectsDir);
    } catch {
      return;
    }
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = await readdir(join(projectsDir, d));
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const p = join(projectsDir, d, n);
        try {
          const st = await stat(p);
          if (nowMs - st.mtimeMs <= windowMs) files.push({ path: p, mtimeMs: st.mtimeMs });
        } catch {
          // deleted mid-scan
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of files.slice(0, COLD_SCAN_MAX_FILES)) {
      const sessionId = basename(f.path, ".jsonl");
      this.scannedSessions.add(sessionId);
      await this.ingestFile(f.path, sessionId, nowMs);
    }
  }
}

/** The process-wide tracker used by the enabled features. Tests build their own. */
export const fleetTracker = new FleetTracker();

// ── one shared, briefly cached world view (detectLive = ps + lsof, keep it rare) ──

let viewCache: { at: number; agents: WorldAgent[] } | null = null;

export function cachedAgents(ctx: FeatureContext, maxAgeMs = 4000, nowMs = Date.now()): WorldAgent[] {
  if (viewCache && nowMs - viewCache.at < maxAgeMs) return viewCache.agents;
  const agents = ctx.worldViews().agents;
  viewCache = { at: nowMs, agents };
  return agents;
}
