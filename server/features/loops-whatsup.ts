// Read-only reader for whatsup's machine-readable board:
//   ~/Documents/Code/alex_claude/60-Meta/dashboards/todos.json
// (next to the human-editable TODOS.md, confirmed by reading whatsup's build.py/SPEC.md —
// `build_model()` writes both from the same `model`). whatsup is READ-ONLY from here: this
// module never writes to that file, never runs build.py, and never touches the vault.
//
// The file is Alex's own local aggregator output, but still external, generated data —
// parsed defensively so a schema change or a mid-write partial file degrades to "whatsupOk:
// false" instead of throwing.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../http.js";
import { vaultRoot } from "../config.js";

export const DEFAULT_WHATSUP_TODOS_JSON = join(vaultRoot(), "60-Meta", "dashboards", "todos.json");

/** The lenses whatsup itself assigns (SPEC.md); "unranked" only ever comes from Alef's own scan. */
const WHATSUP_LENSES = new Set(["do_today", "high_leverage", "one_step", "waiting"]);
export type WhatsupLens = "do_today" | "high_leverage" | "one_step" | "waiting";

export interface WhatsupItem {
  id: string;
  task: string;
  project: string;
  lens: WhatsupLens;
  score: number;
  sourceType: string;
  /** Absolute file path for todo_md/vault/memory/memory_index items; a pseudo-ref
   *  ("linear:TICK-1140", "calendar:move_date", ...) for "live" items, or null. */
  sourceFile: string | null;
}

export interface WhatsupReadResult {
  ok: boolean;
  items: readonly WhatsupItem[];
  error: string | null;
  /** The board's own "generated" timestamp (ISO-ish, minute precision) when present. */
  generatedAt: string | null;
}

function parseItem(v: unknown): WhatsupItem | null {
  if (!isRecord(v)) return null;
  const { id, task, project, lens, score, source_type: sourceType, source_file: sourceFile } = v;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof task !== "string" || task.length === 0) return null;
  if (typeof project !== "string" || project.length === 0) return null;
  if (typeof lens !== "string" || !WHATSUP_LENSES.has(lens)) return null;
  return {
    id,
    task,
    project,
    lens: lens as WhatsupLens,
    score: typeof score === "number" && Number.isFinite(score) ? score : 0,
    sourceType: typeof sourceType === "string" && sourceType.length > 0 ? sourceType : "unknown",
    sourceFile: typeof sourceFile === "string" && sourceFile.length > 0 ? sourceFile : null,
  };
}

/** Reads and validates whatsup's todos.json. Never throws: a missing file, invalid JSON, or a
 *  shape that doesn't match the documented schema all come back as `{ ok: false, items: [] }`
 *  with `error` set, so a stale/absent whatsup run degrades the loops board instead of breaking it. */
export async function readWhatsupBoard(path: string = DEFAULT_WHATSUP_TODOS_JSON): Promise<WhatsupReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { ok: false, items: [], error: `cannot read whatsup todos.json: ${String(err)}`, generatedAt: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, items: [], error: `whatsup todos.json is not valid JSON: ${String(err)}`, generatedAt: null };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    return { ok: false, items: [], error: "whatsup todos.json is missing an items array", generatedAt: null };
  }
  const items: WhatsupItem[] = [];
  for (const raw of parsed.items) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }
  const generatedAt = typeof parsed.generated === "string" ? parsed.generated : null;
  return { ok: true, items, error: null, generatedAt };
}
