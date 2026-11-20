// Tiny helpers the loop-governance scripts share: argv flags, stdout output (the scripts' result;
// diagnostics go through server/log.ts to stderr) and a guard so a test can import a script's
// exported functions without running its main().

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The value after `--name`, or null when the flag is absent or has no value. */
export function argValue(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v !== undefined && !v.startsWith("--") ? v : null;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

export function out(text: string): void {
  process.stdout.write(text);
}

/** True when the module at `metaUrl` is the file node/tsx was started with. */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === metaUrl;
  } catch {
    return false;
  }
}
