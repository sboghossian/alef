// Pure layout + wording for the 🧭 System view (system.ts). No DOM; unit-tested in system-lib.test.ts.
//
// Wide: a hub-and-spoke in world coordinates. The engine hub is at (0, 0). Above it the prompts
// row feeds the engine's own three nodes; four planes (machines and guardrails on the left, skills
// and memory on the right) have their nodes in a column on the outer side; services hang below
// and outputs end the chain. Fixed positions, a function of the data only, no node ever overlaps
// another or a hub (the test checks it). Narrow (under NARROW_PX): the same planes as a vertical
// flow of cards, in FLOW_ORDER.

import type { SystemPlane, SystemPlaneId, SystemStatus } from "../../../shared/features/system";

export const NARROW_PX = 640;
export const NODE_W = 200;
export const NODE_H = 52;
export const NODE_PITCH_X = 230;
export const NODE_PITCH_Y = 62;

export const STATUS_COLORS: Readonly<Record<SystemStatus, string>> = { ok: "#16b98a", warn: "#ff9f1c", bad: "#f2462f", unknown: "#b8bcc4" };
export const STATUS_LABELS: Readonly<Record<SystemStatus, string>> = { ok: "Healthy", warn: "Needs a look", bad: "Down or failing", unknown: "Unknown (not read)" };

/** Top to bottom as one prompt flows: in, engine, the five spokes, out. */
export const FLOW_ORDER: readonly SystemPlaneId[] = ["prompts", "engine", "machines", "guardrails", "skills", "memory", "services", "outputs"];

export interface Pt { x: number; y: number }
export interface HubPos extends Pt { r: number }
export interface SystemLayout {
  hubs: Map<SystemPlaneId, HubPos>;
  nodes: Map<string, Pt>; // node id -> centre of its NODE_W x NODE_H pill
  bounds: { x: number; y: number; w: number; h: number };
}

const HUBS: Readonly<Record<SystemPlaneId, HubPos>> = {
  prompts: { x: 0, y: -440, r: 30 },
  engine: { x: 0, y: 0, r: 60 },
  machines: { x: -330, y: -60, r: 44 },
  guardrails: { x: -330, y: 265, r: 44 },
  skills: { x: 330, y: -60, r: 44 },
  memory: { x: 330, y: 265, r: 44 },
  services: { x: 0, y: 262, r: 44 },
  outputs: { x: 0, y: 470, r: 30 },
};
const ROW_Y: Readonly<Partial<Record<SystemPlaneId, number>>> = { prompts: -345, engine: -195, services: 365, outputs: 565 };
const COLUMN_X: Readonly<Partial<Record<SystemPlaneId, number>>> = { machines: -560, guardrails: -560, skills: 560, memory: 560 };
/** A row holds at most this many pills; more wrap onto a second row so they never reach the side columns. */
export const ROW_MAX = 4;
const centred = (i: number, n: number): number => (i - (n - 1) / 2) * NODE_PITCH_X;

