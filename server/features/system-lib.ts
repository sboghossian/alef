// Pure helpers for the "system" feature (🧭 System view): per-source timeouts that turn into
// "unknown" instead of hanging, the status rules, redaction. No IO; unit-tested in system-lib.test.ts.

import { REDACTED_TEXT, type LayerItem, type SystemLayers, type SystemNode, type SystemPlane, type SystemResponse, type SystemStatus } from "../../shared/features/system.js";

export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs one source with its own deadline. Never rejects: a throw or a timeout is `{ ok: false }`.
 *  The loser keeps running (a stuck read can't be cancelled) but nothing waits on it. */
export async function settle<T>(fn: () => Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `took over ${Math.round(ms)} ms` }), ms);
  });
  const run = (async (): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: failureText(err) };
    }
  })();
  try {
    return await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Why a source failed, safe to show: V8's JSON.parse message quotes a slice of the input (a
 *  settings.json env value, say), so a SyntaxError says only that; an fs/exec error gives its code,
 *  not its message (which carries the absolute path). */
export function failureText(err: unknown): string {
  if (err instanceof SyntaxError) return "not valid JSON";
  const code = err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : null;
  return (code ?? String(err instanceof Error ? err.message : err)).slice(0, 160);
}

const RANK: Readonly<Record<SystemStatus, number>> = { unknown: 0, ok: 1, warn: 2, bad: 3 };

/** Worst of the statuses; "unknown" only when every one is unknown (or there are none). */
export function worstStatus(list: readonly SystemStatus[]): SystemStatus {
  let worst: SystemStatus = "unknown";
  for (const s of list) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

/** up of total: all up is ok, at least 80% warn, below that bad; nothing to count is unknown. */
export function statusFromRatio(up: number, total: number): SystemStatus {
  if (total <= 0) return "unknown";
  if (up >= total) return "ok";
  return up / total >= 0.8 ? "warn" : "bad";
}

/** How old a thing may be: under warnMs ok, under badMs warn, else bad; no date is unknown. */
export function ageStatus(ageMs: number | null, warnMs: number, badMs: number): SystemStatus {
  if (ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  if (ageMs < warnMs) return "ok";
  return ageMs < badMs ? "warn" : "bad";
}

/** 1-minute load per core: under 0.7 ok, under 1.5 warn, else bad. */
export function loadStatus(load1: number, cpus: number): SystemStatus {
  if (!Number.isFinite(load1) || cpus <= 0) return "unknown";
  const per = load1 / cpus;
  return per < 0.7 ? "ok" : per < 1.5 ? "warn" : "bad";
}

export function ageText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "unknown";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  return d > 0 ? `${d} d ${h} h` : `${h} h ${Math.floor((sec % 3600) / 60)} min`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A node whose source did not answer: grey, with the reason as its only fact. */
export function unknownNode(base: Pick<SystemNode, "id" | "plane" | "label" | "source">, why: string): SystemNode {
  return { ...base, value: "unknown", status: "unknown", facts: [{ label: "Why unknown", value: why, private: true }] };
}

export function makePlane(id: SystemPlane["id"], name: string, emoji: string, nodes: SystemNode[]): SystemPlane {
  return { id, name, emoji, status: worstStatus(nodes.map((n) => n.status)), nodes };
}

/** A copy with every private fact's value (hostnames, paths) replaced; counts and statuses stay real. */
const redactItem = (i: LayerItem): LayerItem => ({
  ...i,
  ...(i.private ? { label: REDACTED_TEXT, sub: undefined } : {}),
  facts: i.facts.map((x) => (x.private ? { label: x.label, value: REDACTED_TEXT, private: true } : x)),
});

function redactLayers(l: SystemLayers): SystemLayers {
  const m = (a: LayerItem[]): LayerItem[] => a.map(redactItem);
  const e = l.engine;
  return {
    prompt: m(l.prompt),
    machines: { ...l.machines, items: m(l.machines.items) },
    guardrails: m(l.guardrails),
    engine: { ...e, model: redactItem(e.model), runtimes: m(e.runtimes), fleet: m(e.fleet), judgment: m(e.judgment), chips: m(e.chips), steps: m(e.steps) },
    memory: m(l.memory),
    skills: { total: redactItem(l.skills.total), categories: m(l.skills.categories), recent: m(l.skills.recent) },
    jobs: m(l.jobs),
    live: m(l.live),
    mcp: l.mcp.map((g) => ({ ...g, items: m(g.items) })),
    outputs: m(l.outputs),
  };
}

export function redactSystem(r: SystemResponse): SystemResponse {
  return {
    ...r,
    ...(r.layers ? { layers: redactLayers(r.layers) } : {}),
    planes: r.planes.map((p) => ({
      ...p,
      nodes: p.nodes.map((n) => ({ ...n, facts: n.facts.map((f) => (f.private ? { label: f.label, value: REDACTED_TEXT, private: true } : f)) })),
    })),
  };
}
