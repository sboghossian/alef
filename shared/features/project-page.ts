// Wire types for the "project-page" feature (UX-3): ONE page per project, joining what Alef
// otherwise shows in three places: the World's city (district) with its sessions, the Library's
// /api/projects entry (stage, git, notes) and the vault's 20-Projects/<slug>/_index.md.
//
//   GET /api/project-page               → ProjectIndexResponse: every Library project, newest
//                                         first, with its vault slug and city (the #/project picker
//                                         and the search's projects)
//   GET /api/project-page/recent?n=4    → ProjectCardsResponse: the projects whose city had a
//                                         session most recently (Home's "Pick up where you left off")
//   GET /api/project-page/:key          → ProjectPageResponse. `key` is a Library project id, a
//                                         vault slug or a city id, looked up in the server's own
//                                         lists (a request never names a path)

import type { ProjectCategory, ProjectGit, ProjectStage, VaultMatchRule } from "./projects.js";
import type { KnownOutcome, SessionOutcome } from "./outcomes.js";

export const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
/** Sessions listed on the page, live first then newest. */
export const PAGE_SESSIONS = 12;
export const PAGE_TODOS = 12;
export const PAGE_VERDICTS = 5;
export const RECENT_DEFAULT = 4;
export const RECENT_MAX = 8;

export interface ProjectPageSession {
  id: string;
  /** agentTitle(): the session's name, else its first prompt. Untrusted text. */
  title: string;
  status: "live" | "dormant";
  lastActive: string;
  awaitingInput: boolean;
  /** Its verdict (outcomes feature); null until the outcomes scan has read it. */
  outcome: SessionOutcome | null;
  /** Items of its latest todo list not completed yet. */
  openTodos: number;
}

export interface ProjectPageVerdict {
  sessionId: string;
  title: string;
  outcome: KnownOutcome;
  /** "owner/repo#12 merged", "API Error: …"; null when the verdict has no one-line reason. */
  reason: string | null;
  at: string;
}

export interface ProjectPageTodo {
  sessionId: string;
  content: string;
  status: "pending" | "in_progress";
}

export interface ProjectPageVault {
  slug: string;
  /** Vault-relative path of the index note: Brain opens it (#/brain/<path>). */
  path: string;
  /** Null when the slug's folder has no _index.md. */
  title: string | null;
  status: string | null;
  /** The umbrella page its frontmatter `parent:` names. */
  umbrella: string | null;
  /** The note's first prose paragraph, links flattened, ≤ SUMMARY_MAX characters. Untrusted text. */
  summary: string | null;
  /** How the Library project was matched to this note; null for a page opened by its slug. */
  matchedBy: VaultMatchRule | null;
}
export const SUMMARY_MAX = 420;

export interface ProjectPage {
  /** The key it was opened with. */
  key: string;
  name: string;
  /** The Library project (#/library/<id>); null for a vault-only or city-only page. */
  libraryId: string | null;
  /** The World cities (districts) its sessions live in: its own and its folded worktrees'. */
  cities: { id: string; name: string }[];
  stage: ProjectStage | null;
  stageReason: string | null;
  category: ProjectCategory | null;
  /** The notes' one-line description, else the README's first line. Untrusted text. */
  desc: string | null;
  deploy: string | null;
  liveUrl: string | null;
  git: ProjectGit | null;
  /** Absolute folder; hidden client-side under ?redact=1. Null for a vault-only page. */
  path: string | null;
  activityAt: string | null;
  sessions: ProjectPageSession[];
  /** Sessions in its cities, of which `live` are running now. */
  sessionsTotal: number;
  live: number;
  todos: { open: number; items: ProjectPageTodo[] };
  verdicts: ProjectPageVerdict[];
  /** Est. API-equivalent cost of its cities' sessions over 30 days; null when unknown or none. */
  spendUsd30d: number | null;
  vault: ProjectPageVault | null;
  /** The newest session, for "Resume" (claude --resume through the Reactivate path). */
  resume: { sessionId: string; title: string; status: "live" | "dormant" } | null;
}

export interface ProjectPageResponse {
  ok: true;
  project: ProjectPage;
}

export interface ProjectCardsResponse {
  ok: true;
  cards: ProjectPage[];
}

export interface ProjectIndexItem {
  key: string;
  name: string;
  vaultSlug: string | null;
  cityId: string | null;
  stage: ProjectStage;
  activityAt: string | null;
}

export interface ProjectIndexResponse {
  ok: true;
  items: ProjectIndexItem[];
}

export interface ProjectPageError {
  ok: false;
  error: string;
}
