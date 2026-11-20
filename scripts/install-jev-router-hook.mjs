#!/usr/bin/env node
// PRINTS the settings.json diff that would register hooks/jev-router.mjs as a
// UserPromptSubmit hook, right after the existing memory-recall entry
// ($HOME/.claude/hooks/prompt-memory-recall.py). Writes NOTHING unless run with --apply,
// and even then backs up settings.json first. See docs/round10-plan.md §2 and
// hooks/jev-router.mjs's own header for the contract this hook honors (advice only,
// fail-open, 2.5s budget).
//
// Usage:
//   node scripts/install-jev-router-hook.mjs            # dry run: prints the diff only
//   node scripts/install-jev-router-hook.mjs --apply     # backs up, then writes it for real

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const MARKER = "prompt-memory-recall.py"; // the entry this hook installs right after

const hookPath = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "jev-router.mjs"));
// The PATH symlink (e.g. /opt/homebrew/bin/node) survives upgrades; process.execPath points into a versioned Cellar dir.
const nodePath =
  (process.env.PATH ?? "").split(delimiter).map((d) => join(d, "node")).find((p) => p.startsWith("/") && existsSync(p)) ?? process.execPath;
const q = (s) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const settingsPath = join(homedir(), ".claude", "settings.json");

function newHookEntry() {
  return { hooks: [{ type: "command", command: `${q(nodePath)} ${q(hookPath)}`, timeout: 3 }] };
}

function isMemoryRecallEntry(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes(MARKER));
}

/** Minimal, dependency-free line diff for the case this script only ever produces: a pure
 *  insertion into an array. Finds the shared prefix/suffix and prints only the differing
 *  middle, with a few lines of context — good enough for a human to review before --apply. */
function printLineDiff(beforeText, afterText) {
  const before = beforeText.split("\n");
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
  if (!existsSync(settingsPath)) {
    console.error(`No settings.json at ${settingsPath} — nothing to diff against. Aborting.`);
    process.exitCode = 1;
    return;
  }

  const rawBefore = readFileSync(settingsPath, "utf8");
  let settings;
  try {
    settings = JSON.parse(rawBefore);
  } catch (err) {
    console.error(`Could not parse ${settingsPath} as JSON: ${String(err)}`);
    process.exitCode = 1;
    return;
  }

  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const ups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];

  const already = ups.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("jev-router.mjs")));
  if (already) {
    console.log("hooks.UserPromptSubmit already has a jev-router.mjs entry — nothing to do.");
    return;
  }

  const idx = ups.findIndex(isMemoryRecallEntry);
  const insertAt = idx === -1 ? ups.length : idx + 1;
  if (idx === -1) {
    console.log(`# Note: no "${MARKER}" entry found in hooks.UserPromptSubmit — appending at the end instead of "right after memory-recall".`);
  }

  const newUps = [...ups.slice(0, insertAt), newHookEntry(), ...ups.slice(insertAt)];
  const updated = { ...settings, hooks: { ...hooks, UserPromptSubmit: newUps } };

  const rawAfter = `${JSON.stringify(updated, null, 2)}\n`;

  console.log(`# ${settingsPath}`);
  console.log(APPLY ? "# Applying this diff now (a timestamped backup is written first)." : "# Dry run — nothing written. Re-run with --apply to install it for real.");
  console.log("");
  printLineDiff(rawBefore, rawAfter);

  if (!APPLY) return;

  const backupPath = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backupPath, rawBefore, "utf8");
  writeFileSync(settingsPath, rawAfter, "utf8");
  console.log("");
  console.log(`# Backed up the previous settings.json to ${backupPath}`);
  console.log(`# Wrote the updated hooks.UserPromptSubmit to ${settingsPath}`);
}

main();
