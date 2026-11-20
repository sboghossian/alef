// Path validation for "Open in editor" on a skill or candidate SKILL.md. The generic
// /api/open-editor/:agentId route (server/features/open-editor.ts) only opens a known
// session's cwd; this is the file-scoped variant the task calls for — it only ever opens a
// file named exactly "SKILL.md", and only when it resolves (lexically AND after realpath,
// via safe-path.ts) inside one of the caller-supplied allowed roots. Reused by the
// Candidates tab (the read-only queue's one allowed action) — see docs/FEATURES.md's
// "Minimal Impact" framing: everything else in that tab is view-only.

import { basename } from "node:path";
import { resolveInside, safePathStatus, type SafeResolve } from "./safe-path.js";

export type OpenSkillPathResult = { ok: true; abs: string } | { ok: false; status: number; error: string };

/** First allowed root that contains `requestedPath`, realpath-checked; "secret" never falls
 *  through to a looser answer (same policy as shelf.ts's resolveAllowed). */
async function resolveAllowed(roots: readonly string[], requestedPath: string): Promise<SafeResolve> {
  let worst: SafeResolve = { ok: false, error: "outside-root" };
  for (const root of roots) {
    const r = await resolveInside(root, requestedPath, { allowAbsolute: true });
    if (r.ok) return r;
    if (r.error === "secret") return r;
    if (r.error === "not-found" && requestedPath.startsWith(`${root}/`)) worst = r;
  }
  return worst;
}

/** Validates and resolves a "path" request body for POST /api/skills/open-editor. Only ever
 *  accepts a file literally named SKILL.md inside one of `roots`. */
export async function resolveSkillMdPath(roots: readonly string[], requestedPath: unknown): Promise<OpenSkillPathResult> {
  if (typeof requestedPath !== "string" || !requestedPath.startsWith("/") || requestedPath.includes("\0") || requestedPath.length > 2048) {
    return { ok: false, status: 400, error: "absolute path required" };
  }
  if (basename(requestedPath) !== "SKILL.md") return { ok: false, status: 400, error: "only a SKILL.md file may be opened" };
  const resolved = await resolveAllowed(roots, requestedPath);
  if (!resolved.ok) return { ok: false, status: safePathStatus(resolved.error), error: resolved.error };
  return { ok: true, abs: resolved.abs };
}
