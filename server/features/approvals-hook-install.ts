// Health's "Install (preview diff)" for the approvals hook: the same change
// scripts/install-approvals-hook.mjs --apply makes, behind two routes in completeness.ts:
//   GET  /api/completeness/approvals-hook/install → the diff it WOULD write (writes nothing)
//   POST /api/completeness/approvals-hook/install {confirm:true} → backs settings.json up to
//        settings.json.bak-<timestamp>, then writes it with one hooks.PermissionRequest entry added.
// Nothing else in settings.json changes: the entry is appended, every other key is kept as parsed.
// A file that isn't valid JSON is refused, never overwritten. The write only ever happens on an
// explicit click in Health (the POST needs confirm:true).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { ApprovalsHookDiffLine, ApprovalsHookInstallPlan, ApprovalsHookInstallResult } from "../../shared/features/completeness.js";
import { isRecord } from "../http.js";

/** The PATH's `node` (a symlink like /opt/homebrew/bin/node survives upgrades; process.execPath
 *  points into a versioned Cellar dir), same rule as the install scripts. */
export function nodeOnPath(pathEnv: string = process.env.PATH ?? "", fallback: string = process.execPath): string {
  return pathEnv.split(delimiter).map((d) => join(d, "node")).find((p) => p.startsWith("/") && existsSync(p)) ?? fallback;
}

const shellQuote = (s: string): string => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The hook command exactly as scripts/install-approvals-hook.mjs prints it. */
export function approvalsHookCommand(nodePath: string, hookPath: string): string {
  return `${shellQuote(nodePath)} ${shellQuote(hookPath)}`;
}

/** Shared prefix/suffix, the differing middle, 2 lines of context: the same diff
 *  scripts/install-jev-router-hook.mjs prints. */
export function lineDiff(beforeText: string, afterText: string, context = 2): ApprovalsHookDiffLine[] {
  const before = beforeText === "" ? [] : beforeText.split("\n");
  const after = afterText.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length - 1;
  let endA = after.length - 1;
  while (endB >= start && endA >= start && before[endB] === after[endA]) {
    endB--;
    endA--;
  }
  const out: ApprovalsHookDiffLine[] = [];
  for (let i = Math.max(0, start - context); i < start; i++) out.push({ kind: " ", text: before[i]! });
  for (let i = start; i <= endB; i++) out.push({ kind: "-", text: before[i]! });
  for (let i = start; i <= endA; i++) out.push({ kind: "+", text: after[i]! });
  for (let i = endB + 1; i < Math.min(before.length, endB + 1 + context); i++) out.push({ kind: " ", text: before[i]! });
  return out;
}

/** What installing would do to `rawBefore` (null = no settings.json yet). Pure. `isInstalled` is
 *  the Health check's own verdict (any worktree of this repo counts), so "already" agrees with it. */
export function planApprovalsHookInstall(rawBefore: string | null, command: string, isInstalled: boolean, settingsPath: string): ApprovalsHookInstallPlan {
  if (isInstalled) return { ok: true, status: "already", settingsPath, diff: [], message: "The approvals hook is already in settings.json." };
  let settings: Record<string, unknown> = {};
  if (rawBefore !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBefore);
    } catch (err) {
      return { ok: false, status: "error", settingsPath, diff: [], message: `settings.json isn't valid JSON, so nothing will be written: ${String(err)}` };
    }
    if (!isRecord(parsed)) return { ok: false, status: "error", settingsPath, diff: [], message: "settings.json isn't a JSON object, so nothing will be written." };
    settings = parsed;
  }
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const list = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
  const entry = { matcher: "", hooks: [{ type: "command", command, timeout: 70 }] };
  const updated = { ...settings, hooks: { ...hooks, PermissionRequest: [...list, entry] } };
  const after = `${JSON.stringify(updated, null, 2)}\n`;
  return { ok: true, status: "ready", settingsPath, diff: lineDiff(rawBefore ?? "", after), after, message: rawBefore === null ? "settings.json doesn't exist yet: it will be created." : "Adds one hooks.PermissionRequest entry; a timestamped backup is written first." };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isRecord(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

export interface InstallDeps {
  settingsPath: string;
  command: string;
  /** The Health check's own reader (completeness.ts's readApprovalsHookInstalled). */
  isInstalled: () => Promise<boolean>;
  now?: () => number;
}

export async function previewApprovalsHookInstall(deps: InstallDeps): Promise<ApprovalsHookInstallPlan> {
  const raw = await readOrNull(deps.settingsPath);
  const plan = planApprovalsHookInstall(raw, deps.command, await deps.isInstalled(), deps.settingsPath);
  const shown = { ...plan };
  delete shown.after; // the full file stays server-side: the preview is the diff
  return shown;
}

/** Re-reads settings.json and re-plans (never trusts an earlier preview), backs the current file up
 *  to `<settings>.bak-<ISO timestamp>`, then writes. Refuses anything but a "ready" plan. */
export async function applyApprovalsHookInstall(deps: InstallDeps): Promise<ApprovalsHookInstallResult> {
  const raw = await readOrNull(deps.settingsPath);
  const plan = planApprovalsHookInstall(raw, deps.command, await deps.isInstalled(), deps.settingsPath);
  if (plan.status === "already") return { ok: true, status: "already", message: plan.message, backupPath: null };
  if (plan.status !== "ready" || plan.after === undefined) return { ok: false, status: "error", message: plan.message, backupPath: null, error: plan.message };
  let backupPath: string | null = null;
  if (raw !== null) {
    backupPath = `${deps.settingsPath}.bak-${new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-")}`;
    await writeFile(backupPath, raw, "utf8");
  } else {
    await mkdir(dirname(deps.settingsPath), { recursive: true });
  }
  await writeFile(deps.settingsPath, plan.after, "utf8");
  return { ok: true, status: "installed", message: backupPath ? `Installed the approvals hook. The previous settings.json is at ${backupPath}.` : "Installed the approvals hook in a new settings.json.", backupPath };
}
