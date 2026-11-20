// Global test setup: points ALEF_DISPATCH_DIR at a scratch mkdtemp for the run, so any test that
// exercises the real writeDispatchPromptFile (talk.test.ts's POST /api/talk/dispatch,
// dispatch.test.ts, loops-launch.test.ts) writes there instead of leaking into the real
// ~/…/agent-world-dispatch — which a human may have an unconsumed prompt sitting in.
//
// Runs per test-file context (vitest gives each file its own worker-local process.env; see
// node:worker_threads' default env-copy semantics), so it's safe under any pool. The nested
// "agent-world-dispatch" leaf keeps the directory's basename identical to production, so existing
// assertions matching `.../agent-world-dispatch/<uuid>.txt` still hold.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

let root: string | null = null;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-world-dispatch-test-"));
  process.env.ALEF_DISPATCH_DIR = join(root, "agent-world-dispatch");
});

afterAll(async () => {
  delete process.env.ALEF_DISPATCH_DIR;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});
