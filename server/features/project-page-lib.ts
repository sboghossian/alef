// The pure half of the "project-page" feature (UX-3): which project a key names, and the page
// built from what other features already hold (the Library's scan, the world's sessions, the
// outcomes verdicts, the todo lists, the usage cost, the vault's index note). No IO here, so the
// joins are unit-tested (server/test/project-page-lib.test.ts).

import { agentTitle } from "../../shared/display.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import {
  PAGE_SESSIONS,
  PAGE_TODOS,
  PAGE_VERDICTS,
  SUMMARY_MAX,
  type ProjectIndexItem,
  type ProjectPage,
  type ProjectPageSession,
  type ProjectPageTodo,
  type ProjectPageVault,
  type ProjectPageVerdict,
} from "../../shared/features/project-page.js";
import type { ProjectItem, VaultMatchRule } from "../../shared/features/projects.js";
import type { TodoList } from "../../shared/features/todos.js";
import type { WorldAgent } from "../../shared/types.js";
import { FRONTMATTER_RE, frontmatterOf } from "./project-match-lib.js";

export interface CityRef {
  id: string;
  name: string;
}

/** What a key names: a Library project (and its vault note), a vault slug alone, or a city alone. */
export interface ResolvedKey {
  item: ProjectItem | null;
  /** The vault slug (from the item's match, or the key itself). */
  slug: string | null;
  cities: CityRef[];
}

const lower = (s: string): string => s.toLowerCase();

/** The cities a Library project lives in: its own district and its folded worktrees' and clones'. */
export function citiesOf(item: ProjectItem, cityName: (id: string) => string | null): CityRef[] {
  const ids = [item.islandId, ...item.folded.map((f) => f.islandId)].filter((x): x is string => x !== null);
  return [...new Set(ids)].map((id) => ({ id, name: cityName(id) ?? id }));
}

/** A key, looked up in this order: a Library id, a Library project's vault slug, a Library
 *  project's city, a vault slug with no Library project, a city with no Library project. */
export function resolveProjectKey(key: string, items: readonly ProjectItem[], slugs: readonly string[], cityName: (id: string) => string | null): ResolvedKey | null {
  const k = lower(key);
  const item =
    items.find((p) => p.id === key) ??
    items.find((p) => p.vaultNote !== null && lower(p.vaultNote) === k) ??
    items.find((p) => p.islandId === key || p.folded.some((f) => f.islandId === key));
  if (item) return { item, slug: item.vaultNote, cities: citiesOf(item, cityName) };
  const slug = slugs.find((s) => lower(s) === k);
  if (slug) return { item: null, slug, cities: [] };
  const city = cityName(key);
  return city !== null ? { item: null, slug: null, cities: [{ id: key, name: city }] } : null;
}

/** Strips a markdown line down to its words: [[a|b]] → b, [[a]] → a, [t](u) → t, emphasis and code ticks gone. */
export function plainText(s: string): string {
  return s
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, (_m, t: string) => t.split("/").pop() ?? t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|[.,;:!?)]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The index note as the page shows it: a few frontmatter fields and its first prose paragraph
 *  (a heading, list, table, quote, code block, comment, dataview or an all-italic aside is skipped). */
