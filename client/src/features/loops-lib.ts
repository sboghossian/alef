// Pure logic for the Loops tab: parsing the wire board, filtering, grouping by lens, the
// "confirm click" state machine for ▶ Launch, and the one launch-result message both ▶ Launch
// and Inbox › Jev proposes › Launch show. No DOM here (see loops.ts), so this is testable
// without jsdom.

import { LOOPS_LENS_ORDER, type LoopsBoard, type LoopsItem, type LoopsLens, type LoopsSourceKind } from "../../../shared/features/loops";
import { isFolderTrust } from "../../../shared/features/trust";
import { folderName, launchNeedsYou, launchSuccessText, type LaunchResultLike } from "../ui/launch-result";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const KNOWN_LENSES = new Set<string>(LOOPS_LENS_ORDER);
const KNOWN_SOURCES = new Set<string>(["whatsup", "scan"]);

function parseItem(v: unknown): LoopsItem | null {
  if (!isRecord(v)) return null;
  const { id, task, project, lens, score, sources, sourceType, updatedAt, openPath, launchCwd } = v;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof task !== "string" || typeof project !== "string") return null;
  if (typeof lens !== "string" || !KNOWN_LENSES.has(lens)) return null;
  if (!Array.isArray(sources)) return null;
  const cleanSources = sources.filter((s): s is LoopsSourceKind => typeof s === "string" && KNOWN_SOURCES.has(s));
  return {
    id,
    task,
    project,
    lens: lens as LoopsLens,
    score: typeof score === "number" && Number.isFinite(score) ? score : 0,
    sources: cleanSources,
    sourceType: typeof sourceType === "string" ? sourceType : "unknown",
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
    openPath: typeof openPath === "string" ? openPath : null,
    launchCwd: typeof launchCwd === "string" ? launchCwd : null,
  };
}

/** Validates a `LoopsBoard` off the wire (WS payload or WorldSnapshot.extras). Never throws. */
export function parseLoopsBoard(v: unknown): LoopsBoard | null {
  if (!isRecord(v) || !Array.isArray(v.items)) return null;
  if (typeof v.generatedAt !== "string" || typeof v.badge !== "number" || typeof v.whatsupOk !== "boolean") return null;
  const items: LoopsItem[] = [];
  for (const raw of v.items) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }
  return {
    generatedAt: v.generatedAt,
    items,
    badge: v.badge,
    whatsupOk: v.whatsupOk,
    whatsupError: typeof v.whatsupError === "string" ? v.whatsupError : null,
  };
}

/** Case-insensitive substring match over project + task. Empty query keeps everything. */
export function filterLoopsItems(items: readonly LoopsItem[], query: string): LoopsItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((i) => i.task.toLowerCase().includes(q) || i.project.toLowerCase().includes(q));
}

/** Groups (already-filtered) items by lens in board order; ranked lenses sort by score desc,
 *  "unranked" (no whatsup rank) sorts by recency. Always returns every lens key, empty or not. */
export function groupLoopsByLens(items: readonly LoopsItem[]): Map<LoopsLens, LoopsItem[]> {
  const groups = new Map<LoopsLens, LoopsItem[]>();
  for (const lens of LOOPS_LENS_ORDER) groups.set(lens, []);
  for (const item of items) groups.get(item.lens)?.push(item);
  for (const [lens, list] of groups) {
    if (lens === "unranked") list.sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
    else list.sort((a, b) => b.score - a.score || a.task.localeCompare(b.task));
  }
  return groups;
}

/** The board's items in one flat, deterministic order (lens order, then each lens's own rank) —
 *  the single selector both the Loops tab and the "Open loops" quick prompt read from, so they
 *  can never disagree on which items are open loops. */
export function orderedLoopsItems(board: LoopsBoard | null): LoopsItem[] {
  if (!board) return [];
  const groups = groupLoopsByLens(board.items);
  return LOOPS_LENS_ORDER.flatMap((lens) => groups.get(lens) ?? []);
}

/** "whatsup", "scan", or "whatsup + scan" for the row's source badge. */
export function loopsSourceLabel(sources: readonly LoopsSourceKind[]): string {
  const hasWhatsup = sources.includes("whatsup");
  const hasScan = sources.includes("scan");
  if (hasWhatsup && hasScan) return "whatsup + scan";
  return hasWhatsup ? "whatsup" : "scan";
}

export const LOOPS_CONFIRM_WINDOW_MS = 4000;

/** ▶ Launch requires a confirm click: the first click on an id arms it (fire: false); a second
 *  click on the SAME id within `windowMs` fires it (fire: true) and clears it. Any entry older
 *  than `windowMs` is pruned on every step, so a stale arm can't be fired by a later click. */
export function stepLaunchConfirm(
  pending: ReadonlyMap<string, number>,
  id: string,
  now: number,
  windowMs = LOOPS_CONFIRM_WINDOW_MS,
): { fire: boolean; pending: Map<string, number> } {
  const next = new Map([...pending].filter(([, at]) => now - at < windowMs));
  if (next.has(id)) {
    next.delete(id);
    return { fire: true, pending: next };
  }
  next.set(id, now);
  return { fire: false, pending: next };
}

/** What a launch route answered (LoopsActionResult / PresidentActionResult share this shape). */
export interface LaunchOutcome extends LaunchResultLike {
  error?: string;
  trust?: unknown;
}

/** Keeps a long server error short enough that the hint after it still fits in a toast. */
const MAX_REASON_CHARS = 200;

/** The part of a server error a person can act on. String(err) of a failed exec is "Error:
 *  Command failed: <the whole command line>\n<stderr>"; the stderr is the reason, the command
 *  line (hundreds of characters of paths and AppleScript) is noise. */
export function launchFailureReason(raw: string): string {
  const exec = /^Error: Command failed: (\S+)[^\n]*\n([\s\S]*\S)\s*$/.exec(raw);
  const reason = exec ? `${exec[1]?.split("/").pop() ?? ""}: ${exec[2]?.trim() ?? ""}` : raw;
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}


/** The toast for a launch result, from the server's answer. Never says "Launched": the server only
 *  knows tmux started, Terminal was asked to attach, and what the pane showed in its first seconds.
 *  claude's trust dialog (No, exit preselected) runs nothing until answered (seen 2026-09-28), so a
 *  launch waiting on it, or into a folder Claude hasn't trusted, is error-styled to stay up. */
export function launchToast(r: LaunchOutcome): { text: string; kind: "info" | "error" } {
  if (!r.ok) {
    const raw = r.error ?? "unknown error";
    // A tmux session may already run even when the answer is a failure (e.g. a timed-out request).
    const hint = /osascript/i.test(raw) ? " The session may still have started: check Inbox › Started from Alef but never began." : "";
    return { text: `Couldn't launch: ${launchFailureReason(raw)}${hint}`, kind: "error" };
  }
  const text = launchSuccessText(r, "Started (plan mode)");
  const trust = isFolderTrust(r.trust) ? r.trust : "unknown";
  if (r.waitingOn || r.reused) return { text, kind: launchNeedsYou(r) ? "error" : "info" };
  if (trust === "untrusted") {
    return { text: `${text} Claude hasn't trusted ${folderName(r.cwd)} yet: if it asks, pick Yes, I trust this folder in Terminal, or nothing will run.`, kind: "error" };
  }
  if (trust === "trusted") return { text, kind: launchNeedsYou(r) ? "error" : "info" };
  return { text: `${text} If Claude asks whether you trust the folder, answer it there.`, kind: launchNeedsYou(r) ? "error" : "info" };
}
