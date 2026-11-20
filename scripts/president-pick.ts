// Jev, as president, picks what the self-improvement loop builds next. GET-only against a running
// Alef: it reads the president's board (GET /api/president/proposals), keeps the proposals for
// Alef's own district (failing Health checks, draft tripwire rules), adds the loop's open backlog
// items (~/.alef-loop/backlog.md, read-only), and asks Jev ONE Choice question through the
// president's own buildJevBody / rankByJevProbabilities, "none" always an option. It prints the
// pick and p(none). The loop writes "President pick: <id>" in the PR body of the PR that builds it.
//
//   npx tsx scripts/president-pick.ts [--base http://127.0.0.1:5179] [--backlog ~/.alef-loop/backlog.md] [--json]
//
// Exit: 0 = a pick, 3 = Jev picked none of them, 2 = no Jev answer (no TYPESAFE_API_KEY, the call
// failed) or an unreadable backlog: nothing is picked, and no rules ranking stands in for Jev. An
// unreachable board is not fatal: Jev ranks the backlog alone and the output says the board was missing.
//
// INVARIANTS: the loop runs this explicitly, Alef never schedules it; it writes nothing (one GET
// and one TypeSafe call); backlog and board text reach Jev only fenced (buildJevBody), and a
// candidate whose text names always-live work is dropped before Jev sees it (the president's rule).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPresidentBoard, type PresidentBoard } from "../shared/features/president.js";
import { callJev, isChoiceAnswer, TIMEOUT_MS, type FetchLike } from "../server/director.js";
import { log } from "../server/log.js";
import {
  alwaysLiveTextReason,
  buildJevBody,
  probabilitiesById,
  rankByJevProbabilities,
  uniqueById,
  type SessionCandidate,
} from "../server/features/president-lib.js";
import { argValue, hasFlag, isMainModule, out } from "./script-args.js";

/** Alef's own district name on the board (president.ts's REPO_CITY). */
export const ALEF_CITY = "agent-world";
const BOARD_TIMEOUT_MS = 60_000;

export interface BacklogItem {
  id: string;
  text: string;
  done: boolean;
}

const ITEM_RE = /^(\d{1,3}[a-z]?)\.\s+(\S.*)$/;

/** The backlog's numbered items ("19. (from #28 reviews) subagents/fold.ts: …"); an item whose
 *  text starts with ✅ is done. Anything else in the file (headings, prose) is not an item. */
export function parseBacklog(md: string): BacklogItem[] {
  const items: BacklogItem[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = ITEM_RE.exec(line.trim());
    if (m?.[1] && m[2]) items.push({ id: m[1], text: m[2].trim(), done: m[2].trim().startsWith("✅") });
  }
  return items;
}

export interface LoopCandidates {
  candidates: SessionCandidate[];
  /** Dropped before Jev: always-live text (the president never proposes that work). */
  dropped: { id: string; reason: string }[];
  /** Board proposals left out because they are not Alef's own work (another district, or not a session). */
  skippedBoard: number;
  /** Candidates that reached Jev, by source. */
  fromBoard: number;
  fromBacklog: number;
}

/** The candidates Jev ranks: the board's session proposals for Alef's own district (in board
 *  order, which is already Jev's), then the backlog's open items in their ranked order. Ids are
 *  "board:<proposal id>" and "backlog-<item id>". Every word is the record's own; Jev sees it fenced. */
export function loopCandidates(board: PresidentBoard | null, backlog: readonly BacklogItem[]): LoopCandidates {
  const all: SessionCandidate[] = [];
  let skippedBoard = 0;
  const proposals = board?.proposals ?? [];
  proposals.forEach((p, i) => {
    if (p.kind !== "session" || p.city !== ALEF_CITY) {
      skippedBoard += 1;
      return;
    }
    all.push({ id: `board:${p.id}`, task: p.task, city: p.city, model: p.model, why: p.why, priority: 1000 - i, launchCwd: null, origin: p.origin ?? "health" });
  });
  const open = backlog.filter((b) => !b.done);
  open.forEach((b, i) => {
    all.push({
      id: `backlog-${b.id}`,
      task: b.text,
      city: ALEF_CITY,
      model: "", // the loop picks the builder's model, not this script
      why: `open item ${b.id} of the self-improvement loop's ranked backlog (${i + 1} of ${open.length} open)`,
      priority: open.length - i,
      launchCwd: null,
      origin: "loop",
    });
  });
  const candidates: SessionCandidate[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const c of uniqueById(all)) {
    const reason = alwaysLiveTextReason(`${c.task}\n${c.why}`);
    if (reason) dropped.push({ id: c.id, reason });
    else candidates.push(c);
  }
  const fromBoard = candidates.filter((c) => c.id.startsWith("board:")).length;
  return { candidates, dropped, skippedBoard, fromBoard, fromBacklog: candidates.length - fromBoard };
}

export type PickOutcome =
  | { ok: true; pick: SessionCandidate | null; pPick: number | null; pNone: number; ranked: { id: string; p: number }[]; all: { id: string; p: number }[] }
  | { ok: false; error: string };

