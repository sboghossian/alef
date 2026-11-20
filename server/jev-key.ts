// Where the Jev (TypeSafe) key comes from at server boot. Every Jev caller (director, president,
// router, council, topics, …) reads process.env.TYPESAFE_API_KEY, so boot resolves it once and puts
// it there: (1) the server's own environment, else (2) ~/.config/brain-server/.env, the file Jev's
// other tools already use. That file is parsed as plain KEY=VALUE lines (never sourced, never
// evaluated). The macOS Keychain is not tried: no Keychain service name for this key exists
// anywhere in the code or docs, and guessing one would only add a silent failure mode.
// The key's value is never logged and never leaves this module except into process.env; Health's
// "jev-key" check reads only which sources were tried and which one won.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TYPESAFE_KEY_NAME = "TYPESAFE_API_KEY";

export type JevKeySourceId = "env" | "brain-server-env";

export interface JevKeyAttempt {
  source: JevKeySourceId;
  /** Human label, e.g. "server env" or "~/.config/brain-server/.env". */
  label: string;
  outcome: "found" | "not-set" | "no-file" | "unreadable" | "no-key";
}

export interface JevKeyResolution {
  /** The source the key came from, null when none had it. */
  source: JevKeySourceId | null;
  /** Every source looked at, in order (the search stops at the first that has the key). */
  tried: JevKeyAttempt[];
}

export const BRAIN_SERVER_ENV_LABEL = "~/.config/brain-server/.env";

/** KEY=VALUE lines the way a dotenv file writes them: `#` comments and blank lines skipped, an
 *  optional `export ` prefix, one pair of matching surrounding quotes stripped. Nothing is
 *  expanded or evaluated: `$X` and backticks stay literal text. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (!out.has(m[1]!)) out.set(m[1]!, value);
  }
  return out;
}

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  readFile?: (path: string) => string;
}

/** Finds the key without touching process.env. The caller decides what to do with `key`. */
export function resolveTypesafeKey(deps: ResolveDeps): { key: string | null; resolution: JevKeyResolution } {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const tried: JevKeyAttempt[] = [];
  const fromEnv = deps.env[TYPESAFE_KEY_NAME]?.trim();
  if (fromEnv) {
    tried.push({ source: "env", label: "server env", outcome: "found" });
    return { key: fromEnv, resolution: { source: "env", tried } };
  }
  tried.push({ source: "env", label: "server env", outcome: "not-set" });

  let text: string | null = null;
  try {
    text = read(join(deps.home, ".config", "brain-server", ".env"));
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    tried.push({ source: "brain-server-env", label: BRAIN_SERVER_ENV_LABEL, outcome: code === "ENOENT" ? "no-file" : "unreadable" });
  }
  if (text !== null) {
    const fromFile = parseEnvFile(text).get(TYPESAFE_KEY_NAME)?.trim();
    if (fromFile) {
      tried.push({ source: "brain-server-env", label: BRAIN_SERVER_ENV_LABEL, outcome: "found" });
      return { key: fromFile, resolution: { source: "brain-server-env", tried } };
    }
    tried.push({ source: "brain-server-env", label: BRAIN_SERVER_ENV_LABEL, outcome: "no-key" });
  }
  return { key: null, resolution: { source: null, tried } };
}

let bootResolution: JevKeyResolution | null = null;

/** Boot only (server/index.ts's main): resolves the key and, when a file had it, sets
 *  process.env.TYPESAFE_API_KEY so every existing reader sees it. Never logs the value. */
export function loadTypesafeKeyAtBoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): JevKeyResolution {
  const { key, resolution } = resolveTypesafeKey({ env, home });
  if (key && resolution.source !== "env") env[TYPESAFE_KEY_NAME] = key;
  bootResolution = resolution;
  return resolution;
}

/** What boot found, or null when boot never resolved it (tests, or a server started as a library). */
export function currentJevKeyResolution(): JevKeyResolution | null {
  return bootResolution;
}

/** Test-only. */
export function setJevKeyResolutionForTests(r: JevKeyResolution | null): void {
  bootResolution = r;
}

const OUTCOME_TEXT: Readonly<Record<JevKeyAttempt["outcome"], string>> = {
  found: "found",
  "not-set": "not set",
  "no-file": "no such file",
  unreadable: "unreadable",
  "no-key": `no ${TYPESAFE_KEY_NAME} line`,
};

/** "server env: not set; ~/.config/brain-server/.env: found" — names and outcomes only, never a value. */
export function describeAttempts(tried: readonly JevKeyAttempt[]): string {
  return tried.map((t) => `${t.label}: ${OUTCOME_TEXT[t.outcome]}`).join("; ");
}
