import { describe, expect, it } from "vitest";
import type { SystemNode, SystemPlane, SystemPlaneId } from "../../../shared/features/system";
import { FLOW_ORDER, exportSvgText, waitText, NODE_H, NODE_W, clip, isNarrow, layoutSystem, narrowOrder, statsLines } from "./system-lib";

const COUNTS: Record<SystemPlaneId, number> = { prompts: 3, engine: 3, machines: 5, guardrails: 4, skills: 4, memory: 4, services: 5, outputs: 3 };

function plane(id: SystemPlaneId, n = COUNTS[id]): SystemPlane {
  const nodes: SystemNode[] = Array.from({ length: n }, (_, i) => ({ id: `${id}.n${i}`, plane: id, label: `n${i}`, value: "v", status: "ok", facts: [], source: "s" }));
  return { id, name: id, emoji: "x", status: "ok", nodes };
}
const full = (): SystemPlane[] => FLOW_ORDER.map((id) => plane(id));

describe("wide layout", () => {
  it("places every node and every hub", () => {
    const planes = full();
    const l = layoutSystem(planes);
    expect(l.hubs.size).toBe(8);
    expect(l.nodes.size).toBe(planes.reduce((n, p) => n + p.nodes.length, 0));
  });
  it("never overlaps two nodes, or a node and a hub, even with the most nodes a plane can show", () => {
    const planes = FLOW_ORDER.map((id) => plane(id, id === "machines" || id === "guardrails" || id === "skills" || id === "memory" ? 5 : id === "services" ? 8 : 4));
    const l = layoutSystem(planes);
    const pills = [...l.nodes.entries()];
    for (let i = 0; i < pills.length; i++) {
      const [, a] = pills[i]!;
      for (let j = i + 1; j < pills.length; j++) {
        const [, b] = pills[j]!;
        const apart = Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H;
        expect(apart, `${pills[i]![0]} vs ${pills[j]![0]}`).toBe(true);
      }
      for (const [id, h] of l.hubs) {
        const dx = Math.max(Math.abs(a.x - h.x) - NODE_W / 2, 0);
        const dy = Math.max(Math.abs(a.y - h.y) - NODE_H / 2, 0);
        expect(Math.hypot(dx, dy), `${pills[i]![0]} vs hub ${id}`).toBeGreaterThan(h.r);
      }
    }
  });
  it("wraps a row of more than four pills onto a second row, centred", () => {
    const l = layoutSystem([plane("services", 5)]);
    const ys = [...l.nodes.values()].map((c) => c.y);
    expect(new Set(ys).size).toBe(2);
    expect(l.nodes.get("services.n4")).toMatchObject({ x: 0 });
  });
  it("keeps the engine at the centre, prompts above it and outputs below", () => {
    const l = layoutSystem(full());
    expect(l.hubs.get("engine")).toMatchObject({ x: 0, y: 0 });
    expect(l.hubs.get("prompts")!.y).toBeLessThan(0);
    expect(l.hubs.get("outputs")!.y).toBeGreaterThan(l.hubs.get("services")!.y);
    expect(l.hubs.get("machines")!.x).toBeLessThan(0);
    expect(l.hubs.get("skills")!.x).toBeGreaterThan(0);
  });
  it("bounds contain every node and is the same for the same data", () => {
    const l = layoutSystem(full());
    for (const c of l.nodes.values()) {
      expect(c.x - NODE_W / 2).toBeGreaterThanOrEqual(l.bounds.x);
      expect(c.y + NODE_H / 2).toBeLessThanOrEqual(l.bounds.y + l.bounds.h);
    }
    expect(layoutSystem(full()).bounds).toEqual(l.bounds);
  });
  it("copes with a plane that has no nodes", () => {
    expect(layoutSystem([plane("outputs", 0)]).nodes.size).toBe(0);
  });
});

describe("narrow layout", () => {
  it("switches under 640 px, and not on a zero width", () => {
    expect(isNarrow(390)).toBe(true);
    expect(isNarrow(1280)).toBe(false);
    expect(isNarrow(0)).toBe(false);
  });
  it("stacks the planes in flow order whatever order the server sent", () => {
    const shuffled = [...full()].reverse();
    expect(narrowOrder(shuffled).map((p) => p.id)).toEqual([...FLOW_ORDER]);
  });
  it("skips a plane the server did not send", () => {
    expect(narrowOrder(full().filter((p) => p.id !== "memory")).map((p) => p.id)).not.toContain("memory");
  });
});

describe("wording", () => {
  it("clips to one line with an ellipsis", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("a very long value indeed", 10)).toHaveLength(10);
    expect(clip("a very long value indeed", 10).endsWith("…")).toBe(true);
  });
  it("counts the statuses and names what was not read", () => {
    const planes = full();
    planes[0]!.nodes[0]!.status = "unknown";
    const lines = statsLines(planes, ["vault"], "2026-10-14T10:00:00Z");
    expect(lines[0]).toContain("1 unknown");
    expect(lines[1]).toBe("not read this time: vault");
  });
});

describe("export and refresh wording", () => {
  it("wraps the world in a self-contained svg sized from the bounds", () => {
    const svg = exportSvgText('<g class="sv-world"></g>', { x: -100, y: -50, w: 200, h: 100 }, 10);
    expect(svg).toContain('viewBox="-110 -60 220 120"');
    expect(svg).toContain("<style>");
    expect(svg).toContain('<g class="sv-world"></g>');
    expect(svg).not.toMatch(/<script|href=/);
  });
  it("rounds the wait up to whole seconds, never zero", () => {
    expect(waitText(9_200)).toBe("wait 10 s");
    expect(waitText(10)).toBe("wait 1 s");
  });
});
