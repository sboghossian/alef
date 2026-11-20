// Pure logic for the 💻 Code view: the explorer tree (build + filter), quick-open ranking,
// unified-diff parsing (unified + side-by-side rows), and "problems" from real activity.
// DOM-free; tested in code-lib.test.ts. Wire types: shared/features/code.ts (B).

import type { CodeStatusFile, CodeTouchedFile, CodeTreeEntry } from "../../../shared/features/code";
import type { AgentActivity } from "../../../shared/types";
import { fuzzyRank } from "../ui/fuzzy";
import { extOf } from "./code-tokenize";

// ---------------------------------------------------------------- tree

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  blocked: boolean;
  children: TreeNode[];
  /** Files under this node (itself for a file) that the session touched. */
  touched: number;
}

export interface TreeFilter {
  touchedOnly: boolean;
  /** Extensions to keep ("" = no extension); empty = all. */
  exts: readonly string[];
}

/** Builds a sorted nested tree (dirs first, then names) from B's flat entry list. */
export function buildTree(entries: readonly CodeTreeEntry[], touched: ReadonlySet<string>, filter: TreeFilter): TreeNode {
  const root: TreeNode = { name: "", path: "", dir: true, blocked: false, children: [], touched: 0 };
  const dirs = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (path: string): TreeNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : path.slice(0, cut));
    const node: TreeNode = { name: path.slice(cut + 1), path, dir: true, blocked: false, children: [], touched: 0 };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  const keepExt = new Set(filter.exts);
  for (const e of entries) {
    if (!e.path) continue;
    if (e.type === "dir") {
      if (!filter.touchedOnly && keepExt.size === 0) ensureDir(e.path);
      continue;
    }
    const isTouched = touched.has(e.path);
    if (filter.touchedOnly && !isTouched) continue;
    if (keepExt.size && !keepExt.has(extOf(e.path))) continue;
    const cut = e.path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : e.path.slice(0, cut));
    parent.children.push({ name: e.path.slice(cut + 1), path: e.path, dir: false, blocked: e.blocked === true, children: [], touched: isTouched ? 1 : 0 });
  }
  const finish = (n: TreeNode): number => {
    if (!n.dir) return n.touched;
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.touched = n.children.reduce((s, c) => s + finish(c), 0);
    return n.touched;
  };
  finish(root);
  return root;
}

/** Touched files inside the repo become tree entries too (a file may be missing from a truncated tree). */
export function mergeTouchedEntries(entries: readonly CodeTreeEntry[], touched: readonly CodeTouchedFile[]): CodeTreeEntry[] {
  const have = new Set(entries.map((e) => e.path));
  const extra: CodeTreeEntry[] = [];
  for (const t of touched) if (t.insideRepo && !have.has(t.path)) {
    have.add(t.path);
    extra.push({ path: t.path, type: "file" });
  }
  return extra.length ? [...entries, ...extra] : entries.slice();
}

/** Extension → count over files (for the file-type filter), most common first. */
export function extCounts(entries: readonly CodeTreeEntry[]): Array<{ ext: string; count: number }> {
  const m = new Map<string, number>();
  for (const e of entries) if (e.type !== "dir") m.set(extOf(e.path), (m.get(extOf(e.path)) ?? 0) + 1);
  return [...m.entries()].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

/** Directories to open so `path` is visible. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

// ---------------------------------------------------------------- quick open (⌘P)

export interface QuickItem {
  path: string;
  touched: boolean;
}

/** Fuzzy file finder: basename hits beat directory hits; touched files get a nudge. Empty query = touched first. */
export function quickOpen(query: string, files: readonly QuickItem[], limit = 40): QuickItem[] {
  const q = query.trim();
  if (!q) return [...files].sort((a, b) => Number(b.touched) - Number(a.touched) || a.path.localeCompare(b.path)).slice(0, limit);
  const ranked = fuzzyRank(q, [...files], (f) => [f.path.split("/").pop() ?? f.path, f.path], limit * 3);
  return ranked
    .map((r) => {
      const base = r.item.path.split("/").pop() ?? "";
      const baseHit = base.toLowerCase().includes(q.toLowerCase()) ? 300 : 0;
      return { item: r.item, score: r.score + baseHit + (r.item.touched ? 50 : 0) - r.item.path.length * 0.1 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

// ---------------------------------------------------------------- diff

export type DiffKind = "ctx" | "add" | "del" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Parses `git diff` unified output. File headers become "meta", @@ lines "hunk". */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk || /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary files)/.test(raw)) {
      if (raw) out.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
      if (raw.startsWith("diff --git")) inHunk = false;
      continue;
    }
    const c = raw[0];
    if (c === "+") out.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    else if (c === "-") out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    else if (c === "\\") out.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    else if (c === " ") out.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return out;
}

export interface SideRow {
  left: DiffLine | null;
  right: DiffLine | null;
  /** hunk / meta rows span both sides. */
  span?: DiffLine;
}

/** Pairs deletions with the additions that follow them, like a side-by-side diff. */
export function sideBySide(lines: readonly DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.kind === "add") adds.push(l);
    else {
      flush();
      if (l.kind === "ctx") rows.push({ left: l, right: l });
      else rows.push({ left: null, right: null, span: l });
    }
  }
  flush();
  return rows;
}

export function diffStats(lines: readonly DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

// ---------------------------------------------------------------- status + problems

/** Porcelain XY → a one-letter badge (M, A, D, R, U, ?). */
export function statusBadge(xy: string): string {
  if (xy === "??") return "U";
  const c = (xy.trim()[0] ?? "").toUpperCase();
  return c === "?" ? "U" : c || "M";
}

export function statusMap(dirty: readonly CodeStatusFile[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of dirty) {
    // Renames arrive as "old -> new".
    const path = d.path.includes(" -> ") ? (d.path.split(" -> ")[1] ?? d.path) : d.path;
    m.set(path, statusBadge(d.status));
  }
  return m;
}

const ERROR_RE = /\b(error|failed|failure|exception|traceback|denied|refused|not found|exit code [1-9]\d*|exited with code [1-9]|ENOENT|EACCES|timed? ?out)\b|✗|❌/i;

/** Recent tool lines of this agent that read like errors (activity carries no error flag, so this is a text match). */
export function problemsFrom(activities: readonly AgentActivity[], agentId: string, limit = 30): AgentActivity[] {
  return activities
    .filter((a) => a.agentId === agentId && a.stage === "tool" && ERROR_RE.test(a.summary))
    .slice(-limit)
    .reverse();
}

/** "Edit ×3 · 4m ago" style label for a touched file. */
export function touchedLabel(t: CodeTouchedFile): string {
  const parts = [`${t.lastTool}`];
  if (t.count > 1) parts.push(`×${t.count}`);
  if (t.edits > 0) parts.push(`${t.edits} edit${t.edits === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
