// Worker-thread entry for brain-jobs.ts: posts "ready" once its imports have loaded, then answers
// one { id, job } message at a time with { id, ok, result } or { id, ok: false, error }.

import { parentPort } from "node:worker_threads";
import { runBrainJob, type BrainJob } from "./brain-jobs.js";

const port = parentPort;
if (port) {
  port.on("message", (msg: { id: number; job: BrainJob }) => {
    runBrainJob(msg.job).then(
      (result) => port.postMessage({ id: msg.id, ok: true, result }),
      (err: unknown) => port.postMessage({ id: msg.id, ok: false, error: String(err) }),
    );
  });
  port.postMessage({ ready: true });
}
