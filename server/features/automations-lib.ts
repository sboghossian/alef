// Pure helpers + the output map for the "automations" feature.
//
// OUTPUT_SPECS was derived by reading each skill's SKILL.md and launchd plist (2026-09-25),
// read-only: where does a run leave its human-readable result?
//   yalla-brief     → ~/Documents/Code/yalla-brief/out/yalla-brief-YYYY-MM-DD.html (SKILL.md "renders one self-contained HTML at …/out/")
//   daily-recap     → vault 60-Meta/dashboards/daily-recap-YYYY-MM-DD.html (SKILL.md step 3)
//   artifact-ritual → ~/Documents/Code/artifact-ritual/LAST_RUN.md (+ page.html; republishes one artifact URL)
//   inbox-sweep     → vault 60-Meta/inbox-sweep/YYYY-MM-DD.md (SKILL.md "Write to …")
//   ig-innovation   → ~/.claude/skills/ig-innovation/verdicts/YYYY-MM-DD.md (SKILL.md "Verdict log")

import { homedir } from "node:os";
import { join } from "node:path";
import { vaultRoot } from "../config.js";

export interface OutputSpec {
  dir: string;
  pattern: RegExp; // basename match; newest non-empty match by mtime wins
  link?: string;
}

export function outputSpecs(home = homedir()): Record<string, OutputSpec> {
  const vault = vaultRoot(home);
  return {
    "yalla-brief": { dir: join(home, "Documents", "Code", "yalla-brief", "out"), pattern: /^yalla-brief-\d{4}-\d{2}-\d{2}\.html$/ },
    "daily-recap": { dir: join(vault, "60-Meta", "dashboards"), pattern: /^daily-recap-\d{4}-\d{2}-\d{2}\.html$/ },
    "artifact-ritual": {
      dir: join(home, "Documents", "Code", "artifact-ritual"),
      pattern: /^LAST_RUN\.md$/,
      link: "https://claude.ai/artifact/C2L7vKBxACoabe9T267kuK",
    },
    "inbox-sweep": { dir: join(vault, "60-Meta", "inbox-sweep"), pattern: /^\d{4}-\d{2}-\d{2}\.md$/ },
    "ig-innovation": { dir: join(home, ".claude", "skills", "ig-innovation", "verdicts"), pattern: /^\d{4}-\d{2}-\d{2}\.md$/ },
  };
}

/** Directories the shelf preview may serve automation outputs from. */
export function automationOutputRoots(home = homedir()): string[] {
  return [...new Set(Object.values(outputSpecs(home)).map((s) => s.dir))];
}

export interface SkillMeta {
  name: string;
  description: string;
}

/** name + description from SKILL.md YAML frontmatter (plain, quoted, or `>`/`|` block scalars). */
export function parseSkillFrontmatter(md: string): SkillMeta | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!fm?.[1]) return null;
  const lines = fm[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (!m?.[1]) continue;
    const key = m[1];
    let val = (m[2] ?? "").trim();
    if (/^[>|][-+]?$/.test(val)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").length > 0) {
        block.push((lines[++i] ?? "").trim());
      }
      val = block.join(" ");
    }
    out[key] = val.replace(/^["']|["']$/g, "");
  }
  if (!out.name) return null;
  return { name: out.name, description: out.description ?? "" };
}

// A skill is an automation only when something actually schedules it. Three kinds of
// evidence, strongest first (tuned against the real ~/.claude/skills, 2026-09-25: the old
// "ritual|daily|weekly|cron" keyword match listed ordinary skills and manual rituals such as
// plg-ritual / networth / upskill, whose descriptions only *mention* a cadence or a cron):
//   1. a launchd plist runs it: its ProgramArguments name ~/.claude/skills/<name>/… or "/<name>"
//   2. a ~/.claude/scheduled-tasks/<task>/SKILL.md invokes it as "/<name>" or by skill path
//   3. its own description says a launchd/cron job fires it ("when the 09:00 launchd job
//      fires", "Fires daily 08:00 … via launchd"). A bare "ritual", "daily" or "cron" is not enough.

export type ScheduleEvidence = "launchd-plist" | "scheduled-task" | "self-described";

const FIRED_BY_SCHEDULER_RES: readonly RegExp[] = [
  /\b(?:launchd|cron)(?:\s+job)?\b(?:[^.;\n]|\.(?=\S)){0,60}\bfires\b/i, // "launchd job com.stephane.x fires at 08:00"
  /\bfires\b(?:[^.;\n]|\.(?=\S)){0,80}\b(?:via|by|from)\s+(?:launchd|cron)\b/i, // "Fires daily 08:00 Paris via launchd"
  /\b(?:runs?|scheduled|triggered|started)\b[^.;\n]{0,40}\b(?:via|by|from)\s+(?:launchd|cron)\b/i, // "Runs unattended at 08:10 via launchd"
];

/** True when a skill's own description says a scheduler (launchd / cron) fires it. */
export function isSelfDescribedScheduled(meta: SkillMeta): boolean {
  return FIRED_BY_SCHEDULER_RES.some((re) => re.test(meta.description));
}

/** Skill names (from `known`) that a plist / scheduled-task / script text invokes: a
 *  `.claude/skills/<name>` path, or a `/<name>` slash command standing on its own
 *  (quoted or space-delimited, not part of a longer path). */
export function skillRefsIn(text: string, known: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\.claude\/skills\/([a-z0-9][a-z0-9._-]{0,80})(?=[\/"'\s<]|$)/g)) {
    if (m[1] && known.has(m[1])) out.add(m[1]);
  }
  for (const m of text.matchAll(/(?:^|[\s"'`>(])\/([a-z0-9][a-z0-9-]{0,80})(?=$|[\s"'`<),.:;])/gm)) {
    if (m[1] && known.has(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

/** Why a skill counts as an automation, or null when nothing schedules it. */
export function scheduleEvidence(meta: SkillMeta, refs: { plist: boolean; scheduledTask: boolean }): ScheduleEvidence | null {
  if (refs.plist) return "launchd-plist";
  if (refs.scheduledTask) return "scheduled-task";
  if (isSelfDescribedScheduled(meta)) return "self-described";
  return null;
}

/** The cadence a skill states about itself, e.g. "daily 08:00" / "09:00" / "weekly". */
export function statedCadence(description: string): string | null {
  const time = /\b([0-2]\d:[0-5]\d)\b/.exec(description)?.[1] ?? /\b(\d{1,2})\s?a\.m\./i.exec(description)?.[1]?.padStart(2, "0")?.concat(":00") ?? null;
  const freq = /\b(daily|weekly|nightly|hourly)\b/i.exec(description)?.[1]?.toLowerCase() ?? (/\bmorning\b/i.test(description) ? "daily" : null);
  if (!time && !freq) return null;
  return [freq, time].filter(Boolean).join(" ");
}

/** launchd labels we may kickstart: com.stephane.* only (never dev.dashable.* — always-live infra). */
export function isKickstartableLabel(label: string): boolean {
  return /^com\.stephane\.[a-z0-9][a-z0-9.-]{0,80}$/.test(label);
}

export function outputKind(path: string): "html" | "markdown" | "text" | "json" {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md") return "markdown";
  if (ext === "json") return "json";
  return "text";
}
