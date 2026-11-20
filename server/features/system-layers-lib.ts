// Pure helpers for the layered System map (system-layers.ts): skill categories, conduct-case and
// wikilink counting, schedule status, hosted-connector grouping. No IO; unit-tested in
// system-layers-lib.test.ts under server/test.

import type { SystemStatus } from "../../shared/features/system.js";

export const SKILL_CATEGORIES = ["Engineering", "Orchestration", "Legal", "Design and video", "Growth and GTM", "Research and scraping", "Content and writing", "Security and safety", "Project management", "Meta and self-maintenance", "Personal", "Other"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** First match wins; tried on the skill's name, then on its description. Order matters (specific first). */
const RULES: ReadonlyArray<readonly [SkillCategory, RegExp]> = [
  ["Legal", /\b(legal|law|lawyer|contract|clause|arbitration|divorce|irac|oral-argument|drafting|privacy-policy|citation|statute|gdpr|compliance)\b|acme-lab|lawvable/i],
  ["Security and safety", /\b(security|cso|careful|guard|freeze|defence|defense|injection|secret|audit-trail)\b/i],
  ["Design and video", /\b(design|taste|figma|video|hyperframes|animation|visual|pdf|pptx|deck|artifact|illustration|image|minimalist|ascii|brand)\b/i],
  ["Growth and GTM", /\b(growth|gtm|outbound|lead|leadgen|linkedin|sales|cold-email|seo|aeo|crm|pricing|campaign|competitor|otterly|apollo|cio|acme-(blog|aeo|competitor)|plg|x-post|referral)\b/i],
  ["Research and scraping", /\b(research|scrape|scraper|crawl|firecrawl|search|browse|last30days|transcript|gov-data|scout|deep-research|cloak-browser)\b/i],
  ["Orchestration", /\b(plan|planning|autoplan|goap|chain|orchestrat|agent|agents|fleet|yalla|monster|council|route|router|pick-model|escalate|hermes|loop|workflow|dispatch)\b/i],
  ["Project management", /\b(linear|ticket|board|kpi|retro|todo|tasks?|billable|req-checklist|spec|prd|cs-|go|rev|done)\b/i],
  ["Meta and self-maintenance", /\b(skill|skills|memory|upskill|learn|calibration|compress|capabilities|remember|resume|save-session|context|metric|replay-eval|darwin|protocol|plan-tune|skillify)\b/i],
  ["Content and writing", /\b(write|writing|blog|post|humanizer|caveman|draft|copy|newsletter|content|docs?|voice|translate)\b/i],
  ["Engineering", /\b(review|qa|ship|deploy|canary|benchmark|test|tdd|debug|investigate|refactor|code|build|cli|devex|release|land|setup|document-release|eng|pr-agent|boris|zoom-out|btw)\b/i],
  ["Personal", /\b(health|networth|daily|morning|brief|inbox|calendar|whats-up|aleph|donna|family|find-my-face|recap|peter)\b/i],
];

/** One category per skill, by keywords in its name then description. Pure. */
export function categorizeSkill(name: string, description = ""): SkillCategory {
  for (const hay of [name.replace(/[_:]/g, "-"), description]) {
    if (!hay) continue;
    for (const [cat, re] of RULES) if (re.test(hay)) return cat;
  }
  return "Other";
}

/** Counts per category, biggest first; "Other" always last. Empty categories are dropped. */
export function categoryCounts(skills: ReadonlyArray<{ name: string; description?: string }>): Array<{ name: SkillCategory; count: number }> {
  const m = new Map<SkillCategory, number>();
  for (const s of skills) {
    const c = categorizeSkill(s.name, s.description);
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name === "Other" ? 1 : b.name === "Other" ? -1 : b.count - a.count || a.name.localeCompare(b.name)));
}

/** Pulls `description:` out of SKILL.md frontmatter (first 40 lines; inline, or a folded/literal block). */
export function skillDescription(md: string): string {
  const head = md.split("\n").slice(0, 40);
  if (head[0]?.trim() !== "---") return "";
  const rest = head.slice(1);
  const end = rest.findIndex((l) => l.trim() === "---");
  const fm = end === -1 ? rest : rest.slice(0, end);
  const i = fm.findIndex((l) => /^description:/.test(l));
  if (i === -1) return "";
  let text = (fm[i] ?? "").replace(/^description:\s*/, "");
  if (/^[>|][+-]?$/.test(text) || text === "") {
    const block: string[] = [];
    for (const l of fm.slice(i + 1)) if (/^\s+\S/.test(l)) block.push(l.trim());
    else break;
    text = block.join(" ");
  }
  return text.replace(/^["']|["']$/g, "").trim().slice(0, 300);
}

/** Number of `### Case N` headings in the conduct eval file. */
export function countConductCases(md: string): number {
  return (md.match(/^###\s+Case\s+\d+/gim) ?? []).length;
}

/** Number of `# Layer N` headings (the constitution's layers) in a CLAUDE.md. */
export function countConstitutionLayers(md: string): number {
  return new Set([...md.matchAll(/^#{1,3}\s+Layer\s+(\d+)\b/gim)].map((m) => m[1])).size;
}

/** `[[target]]` / `[[target|alias]]` links in one note's text (not counting ones inside code fences). */
export function countWikilinks(md: string): number {
  return (md.replace(/```[\s\S]*?```/g, "").match(/\[\[[^\]\n]+\]\]/g) ?? []).length;
}

/** Today's route cards from the jsonl: lines whose `ts` falls on or after `startMs`. Bad lines are skipped. */
export function countSince(jsonl: string, startMs: number): { today: number; total: number } {
  let today = 0;
  let total = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ts = (JSON.parse(line) as { ts?: unknown }).ts;
      total += 1;
      if (typeof ts === "string" && Date.parse(ts) >= startMs) today += 1;
    } catch {
      /* a half-written last line */
    }
  }
  return { today, total };
}

/** A scheduled job's dot: not loaded warn, nonzero last exit bad, loaded and clean ok, unread unknown. */
export function jobStatus(loaded: boolean | null, lastExit: number | null): SystemStatus {
  if (loaded === null) return "unknown";
  if (loaded === false) return "warn";
  if (lastExit !== null && lastExit !== 0) return lastExit > 0 && lastExit < 128 ? "warn" : "bad";
  return "ok";
}

const HOSTED_GROUPS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Work", /linear|hubspot|posthog|microsoft|sharepoint|slack|asana|jira|atlassian/i],
  ["Comms and docs", /gmail|calendar|drive|notion|wispr|docs|mail|outlook|zoom/i],
  ["Build and infra", /examplevendor|figma|cloudflare|vercel|github|supabase|remote/i],
  ["Money and media", /stripe|higgsfield|intuit|quickbooks|mailchimp/i],
  ["Research and legal", /linkup|clay|legal|apollo|crunchbase/i],
];

/** Which group a hosted `claude.ai <Name>` connector goes in. */
export function hostedGroup(name: string): string {
  for (const [g, re] of HOSTED_GROUPS) if (re.test(name)) return g;
  return "Other";
}

/** "claude.ai Google Calendar" → "Google Calendar". */
export const hostedLabel = (name: string): string => name.replace(/^claude\.ai\s+/i, "");

/** Short plugin name: "legal@knowledge-work-plugins" → "legal". */
export const pluginLabel = (key: string): string => key.split("@")[0] ?? key;
