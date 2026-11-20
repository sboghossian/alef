#!/usr/bin/env node
// PRINTS the settings.json diff that registers hooks/permission-request.mjs as a PermissionRequest
// hook (matcher "", timeout 70). Writes NOTHING unless run with --apply, and even then backs up
// settings.json first (settings.json.bak-<timestamp>). Health's "Install (preview diff)" button
// makes the same change through GET/POST /api/completeness/approvals-hook/install
// (server/features/approvals-hook-install.ts). See hooks/install.md.
//
// Usage:
//   node scripts/install-approvals-hook.mjs            # dry run: prints the diff only
//   node scripts/install-approvals-hook.mjs --apply    # backs up, then writes it for real

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");

const hookPath = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "permission-request.mjs"));
// The PATH symlink (e.g. /opt/homebrew/bin/node) survives upgrades; process.execPath points into a versioned Cellar dir.
const nodePath =
  (process.env.PATH ?? "").split(delimiter).map((d) => join(d, "node")).find((p) => p.startsWith("/") && existsSync(p)) ?? process.execPath;
const q = (s) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const settingsPath = join(homedir(), ".claude", "settings.json");

function newHookEntry() {
  return { matcher: "", hooks: [{ type: "command", command: `${q(nodePath)} ${q(hookPath)}`, timeout: 70 }] };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Same minimal line diff as scripts/install-jev-router-hook.mjs: shared prefix/suffix, the
 *  differing middle, two lines of context. */
function printLineDiff(beforeText, afterText) {
  const before = beforeText === "" ? [] : beforeText.split("\n");
  const after = afterText.split("\n");
  const context = 2;

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;

  let endB = before.length - 1;
  let endA = after.length - 1;
  while (endB >= start && endA >= start && before[endB] === after[endA]) {
    endB -= 1;
    endA -= 1;
  }

  const ctxStart = Math.max(0, start - context);
  for (let i = ctxStart; i < start; i += 1) console.log(`  ${before[i]}`);
  for (let i = start; i <= endB; i += 1) console.log(`- ${before[i]}`);
  for (let i = start; i <= endA; i += 1) console.log(`+ ${after[i]}`);
  const ctxEnd = Math.min(before.length, endB + 1 + context);
  for (let i = endB + 1; i < ctxEnd; i += 1) console.log(`  ${before[i]}`);
}

function main() {
  const exists = existsSync(settingsPath);
  const rawBefore = exists ? readFileSync(settingsPath, "utf8") : "";
  let settings = {};
  if (exists) {
    try {
      settings = JSON.parse(rawBefore);
    } catch (err) {
      console.error(`Could not parse ${settingsPath} as JSON: ${String(err)}. Nothing written.`);
      process.exitCode = 1;
      return;
    }
    if (!isObject(settings)) {
      console.error(`${settingsPath} isn't a JSON object. Nothing written.`);
      process.exitCode = 1;
      return;
    }
  }

  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const list = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
  const already = list.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.includes(hookPath)));
  if (already) {
    console.log("hooks.PermissionRequest already runs this repo's permission-request.mjs — nothing to do.");
    return;
  }

  const updated = { ...settings, hooks: { ...hooks, PermissionRequest: [...list, newHookEntry()] } };
  const rawAfter = `${JSON.stringify(updated, null, 2)}\n`;

  console.log(`# ${settingsPath}${exists ? "" : " (does not exist yet: it will be created)"}`);
  console.log(APPLY ? "# Applying this diff now (a timestamped backup is written first)." : "# Dry run — nothing written. Re-run with --apply to install it for real.");
  console.log("");
  printLineDiff(rawBefore, rawAfter);

  if (!APPLY) return;

  if (exists) {
    const backupPath = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    writeFileSync(backupPath, rawBefore, "utf8");
    console.log("");
    console.log(`# Backed up the previous settings.json to ${backupPath}`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  writeFileSync(settingsPath, rawAfter, "utf8");
  console.log(`# Wrote the updated hooks.PermissionRequest to ${settingsPath}`);
  console.log("# Remove the entry to uninstall; the world's header toggle turns it off without editing.");
}

main();
