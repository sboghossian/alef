// Pure logic behind the 🗺️ Atlas (server/features/atlas.ts): turns what other features already
// scanned (skills + fired counts, automations, routines, Tower workers, subagent runs, the CLI
// registry) plus ~/.claude/agents/*.md into leaves, files each leaf under one of 8 capability
// departments, and puts it on the autonomy ladder with the evidence for that rung.
//
// Department, in this order (first that answers wins; every leaf carries its reason and `via`):
//   (0) OVERRIDES: Alex's own name → department decisions, for the few leaves nothing else
//       judges well (a routine known only by its name). Beats every rule below;
//   (a) mention: the bundle text names it (`/name`, `[[name]]`, or the bare name as a whole word
//       only when the name is distinctive: hyphenated or with a digit, so prose "benchmark" or
//       "done" is not /benchmark or /done);
//       the department with the most mentions wins, a tie of two goes to the earlier department,
//       a tie of three or more counts as no mention at all (the bundles just all cite it).
//       Two exceptions (Alex 2026-09-30), both only for a mention won by the Infra bundle,
//       which names tools for their incidents, not because they are infrastructure:
//       - ritualException: a job scheduled daily or weekly whose name says ritual → Rituals;
//       - infraYield: its pack or a name keyword points to Build & ship, Research & studio or
//         Brain & vault → that department ("pack obsidian plugin (mentioned 1× in Infra + Claude)");
//   (b) PACKS: where it was installed from (the gstack folder, a name prefix, a plugin namespace);
//   (c) KEYWORDS below (name tokens first, then whole words of the description);
//   (d) Jev (atlas-jev-lib.ts): picks one of the 8 from the name + description only, cached per
//       leaf; below JEV_MIN_CONFIDENCE, down or pending, the leaf stays Unfiled and says so;
//   (e) Unfiled.
// Only the first five departments read a bundle (memory/_L2); Build & ship, Research & studio and
// Brain & vault have none, so they fill from (b)-(d).
// Autonomy: autonomous = something schedules it (a loaded launchd job, a scheduled task, a Tower
// worker on a loaded launchd job); assisted = used in sessions in the last 30 days; manual = the
// rest; null = unknown (launchd's load state couldn't be read), never guessed as autonomous.
// Bundle text only ever feeds counts here: it is never copied into a leaf or a reason, nor sent to Jev.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AtlasAutonomy, AtlasDept, AtlasDeptId, AtlasLeaf, AtlasVia } from "../../shared/features/atlas.js";
import type { Automation } from "../../shared/features/automations.js";
import type { CareerWorker } from "../../shared/features/careers.js";
import type { CliEntry } from "../../shared/features/cli-station.js";
import type { InstalledSkill, SkillCandidate, SkillUsageRow } from "../../shared/features/skills.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import { jevFiled, type JevLookup } from "./atlas-jev-lib.js";
import { parseSkillFrontmatter } from "./automations-lib.js";
import { routineSlug } from "./careers-lib.js";

const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;
const BUNDLE_READ_CAP = 256 * 1024;
const AGENT_READ_CAP = 16 * 1024;
const DESCRIPTION_CAP = 280;

export interface DeptDef {
  id: AtlasDeptId;
  name: string;
  emoji: string;
  /** memory/_L2/<file>.md read for this department. */
  bundles: readonly string[];
  /** What belongs here, in Alef's own words: Jev's criteria (never bundle text). */
  hint: string;
}

