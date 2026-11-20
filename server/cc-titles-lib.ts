// Claude Code's own names for a session, read from its transcript: the user's /rename
// (`{"type":"custom-title","customTitle":…}`) and Claude Code's generated title
// (`{"type":"ai-title","aiTitle":…}`). Both are re-appended many times over a session's life;
// the last record of each kind wins. Pure: no I/O. The text is untrusted transcript data, so
// ccDisplayName runs it through sanitizeTitle (tags, secret-looking tokens, 80 chars) before it
// can reach any view.

import { isAutomationPrompt } from "../shared/display.js";
import { sanitizeTitle } from "./heuristics.js";
import type { ParsedLine } from "./jsonl-events.js";

export interface CcTitles {
  /** Last custom-title seen (verbatim), or null when none was seen. */
  customTitle: string | null;
  /** Last ai-title seen (verbatim), or null when none was seen. */
  aiTitle: string | null;
}

/** Folds one parsed line into `acc`: a later custom-title / ai-title record replaces an earlier one. */
export function foldCcTitles(acc: CcTitles, line: Pick<ParsedLine, "customTitle" | "aiTitle">): void {
  if (line.customTitle !== null) acc.customTitle = line.customTitle;
  if (line.aiTitle !== null) acc.aiTitle = line.aiTitle;
}

/** Cheap byte-level prefilter so a scan only JSON-parses lines that could be a title record. */
export function mayBeTitleLine(line: string): boolean {
  return line.includes('"custom-title"') || line.includes('"ai-title"');
}

const UNTITLED = sanitizeTitle("");

function usable(raw: string | null): string | null {
  if (raw === null) return null;
  const t = sanitizeTitle(raw);
  return t === UNTITLED ? null : t;
}

/**
 * The name Claude Code itself shows for a session: the user's /rename, else its AI title,
 * sanitized for display. Null when it has neither (or only blank ones): the caller then falls back
 * to displayTitle(title). A blank custom title (a cleared rename) falls through to the AI title.
 * `title` is the sanitized first prompt the client gets: when it is an automation prompt that
 * displayTitle turns into a readable name, the AI title is skipped (a /rename still wins).
 */
export function ccDisplayName(t: CcTitles, title: string): string | null {
  const custom = usable(t.customTitle);
  if (custom !== null || isAutomationPrompt(title)) return custom;
  return usable(t.aiTitle);
}
