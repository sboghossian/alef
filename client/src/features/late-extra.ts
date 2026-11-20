// State a feature used to read from WorldSnapshot.extras and now fetches from its own GET route:
// per-session maps (crew windows, job verdicts, agent states) that grow with every session ever
// indexed and made /api/world and every WS snapshot hundreds of KB heavier. The feature calls
// refresh() where it used to read the extra (onSnapshot: boot and every mid-session snapshot) and
// routes its WS pushes through push(), so a push that lands while the GET is in flight is never
// undone by the GET's older answer:
//   - "merge" pushes (changed rows only) are applied at once and again after the GET's answer;
//   - "replace" pushes (the whole state) make the in-flight answer moot, so it is dropped.
// DOM- and THREE-free.

export type PushKind = "merge" | "replace";

export interface LateExtra {
  /** Fetch the whole state again; its answer is applied unless a newer refresh or a replace push beat it. */
  refresh(): void;
  /** Apply a WS push now, and keep it in order relative to an in-flight refresh. */
  push(kind: PushKind, apply: () => void): void;
}

export function lateExtra<T>(load: () => Promise<T | null>, onLoad: (value: T) => void): LateExtra {
  let flight = 0;
  /** Merge pushes seen while the current refresh is in flight; null when none is. */
  let replay: Array<() => void> | null = null;
  return {
    refresh() {
      const mine = ++flight;
      replay = [];
      void load().then((value) => {
        if (mine !== flight) return;
        const queued = replay;
        replay = null;
        if (queued === null) return; // a replace push already carried a newer whole state
        if (value !== null) onLoad(value);
        for (const apply of queued) apply();
      });
    },
    push(kind, apply) {
      apply();
      if (replay === null) return;
      if (kind === "replace") replay = null;
      else replay.push(apply);
    },
  };
}