/** Ring order = ATLAS_DEPT_IDS. Five read an L2 bundle each; alex-context (personal) is never read. */
export const DEPARTMENTS: readonly DeptDef[] = [
  { id: "acme-website", name: "ACME website", emoji: "🌐", bundles: ["acme-website"], hint: "the acme.ai website: its pages, blog, SEO, copy checks and site deploys" },
  { id: "acme-gtm", name: "ACME GTM", emoji: "📈", bundles: ["acme-gtm"], hint: "ACME go-to-market: growth, sales, outbound and leads, CRM and lifecycle email, pricing, metrics, competitors, founder and business playbooks" },
  { id: "infra", name: "Infra + Claude", emoji: "⚙️", bundles: ["infra-claude-system", "tooling-gotchas", "measurement-discipline"], hint: "the Claude Code harness itself: hooks, settings, sessions, logs, janitors, watchdogs, model routing, Jev plumbing, the agent fleet, making and managing skills, how Claude should work" },
  { id: "rituals", name: "Rituals", emoji: "☀️", bundles: ["rituals"], hint: "Alex's daily and weekly routines: morning briefs, inbox sweeps, recaps, digests, check-ins" },
  { id: "side-projects", name: "Side projects + legal OSS", emoji: "⚖️", bundles: ["side-projects"], hint: "non-ACME builds and public legal open source: legal drafting and research, contracts, family law, the portfolio, Instagram tooling" },
  { id: "build-ship", name: "Build & ship", emoji: "🛠️", bundles: [], hint: "building software: planning, specs, code review, QA, TDD, debugging, deploy and release, design passes, security audits, developer subagent roles" },
  { id: "research-studio", name: "Research & studio", emoji: "🔎", bundles: [], hint: "web search and scraping, research, video (HyperFrames), PDFs and office documents, writing and humanizing, images and media" },
  { id: "brain-vault", name: "Brain & vault", emoji: "🧠", bundles: [], hint: "the Obsidian vault, memory files, recall, ingest, knowledge capture" },
  { id: "unfiled", name: "Unfiled", emoji: "📦", bundles: [], hint: "" },
];

/** (0) THE place Alex edits: a leaf's name (without the Tower's ⏰, plugin namespace kept)
 *  → its department, beating every other rule. Keep it tiny: one line per leaf the rules and Jev
 *  get wrong, each with why. */
export const OVERRIDES: Readonly<Record<string, AtlasDeptId>> = {
  "connection-synthesis": "brain-vault", // the vault's 06:00 connections brief; its plist has no description, so Jev judged the name alone (Infra 0.94)
  last30days: "research-studio", // research across Reddit/X/HN; the Infra bundle names it, but no pack or name keyword says research
  "lexwiki-learn": "side-projects", // learnings from an open-source legal-AI codebase audit; "ACME" in its description only says where they get used
  "ai-claims-critic": "research-studio", // critiques claims in any text; "marketing copy" is just one example input, which made it ACME GTM
  "pick-model": "infra", // model routing; its description lists legal drafting as an example task, which alone would file it under legal OSS
  "daily-legal-llm-benchmark": "side-projects", // "daily" is its cadence, the subject is the legal LLM benchmark (like ⏰ llm-legal-benchmark)
  "pe-biotech-competitor-scan": "research-studio", // a market scan for a private-equity biotech question, not ACME's competitors
  "x-post": "side-projects", // posts for Alex's personal X account (its description says: not the ACME account), like linkedin-post
  "ascii-art": "research-studio", // a text-mode visual/media design kit; "SEO" is one item of its rulebook, Jev was unsure (0.43)
  "lecun-world-model": "build-ship", // reviews LLM-agent designs and plans before they're built; "model" made it Infra, and Jev read it the same way (0.93)
  "model-spec-diff": "side-projects", // gap-analyses an organisation's AI governance policy against published model specs: policy/compliance work, not the harness (Jev said Infra 0.90)
};

/** The three departments no bundle covers: an Infra mention yields to their pack or name keyword. */
const NEW_DEPTS: ReadonlySet<AtlasDeptId> = new Set(["build-ship", "research-studio", "brain-vault"]);

/** (b) Editable, tried in order: a pack split across two departments lists its exceptions first.
 *  A row matches on any of: `folder` inside the leaf's file path, a `prefixes` entry starting its
 *  name (without a plugin namespace), or its plugin `namespace` ("obsidian" for "obsidian:knap");
 *  `only` then narrows it to those names. */
export interface PackDef {
  pack: string;
  dept: AtlasDeptId;
  folder?: string;
  prefixes?: readonly string[];
  namespace?: string;
  only?: readonly string[];
}
export const PACKS: readonly PackDef[] = [
  { pack: "gstack", dept: "research-studio", folder: "/skills/gstack/", only: ["make-pdf", "scrape"] },
  { pack: "gstack", dept: "build-ship", folder: "/skills/gstack/" },
  { pack: "HyperFrames", dept: "research-studio", prefixes: ["hyperframes"] },
  { pack: "Firecrawl", dept: "research-studio", prefixes: ["firecrawl-"] },
  { pack: "CodeSpring", dept: "build-ship", prefixes: ["cs-", "codespring"] },
  { pack: "obsidian plugin", dept: "brain-vault", namespace: "obsidian" },
  { pack: "grok plugin", dept: "infra", namespace: "grok" },
  { pack: "typesafe plugin", dept: "infra", namespace: "typesafe" },
  { pack: "skillspec plugin", dept: "infra", namespace: "skillspec" },
];

