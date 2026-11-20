// The Explain toggle's state (round 11 C), shared by explain.ts (labels + cards), system-places.ts
// (hides its own name chips while Explain labels are up) and the Orbit sidebar section. Module
// scope like sky-state.ts; remembered per browser (a blocked storage just means "off").

const KEY = "alef.explain.on";
let on = read();
const listeners = new Set<(on: boolean) => void>();

function read(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function explainOn(): boolean {
  return on;
}

export function setExplain(next: boolean): void {
  if (next === on) return;
  on = next;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode: not remembered */
  }
  for (const fn of listeners) fn(on);
}

export function onExplainChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