export function vaultSummary(slug: string, text: string | null, matchedBy: VaultMatchRule | null): ProjectPageVault {
  const path = `20-Projects/${slug}/_index.md`;
  if (text === null) return { slug, path, title: null, status: null, umbrella: null, summary: null, matchedBy };
  const fm = frontmatterOf(text);
  const body = text.replace(FRONTMATTER_RE, "").replace(/```[\s\S]*?```/g, "\n").replace(/<!--[\s\S]*?-->/g, "\n");
  let summary: string | null = null;
  for (const para of body.split(/\r?\n\s*\r?\n/)) {
    const t = para.trim();
    if (!t || /^(#|-|\*\s|\d+\.|\||>|<|---)/.test(t)) continue;
    if (/^_[\s\S]*_$/.test(t) || /^\*(?!\*)[\s\S]*(?<!\*)\*$/.test(t)) continue; // an all-italic aside ("_Refreshed …_")
    const words = plainText(t);
    if (!words) continue;
    summary = words.length > SUMMARY_MAX ? `${words.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : words;
    break;
  }
  return { slug, path, title: fm.title ?? null, status: fm.status ?? null, umbrella: fm.parent ?? null, summary, matchedBy };
}

export interface PageInput {
  key: string;
  resolved: ResolvedKey;
  /** Every world session (filtered to the page's cities here). */
  agents: readonly WorldAgent[];
  outcomes: ReadonlyMap<string, OutcomeRecord>;
  todoList(sessionId: string): TodoList | null;
  /** Est. cost per city over 30 days; null when the usage store can't say. */
  costs: ReadonlyMap<string, number> | null;
  /** The index note's text (null when it has none, or the page has no slug). */
  noteText: string | null;
  /** How many sessions to list (the Home cards want fewer). */
  sessionCap?: number;
}

const byNewest = (a: { lastActive: string }, b: { lastActive: string }): number => b.lastActive.localeCompare(a.lastActive);

/** One project's page, joined from the inputs. */
export function buildProjectPage(i: PageInput): ProjectPage {
  const { item, slug, cities } = i.resolved;
  const cityIds = new Set(cities.map((c) => c.id));
  const mine = i.agents.filter((a) => cityIds.has(a.islandId)).sort(byNewest);
  const openOf = (id: string): ProjectPageTodo[] =>
    (i.todoList(id)?.items ?? []).flatMap((t) => (t.status === "completed" ? [] : [{ sessionId: id, content: t.content, status: t.status }]));
  const todoItems = mine.flatMap((a) => openOf(a.id));
  const sessions: ProjectPageSession[] = [...mine]
    .sort((a, b) => Number(b.status === "live") - Number(a.status === "live") || byNewest(a, b))
    .slice(0, i.sessionCap ?? PAGE_SESSIONS)
    .map((a) => ({ id: a.id, title: agentTitle(a), status: a.status === "live" ? "live" : "dormant", lastActive: a.lastActive, awaitingInput: a.awaitingInput, outcome: i.outcomes.get(a.id)?.outcome ?? null, openTodos: openOf(a.id).length }));
  const verdicts: ProjectPageVerdict[] = [];
  for (const a of mine) {
    const r = i.outcomes.get(a.id);
    if (!r || r.outcome === "unknown" || r.outcome === "active") continue;
    verdicts.push({ sessionId: a.id, title: agentTitle(a), outcome: r.outcome, reason: r.reason, at: r.evidenceAt ?? r.lastActive });
    if (verdicts.length >= PAGE_VERDICTS) break;
  }
  const spend = i.costs ? [...cityIds].reduce((n, c) => n + (i.costs?.get(c) ?? 0), 0) : null;
  const newest = mine[0];
  return {
    key: i.key,
    name: item?.name ?? cities[0]?.name ?? slug ?? i.key,
    libraryId: item?.id ?? null,
    cities,
    stage: item?.stage ?? null,
    stageReason: item?.stageReason ?? null,
    category: item?.category ?? null,
    desc: item?.notes?.desc ?? item?.readme ?? null,
    deploy: item?.deploy ?? null,
    liveUrl: item?.notes?.liveUrl ?? null,
    git: item?.git ?? null,
    path: item?.path ?? null,
    activityAt: item?.activityAt ?? newest?.lastActive ?? null,
    sessions,
    sessionsTotal: mine.length,
    live: mine.filter((a) => a.status === "live").length,
    todos: { open: todoItems.length, items: todoItems.slice(0, PAGE_TODOS) },
    verdicts,
    spendUsd30d: spend !== null && spend > 0 ? spend : null,
    vault: slug ? vaultSummary(slug, i.noteText, item?.vaultMatch ?? null) : null,
    resume: newest ? { sessionId: newest.id, title: agentTitle(newest), status: newest.status === "live" ? "live" : "dormant" } : null,
  };
}

/** The Library projects whose cities had a session most recently, newest first: Home's cards.
 *  A folder that holds other projects (~/Documents, ~/Documents/Code) is where sessions start, not
 *  something to pick up, so it never gets a card. */
export function recentProjects(items: readonly ProjectItem[], agents: readonly WorldAgent[], n: number): ProjectItem[] {
  const holdsOthers = (p: ProjectItem): boolean => items.some((o) => o !== p && o.path.startsWith(`${p.path}/`));
  const newestByCity = new Map<string, string>();
  for (const a of agents) {
    const prev = newestByCity.get(a.islandId);
    if (!prev || a.lastActive > prev) newestByCity.set(a.islandId, a.lastActive);
  }
  const scored: { p: ProjectItem; at: string }[] = [];
  for (const p of items) {
    if (holdsOthers(p)) continue;
    const at = [p.islandId, ...p.folded.map((f) => f.islandId)].reduce<string>((m, id) => {
      const t = id ? (newestByCity.get(id) ?? "") : "";
      return t > m ? t : m;
    }, "");
    if (at) scored.push({ p, at });
  }
  return scored.sort((a, b) => b.at.localeCompare(a.at) || a.p.name.localeCompare(b.p.name)).slice(0, n).map((x) => x.p);
}

/** The picker's and the search's list: every Library project, newest first. */
export function projectIndex(items: readonly ProjectItem[]): ProjectIndexItem[] {
  return [...items]
    .sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? "") || a.name.localeCompare(b.name))
    .map((p) => ({ key: p.id, name: p.name, vaultSlug: p.vaultNote, cityId: p.islandId, stage: p.stage, activityAt: p.activityAt }));
}
