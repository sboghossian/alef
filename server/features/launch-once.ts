// One launch per click, even when the click arrives twice. A double-click inside the ~2s a launch
// takes (tmux + osascript + the startup-dialog watch) used to start two sessions. LaunchOnce keys
// each launch (a proposal id, a loops item, a dispatch's city + prompt, a resumed agent): a second
// request while the first is in flight waits for it and gets the same answer, and a second request
// within LAUNCH_REPEAT_WINDOW_MS after it succeeded gets the same session back (reused: true)
// instead of a new one. Failures are never remembered, so a retry after a failure really retries.

import { LAUNCH_REPEAT_WINDOW_MS } from "../../shared/features/talk.js";

export interface LaunchOnce {
  run<T extends { ok: boolean }>(key: string, launch: () => Promise<T>): Promise<T & { reused?: boolean }>;
}

export function createLaunchOnce(now: () => number = Date.now, windowMs = LAUNCH_REPEAT_WINDOW_MS): LaunchOnce {
  const inFlight = new Map<string, Promise<{ ok: boolean }>>();
  const done = new Map<string, { at: number; result: { ok: boolean } }>();
  return {
    async run<T extends { ok: boolean }>(key: string, launch: () => Promise<T>): Promise<T & { reused?: boolean }> {
      for (const [k, v] of done) if (now() - v.at >= windowMs) done.delete(k);
      const recent = done.get(key);
      if (recent) return { ...(recent.result as T), reused: true };
      const pending = inFlight.get(key);
      if (pending) return { ...((await pending) as T), reused: true };
      const p = launch();
      inFlight.set(key, p);
      try {
        const result = await p;
        if (result.ok) done.set(key, { at: now(), result });
        return result;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