/** (c) Editable. Tried in this order: every department's `name` words against the leaf's name
 *  (a hyphenated word = a prefix of the name, any other = one of its tokens, a plugin's name
 *  included), then every department's `text` words as whole words of the description, where a
 *  hit doesn't count when negated ("not the ACME account") or when a short word is one item of
 *  a slash list ("a11y/SEO/RTL"): see descriptionHit. Generic English name words ("model",
 *  "release") are left out on purpose: they caught unrelated leaves (lecun-world-model,
 *  release-the-monster). */
export const KEYWORDS: readonly { dept: AtlasDeptId; name: readonly string[]; text: readonly string[] }[] = [
  { dept: "acme-website", name: ["acme-ship", "acme-blog", "acme-deploy", "acme-preflight", "acme-aeo", "seo", "blog", "landing"], text: ["seo", "website", "acme.ai"] },
  { dept: "acme-gtm", name: ["acme", "growth", "gtm", "linkedin", "outbound", "leads", "leadgen", "plg", "crm", "pricing", "sales", "marketing", "competitor", "posthog", "otterly"], text: ["acme", "growth", "gtm", "linkedin", "outbound", "plg", "crm", "pricing", "sales", "marketing", "posthog"] },
  { dept: "rituals", name: ["ritual", "morning", "recap", "daily", "weekly", "inbox", "digest", "yalla-brief"], text: ["ritual", "morning brief", "every morning"] },
  { dept: "side-projects", name: ["legal", "law", "contract", "route", "court", "divorce", "agreement", "irac", "portfolio", "oss", "ig"], text: ["legal", "lawyer", "court", "litigation", "open-source", "divorce", "family-law"] },
  {
    dept: "build-ship",
    name: ["plan", "planning", "review", "reviewer", "qa", "tdd", "ship", "deploy", "design", "designer", "debug", "investigate", "grill", "yalla", "eval", "engineer", "requirement", "product", "advisor", "validator", "documentation", "git"],
    text: ["code review", "pull request", "qa", "tdd", "unit tests", "debugging", "deploy", "prd", "requirements"],
  },
  {
    dept: "research-studio",
    name: ["research", "science", "search", "scrape", "crawl", "browser", "video", "media", "deck", "pdf", "officecli", "writing", "humanizer"],
    text: ["web search", "scraping", "research", "video", "pdf", "office documents", "writing"],
  },
  { dept: "brain-vault", name: ["brain", "vault", "memory", "recall", "ingest", "knowledge", "capture", "obsidian"], text: ["obsidian", "vault", "memory files", "knowledge base"] },
  {
    dept: "infra",
    name: ["claude", "skill", "skills", "agent", "hook", "mcp", "cli", "jev", "watchdog", "janitor", "prune", "logs", "sync", "bridge", "fleet", "session", "sessions", "worktree"],
    text: ["claude code", "hook", "hooks", "subagent", "subagents", "mcp", "launchd"],
  },
];

const deptName = (id: AtlasDeptId): string => DEPARTMENTS.find((d) => d.id === id)?.name ?? id;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "unknown");

/** What a leaf is called in prose: a plugin skill's own name, a Tower key without its clock. */
export function mentionTerm(name: string): string {
  return (name.split(":").pop() ?? name).replace(/^⏰\s*/, "").replace(/^\/+/, "");
}

/** How many times `text` mentions `name` (see the module doc for what counts). Case-sensitive. */
export function countMentions(text: string, name: string): number {
  const term = mentionTerm(name);
  if (!term) return 0;
  const t = escapeRe(term);
  const re =
    /[-\d]/.test(term)
      ? new RegExp(`(?<![A-Za-z0-9_-])${t}(?![A-Za-z0-9_-])`, "g")
      : new RegExp(`(?:(?<![A-Za-z0-9_.~-])/${t}|\\[\\[${t}(?:[|#][^\\]]*)?\\]\\])(?![A-Za-z0-9_-])`, "g");
  return text.match(re)?.length ?? 0;
}

/** A leaf's department and why. `via` says which rule answered. */
export interface Filed {
  dept: AtlasDeptId;
  reason: string;
  via: AtlasVia;
}

