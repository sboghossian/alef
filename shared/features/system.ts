// Wire types for the "system" feature (the 🧭 System view): the whole setup at a glance as one hub
// and spoke. A prompt enters at the top, runs through ONE engine (Claude Code + its harness), fans
// out to five planes (machines, guardrails, skills, memory, services) and ends as outputs.
// Every node is built from live data and carries a status; a source that is slow or unreadable
// makes ITS nodes "unknown" and nothing else.
//
//   GET /api/system            -> SystemResponse (stale-while-revalidate, 30 s)
//   GET /api/system?redact=1   -> the same with hostnames and paths replaced by "hidden"
//
// PRIVACY: names, counts, ages and statuses only. Never settings values, env, tokens or file bodies.
// Strings are untrusted display text: render with textContent.

export const SYSTEM_STATUSES = ["ok", "warn", "bad", "unknown"] as const;
export type SystemStatus = (typeof SYSTEM_STATUSES)[number];

/** Top to bottom; the five middle ones are the spokes around the engine. */
export const SYSTEM_PLANE_IDS = ["prompts", "engine", "machines", "guardrails", "skills", "memory", "services", "outputs"] as const;
export type SystemPlaneId = (typeof SYSTEM_PLANE_IDS)[number];

export interface SystemFact {
  label: string;
  value: string;
  /** A hostname or path: replaced by REDACTED_TEXT when the request asks for ?redact=1. */
  private?: boolean;
}

export interface SystemNode {
  /** "<plane>.<name>", unique. */
  id: string;
  plane: SystemPlaneId;
  label: string;
  /** One line, live. */
  value: string;
  status: SystemStatus;
  facts: SystemFact[];
  /** Where it was read from: a file, a command or an endpoint (never a value). */
  source: string;
}

export interface SystemPlane {
  id: SystemPlaneId;
  name: string;
  emoji: string;
  /** Worst status among its nodes (unknown only when every node is unknown). */
  status: SystemStatus;
  nodes: SystemNode[];
}

/** One card, chip, bar or row of the layered map. Clicking it opens the facts panel (same shape as a node). */
export interface LayerItem {
  /** "<layer>.<name>", unique across the whole response. */
  id: string;
  label: string;
  value: string;
  status: SystemStatus;
  facts: SystemFact[];
  source: string;
  /** Second line under the label (a role, a schedule in words). */
  sub?: string;
  /** A number to draw (bar length, chip count). */
  count?: number;
  /** The label is a hostname: replaced by REDACTED_TEXT on ?redact=1. */
  private?: boolean;
}

/** The layered map (v2): the same live data as `planes`, laid out the way the architecture page draws it. */
export interface SystemLayers {
  prompt: LayerItem[];
  /** L1 */
  machines: { items: LayerItem[]; links: string[] };
  /** L2 */
  guardrails: LayerItem[];
  /** L3: the dark hero panel. */
  engine: { title: string; model: LayerItem; runtimes: LayerItem[]; fleet: LayerItem[]; judgment: LayerItem[]; chips: LayerItem[]; steps: LayerItem[] };
  /** L4 */
  memory: LayerItem[];
  skills: { total: LayerItem; categories: LayerItem[]; recent: LayerItem[] };
  jobs: LayerItem[];
  live: LayerItem[];
  mcp: Array<{ group: string; items: LayerItem[] }>;
  /** L5 */
  outputs: LayerItem[];
}

export interface SystemResponse {
  ok: true;
  /** 2 once `layers` is present; a v1 client ignores both. */
  version?: 2;
  at: string;
  planes: SystemPlane[];
  layers?: SystemLayers;
  /** Sources that timed out or failed this build, by name. Their nodes read "unknown". */
  unavailable: string[];
}

export const REDACTED_TEXT = "hidden";
