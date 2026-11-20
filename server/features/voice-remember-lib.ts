// "Remember that…" (ported from Aleph's memory write-back): Alef proposes a short note, reads it
// back, and only after a spoken "yes" does the client POST it to /api/voice/remember, which appends
// it to ONE staging note in Alef's data folder. Nothing here writes into the memory files: he
// promotes a staged note himself. A note that looks like it holds a credential is never staged
// (the same credential rules that close files, plus the spoken-token redactor), so a secret cannot
// reach a git-tracked note by voice.

import { VOICE_REMEMBER_MAX_BODY, VOICE_REMEMBER_MAX_TITLE } from "../../shared/features/voice-brain.js";
import { isSecretShaped, scanText } from "./credential-scan-lib.js";
import { redactSpoken } from "./voice-brain-recall-lib.js";

export const STAGING_FILE = "voice-memory-staging.md";
export const REMEMBER_CREDENTIAL = "That sounds like a password or a code, sir. I never write those into notes.";

export type MemoryNoteCheck = { ok: true; note: { title: string; body: string } } | { ok: false; text: string };

function flat(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** True when a note's text must not be written: a credential rule fires on it, the spoken-token
 *  redactor would change it, or one of its words is shaped like a secret ("hunter22", "Xy7!abcd"). */
export function holdsCredential(text: string): boolean {
  if (scanText(text, STAGING_FILE).reasons.length > 0) return true;
  if (redactSpoken(text) !== text) return true;
  return text.split(/\s+/).some((w) => isSecretShaped(w));
}

/** Validates a proposed (or posted) note. The same check runs on the proposal and on the write. */
export function checkMemoryNote(title: unknown, body: unknown): MemoryNoteCheck {
  const b = flat(body);
  if (!b) return { ok: false, text: "What would you like me to remember, sir?" };
  if (b.length > VOICE_REMEMBER_MAX_BODY) return { ok: false, text: "That's rather long for a note, sir. Give me the gist." };
  const t = (flat(title) || b.split(" ").slice(0, 6).join(" ")).slice(0, VOICE_REMEMBER_MAX_TITLE).replace(/[[\]#]/g, "");
  if (holdsCredential(`${t}\n${b}`)) return { ok: false, text: REMEMBER_CREDENTIAL };
  return { ok: true, note: { title: t, body: b } };
}

/** One staged note, appended to the staging file as its own markdown section. */
export function stagingEntry(note: { title: string; body: string }, at: Date): string {
  return `\n## ${note.title}\n\n_staged by Alef (voice) ${at.toISOString()}; not in memory until you move it_\n\n${note.body}\n`;
}
