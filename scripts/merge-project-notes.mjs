#!/usr/bin/env node
/*
 * Merges the summarizers' batch results into the notes file the Projects view reads
 * (data/projects-notes.json). Each batch file is a JSON object { "<project id>": NotesV2 }.
 * Every entry is validated and clamped; an invalid entry is skipped (counted), never repaired by
 * guessing. Ids that got no new result keep their old entry, marked { stale: true }. The output
 * is written atomically (tmp + rename) and only counts are printed.
 *
 *   node scripts/merge-project-notes.mjs <batchDir> <out.json> [names.json]
 *
 * names.json ({ id: project name }, written by project-notes-evidence.mjs) maps ids to the
 * folder names the notes file is keyed by; without it ids are used as keys. <out.json> is read
 * first as the "old" notes.
 *
 * NotesV2 (one project):
 *   {
 *     "desc": string,            // <= 140 chars
 *     "longDesc": string,        // <= 500 chars
 *     "milestones": string[],    // <= 6 items, each <= 240 chars, "YYYY-MM: what shipped"
 *     "nextSteps": string[],     // <= 6 items, each <= 240 chars
 *     "started": string | null,  // "YYYY-MM" or "YYYY-MM-DD"
 *     "liveUrl": string | null,  // http(s) only
 *     "asOf": string,            // "YYYY-MM-DD", today
 *     "sources": string[]        // <= 8 short labels, e.g. "README", "git log",
 *   }                            //   "vault 20-Projects/x", "memory project_x.md"
 *
 * SUMMARIZER RULES (hand these to every summarizer agent):
 *  1. Write from the evidence file only. Do not use outside knowledge and do not guess.
 *  2. desc: at most 140 characters, present tense, says what the project is.
 *  3. longDesc: at most 500 characters, plain prose, no marketing language.
 *  4. milestones: only things that actually shipped, each with a date taken from git log or the
 *     vault ("2026-09: shipped X"). At most 6, newest first.
 *  5. nextSteps: only from the vault, memory or README todo lists. Never invent one. Empty array
 *     when the evidence has none.
 *  6. NO revenue, ARR, customer counts, firm counts, pricing or other business figures, unless
 *     quoted verbatim from a vault or memory line that labels it verified. The CURRENT note is
 *     stale: correct it from the evidence and never carry its figures over.
 *  7. liveUrl: only a URL that appears in the evidence, else null.
 *  8. started: from the earliest dated evidence (vault, README, commits), else null.
 *  9. sources: the labels of the evidence you actually used. asOf: today's date (YYYY-MM-DD).
 * 10. Never copy keys, tokens, passwords or any secret-looking string.
 * 11. Output one JSON object per batch file, { "<id>": NotesV2 }, and nothing else.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = { desc: 140, longDesc: 500, item: 240, items: 6, label: 80, labels: 8 };
const DATE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;
const FULL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const strOrNull = (v, max) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);

/** A validated NotesV2 from untrusted data, or null (with the reason in `why`). */
export function validateNotes(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { why: "not an object" };
  const desc = strOrNull(v.desc, LIMITS.desc);
  if (!desc) return { why: "desc missing or over 140 chars" };
  const longDesc = v.longDesc == null ? null : strOrNull(v.longDesc, LIMITS.longDesc);
  if (v.longDesc != null && !longDesc) return { why: "longDesc over 500 chars" };
  const list = (x, name) => {
    if (x == null) return [];
    if (!Array.isArray(x) || x.length > LIMITS.items || x.some((i) => typeof i !== "string" || !i.trim() || i.length > LIMITS.item)) throw new Error(`${name} invalid`);
    return x.map((i) => i.trim());
  };
  let milestones;
  let nextSteps;
  try {
    milestones = list(v.milestones, "milestones");
    nextSteps = list(v.nextSteps, "nextSteps");
  } catch (e) {
    return { why: e.message };
  }
  if (v.started != null && !(typeof v.started === "string" && DATE.test(v.started))) return { why: "started not a date" };
  if (v.liveUrl != null && !(typeof v.liveUrl === "string" && v.liveUrl.length <= 300 && /^https?:\/\/\S+$/i.test(v.liveUrl))) return { why: "liveUrl not http(s)" };
  if (typeof v.asOf !== "string" || !FULL_DATE.test(v.asOf)) return { why: "asOf not YYYY-MM-DD" };
  if (!Array.isArray(v.sources) || v.sources.length > LIMITS.labels || v.sources.some((s) => typeof s !== "string" || !s.trim() || s.length > LIMITS.label)) return { why: "sources invalid" };
  return { notes: { desc, longDesc, milestones, nextSteps, started: v.started ?? null, liveUrl: v.liveUrl ?? null, asOf: v.asOf, sources: v.sources.map((s) => s.trim()) } };
}

/** old (key -> entry) + fresh (id -> raw NotesV2) -> merged map and counts. Pure. */
export function mergeNotes(old, fresh, names = {}) {
  const out = {};
  const counts = { updated: 0, kept: 0, rejected: 0 };
  const seen = new Set();
  for (const [id, raw] of Object.entries(fresh)) {
    const r = validateNotes(raw);
    if (!r.notes) {
      counts.rejected += 1;
      continue;
    }
    const key = names[id] ?? id;
    out[key] = r.notes;
    seen.add(key.toLowerCase());
    counts.updated += 1;
  }
  for (const [key, entry] of Object.entries(old)) {
    if (seen.has(key.toLowerCase()) || typeof entry !== "object" || entry === null) continue;
    out[key] = { ...entry, stale: true };
    counts.kept += 1;
  }
  return { out, counts };
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [dir, outArg, namesArg] = process.argv.slice(2);
  if (!dir || !outArg) {
    console.error("usage: merge-project-notes.mjs <batchDir> <out.json> [names.json]");
    process.exit(2);
  }
  const out = resolve(outArg);
  const fresh = {};
  let unreadable = 0;
  for (const f of readdirSync(dir).filter((x) => /^batch.*\.json$/i.test(x) || /^\d+\.json$/.test(x)).sort()) {
    const j = readJson(join(dir, f), null);
    if (typeof j !== "object" || j === null || Array.isArray(j)) unreadable += 1;
    else Object.assign(fresh, j);
  }
  const old = readJson(out, {});
  const { out: merged, counts } = mergeNotes(typeof old === "object" && old !== null && !Array.isArray(old) ? old : {}, fresh, namesArg ? readJson(resolve(namesArg), {}) : {});
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 1));
  renameSync(tmp, out);
  console.log(`merged: ${counts.updated} updated, ${counts.kept} kept stale, ${counts.rejected} rejected, ${unreadable} unreadable batch files`);
}
