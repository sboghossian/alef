// Pure helpers over the layered System map: a flat id lookup (for the facts panel) and a
// Markdown copy of the live map (the "Copy as Markdown" action). No DOM; unit-tested in system-md.test.ts.

import type { LayerItem, SystemLayers, SystemStatus } from "../../../shared/features/system";

/** Every item of every layer, in reading order. */
export function layerItems(l: SystemLayers): LayerItem[] {
  const e = l.engine;
  return [
    ...l.prompt, ...l.machines.items, ...l.guardrails, e.model, ...e.runtimes, ...e.fleet, ...e.judgment, ...e.chips, ...e.steps,
    ...l.memory, l.skills.total, ...l.skills.categories, ...l.skills.recent, ...l.jobs, ...l.live, ...l.mcp.flatMap((g) => g.items), ...l.outputs,
  ];
}

const MARK: Readonly<Record<SystemStatus, string>> = { ok: "ok", warn: "warn", bad: "BAD", unknown: "?" };
const line = (i: LayerItem): string => `- ${i.label}: ${i.value}${i.sub ? ` (${i.sub})` : ""} [${MARK[i.status]}]`;
const block = (title: string, items: readonly LayerItem[]): string[] => (items.length === 0 ? [] : [`### ${title}`, ...items.map(line), ""]);

/** The whole map as Markdown. Strings are copied as shown (a redacted response stays redacted). */
export function layersMarkdown(l: SystemLayers, at: string): string {
  const e = l.engine;
  return [
    `# System map (read ${at})`, "",
    "## Prompt", ...l.prompt.map(line), "",
    `## L1 Machines & sync (${l.machines.links.join(" / ")})`, ...l.machines.items.map(line), "",
    "## L2 Guardrails & hooks", ...l.guardrails.map(line), "",
    `## L3 ${e.title}`, line(e.model), "",
    ...block("Runtimes", e.runtimes), ...block("Fleet", e.fleet), ...block("Judgment", e.judgment), ...block("Chips", e.chips), ...block("Pipeline", e.steps),
    "## L4 Memory on Obsidian", ...l.memory.map(line), "",
    "## L4 Skills", line(l.skills.total), ...l.skills.categories.map((c) => `  - ${c.label}: ${c.value}`), ...block("Most recently edited", l.skills.recent),
    "## L4 Scheduled jobs", ...l.jobs.map(line), "",
    "## L4 Always-live fleet", ...l.live.map(line), "",
    "## L4 MCP connectors", ...l.mcp.flatMap((g) => block(g.group, g.items)),
    "## L5 What comes out", ...l.outputs.map(line), "",
  ].join("\n");
}
