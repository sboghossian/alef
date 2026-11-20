// The Mind tab bar must reach every Vault section and nothing else. vault.ts is read as text
// (no jsdom here, and importing it would pull in the whole view), the way groups.test.ts does.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIND_TABS, mindTabRoute } from "./mind-tabs";

const here = dirname(fileURLToPath(import.meta.url));
const vaultSections = [...readFileSync(join(here, "vault.ts"), "utf8").matchAll(/\{ id: "([a-z]+)", emoji:/g)].map((m) => m[1]);
const tabIds = MIND_TABS.flatMap((g) => g.tabs.map((t) => t.id));

describe("MIND_TABS", () => {
  it("is the artifact's fifteen tabs in its four groups", () => {
    expect(MIND_TABS.map((g) => g.name)).toEqual(["Map", "Time", "Mind", "Care"]);
    expect(tabIds).toHaveLength(15);
    expect(new Set(tabIds).size).toBe(15);
  });

  it("covers every Vault section exactly, plus Graph", () => {
    expect(vaultSections).toHaveLength(14);
    expect([...tabIds].sort()).toEqual([...vaultSections, "graph"].sort());
  });

  it("routes Graph to Brain and everything else to its Vault section", () => {
    expect(mindTabRoute("graph")).toEqual({ view: "brain", param: null });
    expect(mindTabRoute("people")).toEqual({ view: "vault", param: "people" });
  });
});

// UX-2 / VIS-8: Brain is one destination with one flat tab row, placed the same way in both views.
describe("the Brain tab bar", () => {
  const src = (f: string): string => readFileSync(join(here, f), "utf8");

  it("is flat: the four groups are gaps, not a row of labels (no third nav level)", () => {
    expect(src("mind-tabs.ts")).not.toContain("mind-tabs-label");
    expect(src("mind-tabs.css")).not.toContain("mind-tabs-label");
  });

  it("is framed the same way by Brain and Vault, never floated over the graph", () => {
    expect(src("brain.ts")).toMatch(/mindFrame\(tabs, r\)/);
    expect(src("vault.ts")).toMatch(/mindFrame\(tabBar, body\)/);
    expect(src("mind-tabs.css")).not.toMatch(/mind-tabs-float|position:\s*absolute/);
  });

  it("uses the shared selected style and no colour literals", () => {
    expect(src("mind-tabs.ts")).toContain('"mind-tabs-group ch-seg"');
    expect(src("mind-tabs.css")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
