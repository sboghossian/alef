// Plain-JS entry for the brain worker thread. A worker doesn't inherit the parent's tsx hooks, and
// on some Node versions `--import tsx` in its execArgv registers nothing off the main thread, so a
// .ts entry died resolving brain-worker.ts's own `./brain-jobs.js` import ("Cannot find module").
// tsImport registers tsx for this thread explicitly, so the .js -> .ts mapping works under the
// `tsx` CLI (dev, alef-live) and under vitest alike.

import { tsImport } from "tsx/esm/api";

await tsImport("./brain-worker.ts", import.meta.url);