/** What else the rules may look at: the leaf's file (packs) and its launchd / scheduled-task
 *  schedule text ("daily 08:10", "Sunday 07:00", "every 5 min": the ritual exception). */
export interface LeafFacts {
  path?: string | null;
  schedule?: string | null;
}

const termOf = (name: string): string => mentionTerm(name.toLowerCase());

function nameKeyword(words: readonly string[], name: string): string | undefined {
  const lower = name.toLowerCase().replace(/^⏰\s*|^\/+/g, "");
  const term = mentionTerm(lower);
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  return words.find((x) => (x.includes("-") ? term.startsWith(x) : tokens.has(x)));
}

/** Words that, within the three words before a keyword in the same clause, negate it. */
const NEGATIONS: ReadonlySet<string> = new Set(["not", "never", "no", "nor", "without", "isn't", "aren't", "don't", "doesn't", "won't", "neither"]);
/** A clause ends at any of these: a negation before one doesn't reach past it. */
const CLAUSE_END = /[.,;:!?()[\]{}"—–\n]/;
/** Keywords this short are acronyms ("seo", "qa", "crm"): one item of a slash list names a checklist entry, not the subject. */
const SHORT_WORD = 4;

/** True when `word` occurs in the (lowercased) description as a whole word at least once
 *  without a negation in the three words before it in its clause ("(not the ACME company
 *  account)"), and, for a short word, not as one item of a slash list ("a11y/seo/rtl/perf"). */
export function descriptionHit(desc: string, word: string): boolean {
  const re = new RegExp(`(?<![a-z0-9])${escapeRe(word)}(?![a-z0-9])`, "g");
  for (let m = re.exec(desc); m; m = re.exec(desc)) {
    const at = m.index;
    const end = at + word.length;
    if (word.length <= SHORT_WORD && (desc[at - 1] === "/" || desc[end] === "/")) continue;
    const before = desc.slice(0, at);
    let cut = before.length;
    while (cut > 0 && !CLAUSE_END.test(before[cut - 1]!)) cut--;
    const lead = before.slice(cut).match(/[a-z']+/g) ?? [];
    if (lead.slice(-3).some((w) => NEGATIONS.has(w))) continue;
    return true;
  }
  return false;
}

function keywordMatch(name: string, description: string): Omit<Filed, "via"> | null {
  for (const k of KEYWORDS) {
    const w = nameKeyword(k.name, name);
    if (w) return { dept: k.dept, reason: `keyword ${w}` };
  }
  const desc = description.toLowerCase().replace(/’/g, "'");
  for (const k of KEYWORDS) {
    const w = k.text.find((x) => descriptionHit(desc, x));
    if (w) return { dept: k.dept, reason: `keyword ${w} (description)` };
  }
  return null;
}

/** (b) The first PACKS row that claims the leaf, or null. */
export function packMatch(name: string, path: string | null): PackDef | null {
  const lower = name.toLowerCase();
  const ns = lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : null;
  const term = termOf(name);
  for (const p of PACKS) {
    const hit = (p.folder !== undefined && path !== null && path.includes(p.folder)) || (p.prefixes?.some((x) => term.startsWith(x)) ?? false) || (p.namespace !== undefined && ns === p.namespace);
    if (hit && (!p.only || p.only.includes(term))) return p;
  }
  return null;
}

/** launchd's and the Tower's words for once a day or once a week or more ("daily 08:10",
 *  "3x daily", "weekdays 09:00", "Mon/Thu 09:00", "Sunday 07:00"); never "every 5 min" or monthly. */
export function isDailyOrWeekly(schedule: string): boolean {
  return !/\b(?:monthly|hourly|every)\b/i.test(schedule) && /\b(?:daily|weekdays|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*)\b/.test(schedule);
}

/** The ritual exception to "mention wins": the ritual word in its name, or null when it doesn't
 *  apply (not an Infra mention, no daily/weekly schedule, or a name that doesn't say ritual). */
export function ritualException(name: string, schedule: string | null, mentionDept: AtlasDeptId): string | null {
  if (mentionDept !== "infra" || !schedule || !isDailyOrWeekly(schedule)) return null;
  return nameKeyword(KEYWORDS.find((k) => k.dept === "rituals")?.name ?? [], name) ?? null;
}

/** The department whose bundle names it most, or `tie` (3+ departments share the top count:
 *  every bundle cites it, so none owns it), or null (never named). */
export function mentionWinner(name: string, texts: ReadonlyMap<AtlasDeptId, string>): { dept: AtlasDeptId; n: number } | { tie: number; n: number } | null {
  let best: { dept: AtlasDeptId; n: number } | null = null;
  const counts: number[] = [];
  for (const d of DEPARTMENTS) {
    const text = texts.get(d.id);
    const n = text ? countMentions(text, name) : 0;
    if (n > 0) counts.push(n);
    if (n > 0 && (!best || n > best.n)) best = { dept: d.id, n };
  }
  if (!best) return null;
  const top = best.n;
  const tied = counts.filter((n) => n === top).length;
  return tied >= 3 ? { tie: tied, n: top } : best;
}

/** The Infra-yield exception: the pack or name keyword that takes an Infra-mentioned leaf to one
 *  of the three new departments, or null. */
export function infraYield(name: string, path: string | null): { dept: AtlasDeptId; via: "pack" | "keyword"; word: string } | null {
  const p = packMatch(name, path);
  if (p) return NEW_DEPTS.has(p.dept) ? { dept: p.dept, via: "pack", word: `pack ${p.pack}` } : null;
  for (const k of KEYWORDS) {
    if (!NEW_DEPTS.has(k.dept)) continue;
    const w = nameKeyword(k.name, name);
    if (w) return { dept: k.dept, via: "keyword", word: `keyword ${w}` };
  }
  return null;
}

/** (0) override → (a) mention (or its ritual / Infra-yield exceptions) → (b) pack → (c) keyword → unfiled.
 *  Jev (d) is buildAtlas's. */
export function fileLeaf(name: string, description: string, texts: ReadonlyMap<AtlasDeptId, string>, facts: LeafFacts = {}): Filed {
  const own = OVERRIDES[name.replace(/^⏰\s*/, "")];
  if (own) return { dept: own, via: "override", reason: "override" };
  const m = mentionWinner(name, texts);
  if (m && "dept" in m) {
    const said = `mentioned ${m.n}× in ${deptName(m.dept)}`;
    const word = ritualException(name, facts.schedule ?? null, m.dept);
    if (word) return { dept: "rituals", via: "ritual", reason: `ritual: ${facts.schedule} + name "${word}" (${said})` };
    const y = m.dept === "infra" ? infraYield(name, facts.path ?? null) : null;
    if (y) return { dept: y.dept, via: "yield", reason: `${y.word} (${said})` };
    return { dept: m.dept, via: "mention", reason: said };
  }
  const tie = m ? ` (mentions tied: ${m.n}× in each of ${m.tie} departments)` : "";
  const p = packMatch(name, facts.path ?? null);
  if (p) return { dept: p.dept, via: "pack", reason: `pack ${p.pack}${tie}` };
  const k = keywordMatch(name, description);
  if (k) return { dept: k.dept, via: "keyword", reason: `${k.reason}${tie}` };
  return { dept: "unfiled", via: "unfiled", reason: "unfiled" };
}

/** fileLeaf without `via`: the department and the reason only. */
export function classifyLeaf(name: string, description: string, texts: ReadonlyMap<AtlasDeptId, string>, facts: LeafFacts = {}): { dept: AtlasDeptId; reason: string } {
  const { dept, reason } = fileLeaf(name, description, texts, facts);
  return { dept, reason };
}

/** What Jev is shown for a leaf: its name (without the Tower's clock) and its description. */
export function jevAsk(leaf: { name: string; description: string }): { name: string; description: string } {
  return { name: leaf.name.replace(/^⏰\s*/, ""), description: leaf.description };
}

// ---------------------------------------------------------------- inputs

export interface AgentDef {
  name: string;
  description: string;
  path: string;
}

export interface AtlasInput {
  nowMs: number;
  bundleTexts: ReadonlyMap<AtlasDeptId, string>;
  bundleCounts: ReadonlyMap<AtlasDeptId, number>;
  skills: { installed: readonly InstalledSkill[]; usage: readonly SkillUsageRow[]; candidates: readonly SkillCandidate[] };
  historyReady: boolean;
  agents: readonly AgentDef[];
  /** `loaded` (launchctl) and `plistPath` come from the same scan, keyed on the plist's Label. */
  automations: readonly Pick<Automation, "id" | "kind" | "launchdLabel" | "skill" | "schedule" | "description" | "lastRunAt" | "loaded" | "plistPath" | "scheduledBy">[];
  /** Null until careers has computed once. */
  workers: readonly Pick<CareerWorker, "key" | "routine" | "lifetime" | "lastRunAt" | "runs">[] | null;
  /** Null until the subagents feature's first pass. */
  subagents: readonly Pick<SubagentRecord, "agentType" | "startedAt">[] | null;
  clis: readonly CliEntry[];
  /** (d) Jev's cached verdict for a leaf that no rule filed (atlas-jev.ts). Absent = no Jev step. */
  jev?: (ask: { name: string; description: string }) => JevLookup;
}

type Rung = { autonomy: AtlasAutonomy | null; evidence: string };
type Draft = Omit<AtlasLeaf, "dept" | "reason" | "via" | "canOpen">;

const recent = (iso: string | null, nowMs: number): boolean => iso !== null && nowMs - Date.parse(iso) <= WINDOW_MS;

function usedRung(uses: number, uses30d: number, lastAt: string | null, verb: string, never: string): Rung {
  if (uses30d > 0) return { autonomy: "assisted", evidence: `${verb} ${uses30d}× in the last 30 days` };
  if (uses > 0) return { autonomy: "manual", evidence: `last ${verb} ${day(lastAt)}, none in 30 days` };
  return { autonomy: "manual", evidence: never };
}

/** A launchd job's rung from launchctl's load state: loaded → autonomous, not loaded → paused, unread → unknown. */
function launchdRung(label: string, loaded: boolean | undefined, evidence: string): Rung {
  if (loaded === false) return { autonomy: "manual", evidence: `paused: launchd has not loaded ${label}` };
  if (loaded === undefined) return { autonomy: null, evidence: `${evidence} (load state not read: launchctl list unavailable)` };
  return { autonomy: "autonomous", evidence };
}

/** Skills: the Skills view's own words. Graveyard = installed with no fire in 90 days (never fired included). */
function skillRung(u: SkillUsageRow | undefined, historyReady: boolean): Rung {
  const fired30d = u?.fired30d ?? 0;
  const firedTotal = u?.firedTotal ?? 0;
  if (fired30d > 0) return { autonomy: "assisted", evidence: `fired ${fired30d}× in the last 30 days` };
  if (!historyReady && firedTotal === 0) return { autonomy: "manual", evidence: "no fires found yet (skill history still loading)" };
  if ((u?.fired90d ?? 0) === 0) return { autonomy: "manual", evidence: firedTotal > 0 ? `graveyard: last fired ${day(u?.lastFiredAt ?? null)}, none in 90 days` : "graveyard: never fired" };
  return { autonomy: "manual", evidence: `last fired ${day(u?.lastFiredAt ?? null)}, none in 30 days` };
}

/** Every leaf, filed and ranked, sorted by id; plus each department's count and the leaves Jev
 *  still has to answer (its lookup said "pending"), for the caller to ask. */
export function buildAtlas(input: AtlasInput): { departments: AtlasDept[]; leaves: Omit<AtlasLeaf, "canOpen">[]; jevAsks: { name: string; description: string }[] } {
  const { nowMs } = input;
  const workers = input.workers ?? [];
  const drafts: Draft[] = [];
  const jobByLabel = new Map(input.automations.filter((a) => a.launchdLabel).map((a) => [a.launchdLabel, a]));

  // Skills: run by a launchd job, invoked by a scheduled task, or a Tower worker's lineage on a launchd job.
  // A skill whose own description merely says a scheduler fires it ("self-described") is not enough.
  const scheduled = new Map<string, Rung>();
  /** Leaf id → its launchd / scheduled-task schedule text, paused or not (the ritual exception reads it). */
  const schedules = new Map<string, string>();
  for (const a of input.automations) {
    if (!a.schedule || !(a.kind === "launchd" || a.scheduledBy === "scheduled-task")) continue;
    if (a.skill && !schedules.has(`skill:${a.skill}`)) schedules.set(`skill:${a.skill}`, a.schedule);
    if (a.kind === "launchd") schedules.set(`routine:${a.id}`, a.schedule);
  }
  for (const a of input.automations) {
    if (!a.skill || scheduled.has(a.skill)) continue;
    const when = a.schedule ? ` · ${a.schedule}` : "";
    if (a.kind === "launchd" && a.launchdLabel) {
      const rung = launchdRung(a.launchdLabel, a.loaded, `run by launchd ${a.launchdLabel}${when}`);
      if (rung.autonomy !== "manual") scheduled.set(a.skill, rung); // a paused job schedules nothing
    } else if (a.scheduledBy === "scheduled-task") scheduled.set(a.skill, { autonomy: "autonomous", evidence: `a scheduled task invokes it${when}` });
  }
  for (const w of workers) {
    const slug = routineSlug(w.key);
    const job = w.routine ? jobByLabel.get(w.routine.label) : undefined;
    if (!w.routine || scheduled.has(slug)) continue;
    const rung = launchdRung(w.routine.label, job?.loaded, `Tower worker ${w.key} runs on ${w.routine.label}`);
    if (rung.autonomy !== "manual") scheduled.set(slug, rung);
  }
  const usage = new Map(input.skills.usage.map((u) => [u.slug, u]));
  for (const s of input.skills.installed) {
    const u = usage.get(s.slug);
    const rung = scheduled.get(s.slug) ?? skillRung(u, input.historyReady);
    drafts.push({ id: `skill:${s.slug}`, kind: "skill", name: s.slug, description: s.description, ...rung, uses: u?.firedTotal ?? 0, uses30d: u?.fired30d ?? 0, lastUsedAt: u?.lastFiredAt ?? null, path: s.path });
  }
  const installed = new Set(input.skills.installed.map((s) => s.slug));
  for (const c of input.skills.candidates) {
    if (installed.has(c.slug)) continue;
    drafts.push({ id: `skill:${c.slug}`, kind: "skill", name: c.slug, description: c.description, autonomy: "manual", evidence: "candidate in the review queue (not installed)", uses: 0, uses30d: 0, lastUsedAt: null, path: c.path });
  }

  // Agents: spawned as subagents (agentType), from the subagents feature's records. Id = file name (unique).
  for (const a of input.agents) {
    const runs = (input.subagents ?? []).filter((r) => r.agentType === a.name).map((r) => r.startedAt).sort();
    const last = runs[runs.length - 1] ?? null;
    const n30 = runs.filter((t) => recent(t, nowMs)).length;
    const rung = usedRung(runs.length, n30, last, "spawned", input.subagents === null ? "subagent history not read yet" : "never spawned as a subagent");
    drafts.push({ id: `agent:${basename(a.path, ".md")}`, kind: "agent", name: a.name, description: a.description, ...rung, uses: input.subagents === null ? null : runs.length, uses30d: n30, lastUsedAt: last, path: a.path });
  }

  // Routines: every com.stephane.* launchd job, then Tower workers no job claims (not "/skill" keys: the skill leaf has those).
  const claimed = new Set<string>();
  for (const a of input.automations) {
    if (a.kind !== "launchd" || !a.launchdLabel?.startsWith("com.stephane.")) continue;
    const label = a.launchdLabel;
    const w = workers.find((x) => x.routine?.label === label) ?? workers.find((x) => routineSlug(x.key) === a.id);
    if (w) claimed.add(w.key);
    const rung = launchdRung(label, a.loaded, `launchd ${label}${a.schedule ? ` · ${a.schedule}` : ""}`);
    const n30 = w ? w.runs.filter((r) => recent(r.at, nowMs)).length : 0;
    drafts.push({ id: `routine:${a.id}`, kind: "routine", name: a.id, description: a.description ?? "", ...rung, uses: input.workers === null ? null : (w?.lifetime.total ?? 0), uses30d: n30, lastUsedAt: w?.lastRunAt ?? a.lastRunAt, path: a.plistPath ?? null });
  }
  for (const w of workers) {
    if (claimed.has(w.key) || w.key.startsWith("/")) continue;
    const n30 = w.runs.filter((r) => recent(r.at, nowMs)).length;
    // A "⏰" key is a past scheduled-task run: it counts as scheduled only while it still runs.
    const rung: Rung = w.key.startsWith("⏰") && n30 > 0 ? { autonomy: "autonomous", evidence: `scheduled task · ran ${n30}× in the last 30 days` } : usedRung(w.lifetime.total, n30, w.lastRunAt, "ran", "no runs recorded");
    drafts.push({ id: `routine:${w.key}`, kind: "routine", name: w.key, description: "", ...rung, uses: w.lifetime.total, uses30d: n30, lastUsedAt: w.lastRunAt, path: null });
  }

  // CLIs: the registry has no run log. Two entries with one name get distinct ids, in (name, entry) order.
  const clis = [...input.clis].sort((a, b) => a.name.localeCompare(b.name) || a.entry.localeCompare(b.entry));
  clis.forEach((c, i) => {
    const dup = i > 0 && clis[i - 1]!.name === c.name;
    drafts.push({ id: dup ? `cli:${c.name}@${c.entry}` : `cli:${c.name}`, kind: "cli", name: c.name, description: c.purpose, autonomy: "manual", evidence: "no run record: CLI runs aren't logged", uses: 0, uses30d: 0, lastUsedAt: null, path: c.entry });
  });

  const byId = new Map<string, Omit<AtlasLeaf, "canOpen">>();
  const jevAsks: { name: string; description: string }[] = [];
  for (const d of drafts) {
    if (byId.has(d.id)) continue;
    const description = d.description.length > DESCRIPTION_CAP ? `${d.description.slice(0, DESCRIPTION_CAP - 1)}…` : d.description;
    let filed = fileLeaf(d.name, description, input.bundleTexts, { path: d.path, schedule: schedules.get(d.id) ?? null });
    if (filed.via === "unfiled" && input.jev) {
      const ask = jevAsk({ name: d.name, description });
      const lookup = input.jev(ask);
      if (lookup.kind === "pending") jevAsks.push(ask);
      filed = jevFiled(lookup);
    }
    byId.set(d.id, { ...d, description, ...filed });
  }
  const leaves = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const departments = DEPARTMENTS.map((d) => ({ id: d.id, name: d.name, emoji: d.emoji, bundles: input.bundleCounts.get(d.id) ?? 0, leaves: leaves.filter((l) => l.dept === d.id).length }));
  return { departments, leaves, jevAsks };
}

// ---------------------------------------------------------------- fs (best-effort, never throws)

/** Each department's bundle text (kept in memory for counting only) and how many files were read. */
export async function readBundles(l2Dir: string): Promise<{ texts: Map<AtlasDeptId, string>; counts: Map<AtlasDeptId, number> }> {
  const texts = new Map<AtlasDeptId, string>();
  const counts = new Map<AtlasDeptId, number>();
  await Promise.all(
    DEPARTMENTS.map(async (d) => {
      const parts = await Promise.all(d.bundles.map((b) => readFile(join(l2Dir, `${b}.md`), "utf8").then((t) => t.slice(0, BUNDLE_READ_CAP), () => null)));
      const found = parts.filter((p): p is string => p !== null);
      counts.set(d.id, found.length);
      if (found.length) texts.set(d.id, found.join("\n"));
    }),
  );
  return { texts, counts };
}

/** Memory files the way memory-layers counts them (*.md, not MEMORY.md), from one readdir: no file is opened. */
export async function countMemoryFiles(memoryDir: string): Promise<number | null> {
  try {
    return (await readdir(memoryDir)).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").length;
  } catch {
    return null;
  }
}

/** "Not there" (or not a file where one was expected), as opposed to a failed read. */
export const isMissing = (err: unknown): boolean => err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "EISDIR");

/** ~/.claude/agents/*.md: frontmatter name + description; a file without usable frontmatter keeps its file name.
 *  A missing folder is simply empty; any other read error is also reported to `onError` (the
 *  caller then knows the list may be short, so e.g. the Jev cache isn't pruned from it). */
export async function scanAgents(agentsDir: string, onError?: (err: unknown) => void): Promise<AgentDef[]> {
  const report = (err: unknown): null => {
    if (!isMissing(err)) onError?.(err);
    return null;
  };
  let names: string[];
  try {
    names = (await readdir(agentsDir)).filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort();
  } catch (err) {
    report(err);
    return [];
  }
  const out = await Promise.all(
    names.map(async (n): Promise<AgentDef | null> => {
      const path = join(agentsDir, n);
      const md = await readFile(path, "utf8").then((t) => t.slice(0, AGENT_READ_CAP), report);
      if (md === null) return null;
      const meta = parseSkillFrontmatter(md);
      return { name: meta?.name ?? basename(n, ".md"), description: meta?.description ?? "", path };
    }),
  );
  return out.filter((a): a is AgentDef => a !== null);
}