/** One Jev Choice question over the candidates (the president's own body builder), ranked by the
 *  president's own rule: only candidates at or above p(none) survive, best first. */
export async function askJevForPick(
  candidates: readonly SessionCandidate[],
  opts: { apiKey: string | undefined; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<PickOutcome> {
  if (!opts.apiKey) return { ok: false, error: "no TYPESAFE_API_KEY: Jev can't be asked, so nothing is picked" };
  if (candidates.length === 0) return { ok: false, error: "no candidates: the board has no Alef proposal and the backlog has no open item" };
  const { body, idOfKey } = buildJevBody(candidates, null);
  let raw: unknown;
  try {
    raw = await callJev(opts.apiKey, body, opts.fetchImpl ?? (globalThis.fetch as FetchLike), opts.timeoutMs ?? TIMEOUT_MS);
  } catch (err) {
    return { ok: false, error: `Jev call failed: ${String(err)}` };
  }
  const answers = typeof raw === "object" && raw !== null ? (raw as { answers?: unknown }).answers : undefined;
  const sessions = typeof answers === "object" && answers !== null ? (answers as { sessions?: unknown }).sessions : undefined;
  if (!isChoiceAnswer(sessions)) return { ok: false, error: "Jev's answer had no usable choice" };
  const probs = probabilitiesById(sessions.probabilities, idOfKey);
  if (typeof probs.none !== "number") return { ok: false, error: "Jev's answer had no p(none)" };
  const ranked = rankByJevProbabilities(candidates, probs);
  const pick = ranked[0] ?? null;
  const scored = (c: SessionCandidate): { id: string; p: number } => ({ id: c.id, p: probs[c.id] ?? 0 });
  // `all`: every candidate's probability, best first, so a "none" answer still shows how close each came.
  const all = candidates.map(scored).sort((a, b) => b.p - a.p);
  return { ok: true, pick, pPick: pick ? (probs[pick.id] ?? null) : null, pNone: probs.none, ranked: ranked.map(scored), all };
}

async function getBoard(base: string): Promise<PresidentBoard> {
  const res = await fetch(`${base}/api/president/proposals`, { signal: AbortSignal.timeout(BOARD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /api/president/proposals: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isPresidentBoard(body)) throw new Error("GET /api/president/proposals: not a president board");
  return body;
}

const pct = (p: number): string => `${(p * 100).toFixed(0)}%`;

async function main(argv: readonly string[]): Promise<number> {
  const base = argValue(argv, "--base") ?? "http://127.0.0.1:5179";
  const backlogPath = argValue(argv, "--backlog") ?? join(homedir(), ".alef-loop", "backlog.md");
  let backlog: BacklogItem[];
  try {
    backlog = parseBacklog(await readFile(backlogPath, "utf8"));
  } catch (err) {
    log.error("president-pick", `could not read the backlog ${backlogPath}`, String(err));
    return 2;
  }
  // The board is the president's own view; without it Jev still ranks the backlog, and says so.
  let board: PresidentBoard | null = null;
  let boardError: string | null = null;
  try {
    board = await getBoard(base);
  } catch (err) {
    boardError = String(err);
    log.warn("president-pick", "board unavailable, ranking the backlog alone", boardError);
  }
  const { candidates, dropped, skippedBoard, fromBoard, fromBacklog } = loopCandidates(board, backlog);
  for (const d of dropped) log.info("president-pick", `dropped ${d.id}: ${d.reason}`);
  const outcome = await askJevForPick(candidates, { apiKey: process.env.TYPESAFE_API_KEY });
  if (hasFlag(argv, "--json")) {
    const boardInfo = board ? { generatedAt: board.generatedAt, source: board.source, skipped: skippedBoard } : { error: boardError };
    out(`${JSON.stringify({ board: boardInfo, fromBoard, fromBacklog, dropped, outcome })}\n`);
  } else if (!outcome.ok) {
    out(`No pick: ${outcome.error}\n`);
  } else {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const boardLine = board ? `${fromBoard} from the board (${board.generatedAt}, ranked by ${board.source}; ${skippedBoard} for other districts skipped)` : `0 from the board (unavailable: ${boardError})`;
    const lines = [
      `Candidates: ${boardLine} + ${fromBacklog} open backlog items · ${dropped.length} dropped (always-live text)`,
      outcome.pick ? `President pick: ${outcome.pick.id} (p ${pct(outcome.pPick ?? 0)}) · p(none) ${pct(outcome.pNone)}` : `President pick: none (p(none) ${pct(outcome.pNone)} beats every candidate)`,
      outcome.pick ? "Ranked at or above p(none):" : "Closest (all under p(none)):",
      ...(outcome.pick ? outcome.ranked : outcome.all).slice(0, 5).map((r, i) => `  ${i + 1}. ${r.id} ${pct(r.p)}  ${(byId.get(r.id)?.task ?? "").slice(0, 110)}`),
    ];
    out(`${lines.join("\n")}\n`);
  }
  if (!outcome.ok) return 2;
  return outcome.pick ? 0 : 3;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
