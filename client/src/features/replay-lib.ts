// Pure, DOM-free helpers for the "replay" client feature: local date-key formatting
// (matches the server's heuristics.ts localDateKey — duplicated here since it's a
// server-only module and this is a 3-line calendar computation, not worth a shared import
// across the client/server boundary), hour bucketing for the heatmap, and its color curve.

export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 24-length array, index = local hour, value = event count in that hour. */
export function bucketByHour(events: ReadonlyArray<{ at: string }>): number[] {
  const buckets = new Array(24).fill(0) as number[];
  for (const e of events) {
    const h = new Date(e.at).getHours();
    if (h >= 0 && h < 24) buckets[h] = (buckets[h] ?? 0) + 1;
  }
  return buckets;
}

/** 0..1 heat, sqrt-curved so a couple of very busy hours don't wash out the rest
 *  (GitHub's own heatmap uses a similar non-linear bucketing for the same reason). */
export function heatIntensity(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  return Math.sqrt(count / max);
}

/** The panel's status line: distinguishes a real empty day from a fetch that never answered.
 *  `getJson` resolves `null` on any network/HTTP/parse failure, which used to render exactly
 *  like "no activity that day" — a quiet day and a broken request looked identical. */
export type ReplayLoadState = { kind: "loading" } | { kind: "error"; date: string } | { kind: "empty" } | { kind: "events"; count: number; sampled: boolean };

export function replayLoadState(loading: boolean, date: string, response: { events: readonly unknown[]; truncated: boolean } | null): ReplayLoadState {
  if (loading) return { kind: "loading" };
  if (response === null) return { kind: "error", date };
  if (response.events.length === 0) return { kind: "empty" };
  return { kind: "events", count: response.events.length, sampled: response.truncated };
}

export function replayStatusText(state: ReplayLoadState): string {
  switch (state.kind) {
    case "loading":
      return "Loading…"; // shown in the same status span the error/empty/count states use
    case "error":
      return `Couldn't load ${state.date}: the server didn't answer.`;
    case "empty":
      return "No activity that day.";
    case "events":
      return `${state.count} events${state.sampled ? " (sampled)" : ""}`;
  }
}