export function layoutSystem(planes: readonly SystemPlane[]): SystemLayout {
  const hubs = new Map<SystemPlaneId, HubPos>();
  const nodes = new Map<string, Pt>();
  // A wrapped services row pushes the outputs below it down by the rows it added.
  const extra = Math.max(0, Math.ceil((planes.find((p) => p.id === "services")?.nodes.length ?? 0) / ROW_MAX) - 1) * NODE_PITCH_Y;
  for (const p of planes) {
    const hub = p.id === "outputs" ? { ...HUBS.outputs, y: HUBS.outputs.y + extra } : HUBS[p.id];
    hubs.set(p.id, hub);
    const rowY = p.id === "outputs" ? (ROW_Y.outputs ?? 0) + extra : ROW_Y[p.id];
    const colX = COLUMN_X[p.id];
    p.nodes.forEach((n, i) => {
      if (rowY !== undefined) {
        const line = Math.floor(i / ROW_MAX);
        const inLine = Math.min(ROW_MAX, p.nodes.length - line * ROW_MAX);
        nodes.set(n.id, { x: centred(i - line * ROW_MAX, inLine), y: rowY + line * NODE_PITCH_Y });
      }
      else if (colX !== undefined) nodes.set(n.id, { x: colX, y: hub.y + (i - (p.nodes.length - 1) / 2) * NODE_PITCH_Y });
    });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number, hw: number, hh: number): void => {
    x0 = Math.min(x0, x - hw);
    x1 = Math.max(x1, x + hw);
    y0 = Math.min(y0, y - hh);
    y1 = Math.max(y1, y + hh);
  };
  for (const h of hubs.values()) grow(h.x, h.y, h.r + 20, h.r + 34); // room for the label under the hub
  for (const c of nodes.values()) grow(c.x, c.y, NODE_W / 2, NODE_H / 2);
  return { hubs, nodes, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** Planes in the order a narrow screen stacks them; a plane the server did not send is skipped. */
export function narrowOrder(planes: readonly SystemPlane[]): SystemPlane[] {
  return FLOW_ORDER.map((id) => planes.find((p) => p.id === id)).filter((p): p is SystemPlane => p !== undefined);
}

export function isNarrow(widthPx: number): boolean {
  return widthPx > 0 && widthPx < NARROW_PX;
}

/** Fits one line of a pill: cut at `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function statsLines(planes: readonly SystemPlane[], unavailable: readonly string[], at: string): string[] {
  const all = planes.flatMap((p) => p.nodes);
  const n = (s: SystemStatus): number => all.filter((x) => x.status === s).length;
  const lines = [`${all.length} nodes: ${n("ok")} healthy, ${n("warn")} need a look, ${n("bad")} failing, ${n("unknown")} unknown`];
  if (unavailable.length) lines.push(`not read this time: ${unavailable.join(", ")}`);
  lines.push(`read ${new Date(at).toLocaleTimeString("en-GB")}; refreshes by itself`);
  return lines;
}

/** Standalone-SVG styling for the export: the view's CSS is not in a downloaded file. */
export const EXPORT_STYLE =
  "text{text-anchor:middle;dominant-baseline:middle;fill:#1a1030;font:900 14px sans-serif}.sv-emoji{font-size:24px}.sv-hub-label{font-weight:800;paint-order:stroke;stroke:#fff8e7;stroke-width:4px}" +
  ".sv-edges line{stroke:#c9bfdc;stroke-width:2.5}.sv-edges .sv-spoke{stroke-width:1.2;opacity:.7}.sv-edges .sv-flow{stroke:#8b5cf6;stroke-dasharray:7 6;stroke-width:3}" +
  ".sv-hub circle:first-child{stroke:#1a1030;stroke-width:3}.sv-hub-dot,.sv-dot{stroke:#1a1030;stroke-width:2}.sv-node rect{fill:#fffdf6;stroke:#1a1030;stroke-width:2.5}" +
  ".sv-node-label,.sv-node-value{text-anchor:start}.sv-node-label{font-size:14px}.sv-node-value{font:700 12.5px sans-serif;fill:#6b5f86}";

/** The hub and spoke as a self-contained SVG document (no scripts, no external refs). `worldXml` is the serialized world group. */
export function exportSvgText(worldXml: string, bounds: SystemLayout["bounds"], pad = 24): string {
  const { x, y, w, h } = bounds;
  const vb = [x - pad, y - pad, w + 2 * pad, h + 2 * pad].map((n) => Math.round(n)).join(" ");
  const [, , vw, vh] = vb.split(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${vw}" height="${vh}"><style>${EXPORT_STYLE}</style><rect x="${Math.round(x - pad)}" y="${Math.round(y - pad)}" width="${vw}" height="${vh}" fill="#fff8e7"/>${worldXml}</svg>`;
}

/** Whole seconds to wait, for the Refresh button's rate-limit message. */
export const waitText = (retryAfterMs: number): string => `wait ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s`;
