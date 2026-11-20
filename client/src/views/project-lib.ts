// Pure logic for the 📌 Project page (project.ts) and Home's "Pick up where you left off" cards:
// the words each fact is shown with, and what the one Resume button may do. DOM-free, so it is
// unit-tested (project-lib.test.ts). Data: GET /api/project-page/* (shared/features/project-page.ts).

import type { ProjectCardsResponse, ProjectPage, ProjectPageVerdict } from "../../../shared/features/project-page";
import { outcomeChip } from "../features/outcomes";
import { ago, costLabel } from "./projects-lib";

export const PROJECT_VIEW_ID = "project";
/** Home's "Pick up where you left off" shows this many projects. */
export const PICKUP_CARDS = 4;

/** A /api/project-page/recent answer, checked before Home draws it (each card's lists too). */
export function isProjectCardsResponse(v: unknown): v is ProjectCardsResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { ok?: unknown; cards?: unknown };
  return (
    r.ok === true &&
    Array.isArray(r.cards) &&
    r.cards.every((c: unknown) => {
      if (typeof c !== "object" || c === null) return false;
      const p = c as Partial<Record<keyof ProjectPage, unknown>>;
      const todos = p.todos as { open?: unknown } | null | undefined;
      return typeof p.key === "string" && typeof p.name === "string" && Array.isArray(p.sessions) && Array.isArray(p.verdicts) && typeof todos?.open === "number" && typeof p.sessionsTotal === "number";
    })
  );
}

/** The Brain route that opens a vault note in its reader (never straight to Obsidian). */
export function brainNoteRoute(path: string): { view: "brain"; param: string } {
  return { view: "brain", param: path };
}

/** "🎓 shipped · o/alpha#3 merged". */
export function verdictText(v: Pick<ProjectPageVerdict, "outcome" | "reason">): string {
  const chip = outcomeChip(v.outcome);
  const head = chip ? `${chip.emoji} ${chip.label}` : v.outcome;
  return v.reason ? `${head} · ${v.reason}` : head;
}

export const plural = (n: number, word: string): string => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** What one card (or the page's header strip) says, each fact null when there is nothing to say. */
export interface CardFacts {
  /** "2 live · 14 sessions", or "no sessions yet". */
  sessions: string;
  /** The newest verdict. */
  verdict: string | null;
  /** "3 open todos"; null when none. */
  todos: string | null;
  /** "$12 in 30 days"; null when unknown or nothing spent. */
  spend: string | null;
  /** "last session today". */
  last: string | null;
}

export function cardFacts(p: ProjectPage, nowMs: number): CardFacts {
  const total = plural(p.sessionsTotal, "session");
  const spend = costLabel(p.spendUsd30d);
  const newest = p.sessions.reduce<string | null>((m, s) => (m && m > s.lastActive ? m : s.lastActive), null);
  return {
    sessions: p.sessionsTotal === 0 ? "no sessions yet" : p.live > 0 ? `${p.live} live · ${total}` : total,
    verdict: p.verdicts[0] ? verdictText(p.verdicts[0]) : null,
    todos: p.todos.open > 0 ? plural(p.todos.open, "open todo") : null,
    spend: spend ? `${spend} in 30 days` : null,
    last: newest ? `last session ${ago(newest, nowMs)}` : null,
  };
}

/** What the Resume button does: a dormant session is resumed (claude --resume, through the
 *  Reactivate path every other surface uses, which refuses a live one); a live one is opened in
 *  its Room instead, since resuming it would start a second copy. */
export type ResumeOffer = { kind: "resume" | "open"; sessionId: string; label: string; title: string } | null;

export function resumeOffer(p: Pick<ProjectPage, "resume">): ResumeOffer {
  const r = p.resume;
  if (!r) return null;
  return r.status === "live"
    ? { kind: "open", sessionId: r.sessionId, label: "Open live session", title: `Running now: open "${r.title}" in its Room` }
    : { kind: "resume", sessionId: r.sessionId, label: "Resume", title: `claude --resume "${r.title}" in Terminal` };
}

/** "matched by its code_path", for the vault line's tooltip. */
export function matchWords(by: NonNullable<ProjectPage["vault"]>["matchedBy"]): string {
  switch (by) {
    case "code_path":
      return "matched by the note's code_path";
    case "github":
      return "matched by the note's github repo";
    case "alias":
      return "matched by a brain_taxonomy alias";
    case "name":
      return "matched by the folder name";
    default:
      return "opened by its vault slug";
  }
}

/** ?redact=1: the page with every name and free text swapped out (counts, dates, verdict kinds and
 *  the layout stay real). `n` numbers the project like the Library does ("project 3"). */
export function redactPage(p: ProjectPage, n: number): ProjectPage {
  const hidden = (id: string): string => `session ${id.slice(0, 4)}`;
  return {
    ...p,
    name: `project ${n}`,
    cities: p.cities.map((c, i) => ({ id: c.id, name: `district ${i + 1}` })),
    desc: null,
    liveUrl: null,
    path: null,
    git: p.git ? { ...p.git, remote: null, branch: null } : null,
    sessions: p.sessions.map((s) => ({ ...s, title: hidden(s.id) })),
    todos: { open: p.todos.open, items: p.todos.items.map((t) => ({ ...t, content: "a todo" })) },
    verdicts: p.verdicts.map((v) => ({ ...v, title: hidden(v.sessionId), reason: null })),
    vault: p.vault ? { ...p.vault, slug: "vault note", title: null, summary: null, umbrella: null } : null,
    resume: p.resume ? { ...p.resume, title: hidden(p.resume.sessionId) } : null,
  };
}
