// DOM for the layered System map (prompt, L1..L5). Every string comes from the server and is
// untrusted: textContent only. Every card/chip/bar/row is a button; onOpen(id) opens the facts panel.

import type { LayerItem, SystemLayers } from "../../../shared/features/system";
import { STATUS_COLORS } from "./system-lib";

export type Open = (id: string) => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const dot = (i: LayerItem): HTMLElement => {
  const d = el("i", "sv-dot");
  d.style.background = STATUS_COLORS[i.status];
  return d;
};

/** A clickable item. `kind` picks the look: chip, card, step, bar, row. */
export function itemButton(i: LayerItem, kind: string, open: Open): HTMLButtonElement {
  const b = el("button", `sv-it sv-it-${kind}`);
  b.type = "button";
  b.dataset.item = i.id;
  b.title = `${i.label}: ${i.value}`;
  const text = el("span", "sv-it-text");
  text.append(el("b", "sv-it-label", i.label));
  if (kind !== "bar") text.append(el("small", "sv-it-value", i.value));
  if (i.sub) text.append(el("small", "sv-it-sub", i.sub));
  b.append(dot(i), text);
  b.addEventListener("click", () => open(i.id));
  return b;
}

function layer(tag: string, title: string, note: string, status?: LayerItem["status"]): HTMLElement {
  const s = el("section", `sv-layer sv-layer-${tag}`);
  const h = el("header", "sv-layer-head");
  h.append(el("span", "sv-tag", tag.toUpperCase()), el("h3", "sv-layer-title", title), el("span", "sv-layer-note", note));
  if (status) h.dataset.status = status;
  s.append(h);
  return s;
}

const grid = (cls: string, items: readonly LayerItem[], kind: string, open: Open): HTMLElement => {
  const g = el("div", cls);
  for (const i of items) g.append(itemButton(i, kind, open));
  return g;
};
const label = (t: string): HTMLElement => el("h4", "sv-sub-title", t);
const arrow = (t = "↓"): HTMLElement => el("div", "sv-arrow", t);

function skillsBlock(l: SystemLayers["skills"], open: Open): HTMLElement {
  const box = el("div", "sv-block");
  box.append(el("h4", "sv-block-title", "Skills"), itemButton(l.total, "row", open));
  const max = Math.max(1, ...l.categories.map((c) => c.count ?? 0));
  for (const c of l.categories) {
    const b = itemButton(c, "bar", open);
    const track = el("span", "sv-track");
    const fill = el("span", "sv-fill");
    fill.style.width = `${Math.round(((c.count ?? 0) / max) * 100)}%`;
    track.append(fill);
    b.append(el("span", "sv-n", c.value), track);
    box.append(b);
  }
  if (l.recent.length) box.append(label("Most recently edited"), grid("sv-col", l.recent, "row", open));
  return box;
}

function simpleBlock(title: string, note: string, items: readonly LayerItem[], kind: string, open: Open): HTMLElement {
  const box = el("div", "sv-block");
  box.append(el("h4", "sv-block-title", title), el("p", "sv-block-note", note), grid("sv-col", items, kind, open));
  return box;
}

/** The whole map as one vertical stack of layers. */
export function renderLayers(l: SystemLayers, open: Open): HTMLElement {
  const root = el("div", "sv-map");
  const p = el("div", "sv-prompt");
  p.append(el("span", "sv-prompt-title", "A prompt"), ...l.prompt.map((i) => itemButton(i, "chip", open)));
  root.append(p, arrow());

  const l1 = layer("l1", "Machines & sync", "two Macs, one vault, always in sync");
  l1.append(grid("sv-cards", l.machines.items, "card", open));
  const links = el("div", "sv-links");
  for (const t of l.machines.links) links.append(el("span", "sv-link", t));
  l1.append(links);
  root.append(l1, arrow());

  const l2 = layer("l2", "Guardrails & hooks", "what runs before and after every action");
  l2.append(grid("sv-chips", l.guardrails, "chip", open));
  root.append(l2, arrow());

  const e = l.engine;
  const l3 = layer("l3", e.title, "hub and spoke: everything runs through the engine");
  l3.classList.add("sv-hero");
  l3.append(itemButton(e.model, "card", open), label("Runtimes"), grid("sv-chips", e.runtimes, "chip", open), label("Fleet"), grid("sv-chips", e.fleet, "chip", open), label("Judgment"), grid("sv-chips", e.judgment, "chip", open), grid("sv-chips sv-big", e.chips, "chip", open), label("How one prompt travels the system"));
  const steps = el("div", "sv-steps");
  e.steps.forEach((s, i) => {
    if (i > 0) steps.append(el("span", "sv-step-arrow", "→"));
    steps.append(itemButton(s, "step", open));
  });
  l3.append(steps);
  root.append(l3, arrow());

  const l4 = layer("l4", "What the engine draws on", "memory, skills, schedule, services, connectors");
  const mem = el("div", "sv-block sv-wide");
  mem.append(el("h4", "sv-block-title", "Memory, on Obsidian"), grid("sv-cards", l.memory, "card", open));
  const quad = el("div", "sv-quad");
  quad.append(skillsBlock(l.skills, open), simpleBlock("Scheduled jobs", `${l.jobs.length} on launchd`, l.jobs, "row", open), simpleBlock("Always-live fleet", `${l.live.length} hosts`, l.live, "row", open));
  const mcp = el("div", "sv-block");
  mcp.append(el("h4", "sv-block-title", "MCP connectors"));
  for (const g of l.mcp) if (g.items.length) mcp.append(label(g.group), grid("sv-chips", g.items, "chip", open));
  quad.append(mcp);
  l4.append(mem, quad);
  root.append(l4, arrow());

  const l5 = layer("l5", "What comes out", "today's counts");
  l5.append(grid("sv-chips", l.outputs, "chip", open));
  root.append(l5, arrow(), el("div", "sv-shipped", "Shipped ✓"));
  return root;
}
