import { describe, expect, it } from "vitest";
import type { LayerItem, SystemLayers } from "../../../shared/features/system";
import { layerItems, layersMarkdown } from "./system-md";

const it1 = (id: string, extra: Partial<LayerItem> = {}): LayerItem => ({ id, label: id, value: "v", status: "ok", facts: [], source: "s", ...extra });
const layers: SystemLayers = {
  prompt: [it1("p")], machines: { items: [it1("m")], links: ["agent mesh"] }, guardrails: [it1("g", { status: "bad" })],
  engine: { title: "Claude Code", model: it1("model"), runtimes: [it1("r")], fleet: [], judgment: [], chips: [], steps: [it1("s1")] },
  memory: [it1("mem")], skills: { total: it1("tot"), categories: [it1("cat", { value: "9" })], recent: [it1("rec", { sub: "2 h ago" })] },
  jobs: [it1("job")], live: [it1("host", { status: "unknown" })], mcp: [{ group: "Local servers", items: [it1("x")] }], outputs: [it1("o")],
};

describe("layerItems", () => {
  it("lists every item once, in reading order", () => {
    const ids = layerItems(layers).map((i) => i.id);
    expect(ids).toEqual(["p", "m", "g", "model", "r", "s1", "mem", "tot", "cat", "rec", "job", "host", "x", "o"]);
  });
});
describe("layersMarkdown", () => {
  it("writes every layer with status marks", () => {
    const md = layersMarkdown(layers, "12:00");
    for (const h of ["## L1 Machines & sync (agent mesh)", "## L2 Guardrails", "## L3 Claude Code", "## L4 Memory", "## L4 Skills", "## L4 Scheduled jobs", "## L4 Always-live fleet", "### Local servers", "## L5"]) expect(md).toContain(h);
    expect(md).toContain("- g: v [BAD]");
    expect(md).toContain("- host: v [?]");
    expect(md).toContain("- rec: v (2 h ago) [ok]");
  });
});
