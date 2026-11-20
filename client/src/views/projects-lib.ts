// Pure helpers of the 📁 Projects view (no DOM): filtering, grouping, counts, ?redact=1 labels,
// relative dates and stack-logo URLs. projects.ts draws; the rules that matter are pinned in
// projects-lib.test.ts.

import { PROJECT_CATEGORIES, PROJECT_STAGES, SESSION_SOURCES, type ProjectCategory, type ProjectChange, type ProjectItem, type ProjectStage, type RefreshEntry, type SessionSource, type VaultSessions } from "../../../shared/features/projects";

export const STAGE_META: Record<ProjectStage, { label: string; color: string; hint: string }> = {
  idea: { label: "Idea", color: "#b9a6ff", hint: "No commit and no session yet" },
  building: { label: "Building", color: "#ffd23f", hint: "A commit or session in the last 14 days (or under 60 days and not deployed)" },
  shipped: { label: "Shipped", color: "#62d98b", hint: "Has a deploy config or a live homepage" },
  dormant: { label: "Dormant", color: "#c9c2d6", hint: "Nothing for over 60 days" },
};

export const CATEGORY_META: Record<ProjectCategory, { label: string; emoji: string }> = {
  acme: { label: "ACME", emoji: "⚖️" },
  legal: { label: "Legal", emoji: "📜" },
  infra: { label: "Infra & tooling", emoji: "🛠" },
  side: { label: "Side projects", emoji: "🧪" },
  personal: { label: "Personal", emoji: "🏡" },
};

export interface ProjectFilter {
  query: string;
  categories: readonly string[];
  stages: readonly string[];
  sessionsOnly: boolean;
}

export const NO_FILTER: ProjectFilter = { query: "", categories: [], stages: [], sessionsOnly: false };

/** The text a search matches: name, README line, stack, remote. Never the path (it may be hidden). */
export function searchText(p: ProjectItem): string {
  return [p.name, p.readme ?? "", p.stack.join(" "), p.git?.remote ?? "", p.vaultNote ?? "", ...p.folded.map((f) => f.name)].join(" ").toLowerCase();
}

export function matchesFilter(p: ProjectItem, f: ProjectFilter, redact = false): boolean {
  if (f.sessionsOnly && p.sessions === 0) return false;
  if (f.categories.length && !f.categories.includes(p.category)) return false;
  if (f.stages.length && !f.stages.includes(p.stage)) return false;
  const q = f.query.trim().toLowerCase();
  // Under ?redact=1 a name never shows, so a search must not reveal one by hit or miss.
  return !q || (!redact && searchText(p).includes(q));
}

/** Counts per category / stage given every filter EXCEPT that facet's own (so a chip shows what clicking it would give). */
export function facetCounts(items: readonly ProjectItem[], f: ProjectFilter, redact = false): { category: Record<ProjectCategory, number>; stage: Record<ProjectStage, number> } {
  const category = Object.fromEntries(PROJECT_CATEGORIES.map((c) => [c, 0])) as Record<ProjectCategory, number>;
  const stage = Object.fromEntries(PROJECT_STAGES.map((s) => [s, 0])) as Record<ProjectStage, number>;
  for (const p of items) {
    if (matchesFilter(p, { ...f, categories: [] }, redact)) category[p.category] += 1;
    if (matchesFilter(p, { ...f, stages: [] }, redact)) stage[p.stage] += 1;
  }
  return { category, stage };
}

export interface ProjectGroup {
  category: ProjectCategory;
  items: ProjectItem[];
}

