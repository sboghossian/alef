// Detects skill-system events in raw session jsonl lines (untrusted transcript text —
// parsed and matched by regex, never executed or followed as instructions). Three shapes:
//
//  1. invoke    — an assistant line's `Skill` tool_use, e.g. {"type":"tool_use","name":"Skill",
//                 "input":{"skill":"grill-me"}}. Reuses jsonl-events.ts's skillFromToolUse.
//  2. slash     — a user line typed as a slash command: message.content is the plain string
//                 "<command-message>...</command-message>\n<command-name>/grill-me</command-name>\n
//                 <command-args>...</command-args>" (real shape, verified against local transcripts).
//  3. suggested — the skill-router hook's UserPromptSubmit output, which lands as its own
//                 jsonl line: {"type":"attachment","attachment":{"hookEvent":"UserPromptSubmit",
//                 "stdout":"## Skill Router\n\n...- **/slug** _(score N)_ — desc..."}}.
//                 parseLine() doesn't model "attachment" lines, so this one shape is parsed here.

import type { SkillEvent, SkillEventKind } from "../../shared/features/skills.js";
import { isRecord } from "../http.js";
import { parseLine, skillFromToolUse } from "../jsonl-events.js";

const EPOCH = new Date(0).toISOString();

// Slugs are kebab-case, optionally plugin-namespaced ("grok:grok-delegation"). Bounded length
// guards against a pathological line; the leading char must be alphanumeric.
const SLUG_BODY = "[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,100}";
const COMMAND_NAME_RE = new RegExp(`<command-name>\\s*/(${SLUG_BODY})\\s*</command-name>`);
const ROUTER_SLUG_RE = new RegExp(`\\*\\*/(${SLUG_BODY})\\*\\*`, "g");

export interface LineDetection {
  /** This line's own timestamp in ms, or null when the line is malformed or carries none —
   *  used by skills-backfill.ts to decide whether a line is before or after its cutoff.
   *  Independent of whether the line matched anything below. */
  atMs: number | null;
  events: SkillEvent[];
}

/** Detects every skill-system event on ONE raw line, plus the line's own timestamp. The live
 *  path (detectSkillEvents) only needs `.events`; the backfill path (skills-backfill.ts) also
 *  needs `.atMs` to know where to stop. A malformed line yields `{ atMs: null, events: [] }`. */
export function detectSkillEventsFromLine(sessionId: string, raw: string): LineDetection {
  const parsed = parseLine(raw);
  if (parsed === null) return { atMs: null, events: [] }; // malformed JSON

  const events: SkillEvent[] = [];
  if (parsed.isAssistant) {
    for (const use of parsed.toolUses) {
      const skill = skillFromToolUse(use);
      if (skill) events.push({ sessionId, skillName: skill, kind: "invoke", at: parsed.timestamp ?? EPOCH });
    }
  } else if (parsed.isUserText && parsed.userText) {
    const m = COMMAND_NAME_RE.exec(parsed.userText);
    if (m?.[1]) events.push({ sessionId, skillName: m[1], kind: "slash", at: parsed.timestamp ?? EPOCH });
  }

  const suggestion = routerSuggestionsFrom(raw);
  if (suggestion) for (const slug of suggestion.slugs) events.push({ sessionId, skillName: slug, kind: "suggested", at: suggestion.at });

  const atSource = parsed.timestamp ?? suggestion?.at ?? null;
  const atMs = atSource ? Date.parse(atSource) : NaN;
  return { atMs: Number.isFinite(atMs) ? atMs : null, events };
}

/** Detects every skill-system event in one session's newly-read raw lines (oldest first in,
 *  oldest first out). A malformed line is silently skipped (the indexer counts it elsewhere). */
export function detectSkillEvents(sessionId: string, lines: readonly string[]): SkillEvent[] {
  return lines.flatMap((raw) => detectSkillEventsFromLine(sessionId, raw).events);
}

/** Router-suggested slugs from one raw "attachment" line, or null when this line isn't one.
 *  Cheap substring pre-filter before the JSON.parse so ordinary lines stay fast. */
function routerSuggestionsFrom(raw: string): { slugs: string[]; at: string } | null {
  if (!raw.includes("Skill Router")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== "attachment") return null;
  const att = obj.attachment;
  if (!isRecord(att)) return null;
  const stdout = typeof att.stdout === "string" ? att.stdout : "";
  if (!stdout.includes("Skill Router")) return null;
  const slugs: string[] = [];
  for (const m of stdout.matchAll(ROUTER_SLUG_RE)) if (m[1]) slugs.push(m[1]);
  if (slugs.length === 0) return null;
  const at = typeof obj.timestamp === "string" ? obj.timestamp : EPOCH;
  return { slugs, at };
}

/** Applies detectSkillEvents across a whole onIndexPass batch, in session-then-line order. */
export function detectSkillEventsBatch(newLinesBySession: ReadonlyMap<string, readonly string[]>): SkillEvent[] {
  const out: SkillEvent[] = [];
  for (const [sessionId, lines] of newLinesBySession) out.push(...detectSkillEvents(sessionId, lines));
  return out;
}

export type { SkillEventKind };
