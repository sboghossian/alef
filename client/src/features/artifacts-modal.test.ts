// The artifact modal on a tiny stub DOM (client tests run in Node with no jsdom; see
// views/home.test.ts). Covers: a saved copy shows in a sandboxed iframe, an artifact without one
// gets the claude.ai card, and ?redact=1 shows no title and loads no preview.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactItem } from "../../../shared/features/artifacts";
import { MUSEUM_ISLAND_ID } from "../../../shared/features/artifacts";
import type { ClientContext } from "./registry";

class FakeEl {
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, ((ev: unknown) => void)[]>();
  hidden = false;
  own = "";
  [k: string]: unknown;
  constructor(public tagName: string) {}
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join(" ");
  }
  set textContent(v: string) {
    this.own = v;
    this.children = [];
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  append(...els: FakeEl[]): void {
    this.children.push(...els);
  }
  replaceChildren(...els: FakeEl[]): void {
    this.children = els;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn({ target: this, preventDefault() {} });
  }
  focus(): void {
    doc.activeElement = this;
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

const doc = {
  body: new FakeEl("body"),
  activeElement: null as FakeEl | null,
  createElement: (tag: string) => new FakeEl(tag),
  contains: () => true,
};

const item = (id: string, title: string, hasPreview: boolean): ArtifactItem => ({
  id,
  url: `https://claude.ai/artifact/${id}`,
  title,
  origin: "published",
  islandId: "isle-a",
  sessions: [],
  firstAt: "2026-10-01T00:00:00Z",
  lastAt: hasPreview ? "2026-10-02T00:00:00Z" : "2026-10-01T00:00:00Z",
  publishCount: 2,
  hasPreview,
});

const ctx = { store: { islands: new Map([["isle-a", { id: "isle-a", name: "isle-a", path: "/w/isle-a", agentCount: 1, lastActive: "" }]]), agents: new Map() }, flyTo: () => {} } as unknown as ClientContext;

async function openWith(search: string): Promise<FakeEl[]> {
  vi.stubGlobal("location", { search });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeEl);
  vi.resetModules();
  const { mountGallery } = await import("./artifacts-modal");
  doc.body = new FakeEl("body");
  const g = mountGallery(ctx);
  g.open([item("WithCopy123", "Growth board", true), item("NoCopy12345", "Old letter", false)], { cityId: MUSEUM_ISLAND_ID });
  expect(g.isOpen()).toBe(true);
  return doc.body.all();
}

describe("artifact gallery modal", () => {
  beforeEach(() => {
    doc.activeElement = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a saved copy in a sandboxed iframe, and the claude.ai card when there is none", async () => {
    const els = await openWith("");
    const frames = els.filter((e) => e.tagName === "iframe");
    expect(frames).toHaveLength(1);
    // Scripts run, in an opaque origin: never same-origin, top navigation, popups or forms.
    expect(frames[0]!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frames[0]!.src).toBe("/api/artifacts/WithCopy123/preview");
    expect(doc.body.textContent).toContain("Growth board");
    const row = els.find((e) => e.dataset.id === "NoCopy12345");
    row?.click();
    const after = doc.body.all();
    expect(after.some((e) => e.tagName === "iframe")).toBe(false);
    const link = after.find((e) => e.tagName === "a");
    expect(link?.href).toBe("https://claude.ai/artifact/NoCopy12345");
    expect(link?.rel).toBe("noopener noreferrer");
  });

  it("?redact=1: no title anywhere and no preview loaded", async () => {
    const els = await openWith("?redact=1");
    expect(els.some((e) => e.tagName === "iframe")).toBe(false);
    expect(doc.body.textContent).not.toContain("Growth board");
    expect(doc.body.textContent).not.toContain("Old letter");
    expect(doc.body.textContent).toContain("Artifact · October 2026");
    expect(doc.body.textContent).toContain("Preview hidden in screenshot mode.");
  });
});