/** Category groups in the fixed order, empty ones dropped, each newest activity first. */
export function groupByCategory(items: readonly ProjectItem[]): ProjectGroup[] {
  return PROJECT_CATEGORIES.map((category) => ({
    category,
    items: items.filter((p) => p.category === category).sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? "") || a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------- ?redact=1

/** The name shown for a project: its own, or a neutral "project 7" (position in the full list). */
export function displayName(p: ProjectItem, all: readonly ProjectItem[], redact: boolean): string {
  return redact ? `project ${all.findIndex((x) => x.id === p.id) + 1}` : p.name;
}

/** The path shown: "" under redact (the caller hides the row), else the path with $HOME folded to ~. */
export function displayPath(path: string, redact: boolean): string {
  if (redact) return "";
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

/** README line, git remote and artifact titles are free text about the work: hidden under redact. */
export const textShown = (text: string | null, redact: boolean): string | null => (redact ? null : text);

// ---------------------------------------------------------------- dates + logos

export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const days = Math.floor(Math.max(0, nowMs - t) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} d ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

/** Stack labels that have a devicon (https://devicon.dev); the others show as a text chip only. */
const DEVICON: Readonly<Record<string, string>> = {
  nextjs: "nextjs", react: "react", vuejs: "vuejs", svelte: "svelte", vitejs: "vitejs", typescript: "typescript", tailwindcss: "tailwindcss",
  express: "express", threejs: "threejs", playwright: "playwright", electron: "electron", astro: "astro", prisma: "prisma", vitest: "vitest",
  d3js: "d3js", nodejs: "nodejs", python: "python", fastapi: "fastapi", django: "django", flask: "flask", pandas: "pandas", numpy: "numpy",
  pytorch: "pytorch", rust: "rust", go: "go", swift: "swift", cloudflare: "cloudflare",
};
export const DEVICON_BASE = "https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons";

export function logoUrl(label: string): string | null {
  const n = DEVICON[label];
  return n ? `${DEVICON_BASE}/${n}/${n}-original.svg` : null;
}

export const STACK_NAMES: Readonly<Record<string, string>> = { nextjs: "Next.js", vuejs: "Vue", vitejs: "Vite", tailwindcss: "Tailwind", threejs: "three.js", d3js: "D3", nodejs: "Node", pytorch: "PyTorch", fastapi: "FastAPI", typescript: "TypeScript", cloudflare: "Cloudflare" };
export const stackName = (label: string): string => STACK_NAMES[label] ?? label.charAt(0).toUpperCase() + label.slice(1);

/** Headline numbers for the left sidebar. */
export function summaryLine(items: readonly ProjectItem[], shown: number): string {
  const withSessions = items.filter((p) => p.sessions > 0).length;
  const repos = items.filter((p) => p.kind === "repo").length;
  return `${shown === items.length ? `${items.length} projects` : `showing ${shown} of ${items.length}`} · ${repos} git repos · ${withSessions} with sessions`;
}

/** Cards a category group shows before "Show all N". */
export const GROUP_CAP = 12;

/** The cards a group shows: all of them when expanded or small, else the first GROUP_CAP. */
export function visibleCards<T>(items: readonly T[], expanded: boolean): { shown: readonly T[]; hidden: number } {
  if (expanded || items.length <= GROUP_CAP) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, GROUP_CAP), hidden: items.length - GROUP_CAP };
}

/** "+3 worktrees · +1 clone" for a card that folds other folders; "" when none. */
export function foldedLabel(p: ProjectItem): string {
  const wt = p.folded.filter((f) => f.kind === "worktree").length;
  const cl = p.folded.length - wt;
  return [wt ? `+${wt} worktree${wt === 1 ? "" : "s"}` : "", cl ? `+${cl} clone${cl === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
}

/** Every district a card stands for: its own and its folded folders' (sessions + artifacts). */
export function islandsOf(p: ProjectItem): string[] {
  return [p.islandId, ...p.folded.map((f) => f.islandId)].filter((x): x is string => x !== null);
}

// ---------------------------------------------------------------- ported from the roadmap

/** "+12 commits · stage building -> shipped": what one scan saw change. */
export function changeSummary(c: ProjectChange): string {
  const signed = (n: number, noun: string): string => `${n > 0 ? "+" : "-"}${Math.abs(n)} ${noun}${Math.abs(n) === 1 ? "" : "s"}`;
  return [c.commits ? signed(c.commits, "commit") : "", c.sessions ? signed(c.sessions, "session") : "", c.stage ? `stage ${c.stage.from} -> ${c.stage.to}` : "", c.branch ? `branch ${c.branch.from ?? "?"} -> ${c.branch.to ?? "?"}` : ""].filter(Boolean).join(" · ");
}

/** "changed 3 d ago: +12 commits" for the newest recorded change; null when none has been seen yet. */
export function lastChangeLine(p: ProjectItem, nowMs: number): string | null {
  const c = p.changes[0];
  if (!c) return null;
  const when = ago(c.at, nowMs);
  return `changed ${when === "today" ? "today" : when}: ${changeSummary(c)}`;
}

export const SOURCE_META: Record<SessionSource, { emoji: string; label: string }> = {
  "claude-code": { emoji: "💻", label: "Claude Code" },
  "claude-cowork": { emoji: "🤝", label: "Cowork" },
  "claude-chat": { emoji: "💬", label: "Claude Chat" },
  chatgpt: { emoji: "🤖", label: "ChatGPT" },
};

/** Per-source chips of the vault session notes, in the fixed source order, zero counts dropped. */
export function sessionChips(v: VaultSessions | null): { source: SessionSource; emoji: string; label: string; n: number }[] {
  if (!v) return [];
  return SESSION_SOURCES.filter((s) => (v[s] ?? 0) > 0).map((s) => ({ source: s, ...SOURCE_META[s], n: v[s] ?? 0 }));
}

/** https://github.com/<owner>/<repo> for an "owner/repo" remote; null for anything else. */
export function githubUrl(remote: string | null): string | null {
  return remote && /^[\w.-]+\/[\w.-]+$/.test(remote) ? `https://github.com/${remote}` : null;
}

/** Only http(s) links from the notes file become anchors. */
export const safeHttpUrl = (u: string | null): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

export const previewUrl = (id: string): string => `/api/projects/${encodeURIComponent(id)}/preview`;

export const costLabel = (usd: number | null): string | null => (usd === null || usd <= 0 ? null : usd < 1 ? "<$1" : `$${Math.round(usd).toLocaleString("en-US")}`);

/** "12,345 commits · 9 active this week" for the sidebar. */
export function commitStats(items: readonly ProjectItem[], nowMs: number): string {
  const commits = items.reduce((n, p) => n + (p.git?.commits ?? 0), 0);
  const active = items.filter((p) => p.git?.lastCommit && nowMs - Date.parse(p.git.lastCommit) < 7 * 86_400_000).length;
  return `${commits.toLocaleString("en-US")} commits · ${active} active this week`;
}

/** One line of the scan history: "14 Oct 09:12 · 84 projects · 6 building · 9 active this week". */
export function refreshLine(e: RefreshEntry): string {
  const d = new Date(e.at);
  const when = Number.isNaN(d.getTime()) ? e.at : `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${when} · ${e.total} projects · ${e.stageCounts.building} building · ${e.activeThisWeek} active this week`;
}
