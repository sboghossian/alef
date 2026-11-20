import { describe, expect, it } from "vitest";
import {
  allStations,
  hslToHex,
  mcpServerFromToolName,
  mcpTint,
  STATION_ORDER,
  STATIONS,
  stationForObjectKind,
  stationOf,
  stationOfActivity,
  type StationId,
} from "../../../shared/stations";

const HEX_RE = /^#[0-9a-f]{6}$/i;
const CREAM: [number, number, number] = [255, 253, 246];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relLum([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two colours (1..21). */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = relLum(a) + 0.05;
  const lb = relLum(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

function hue([r, g, b]: [number, number, number]): number {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe("STATIONS catalog", () => {
  it("has one well-formed entry per StationId, in STATION_ORDER", () => {
    expect(STATION_ORDER.length).toBe(10);
    expect(new Set(STATION_ORDER).size).toBe(STATION_ORDER.length);
    for (const id of STATION_ORDER) {
      const s = STATIONS[id];
      expect(s.id).toBe(id);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.emoji.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.color).toMatch(HEX_RE);
    }
    expect(allStations().map((s) => s.id)).toEqual([...STATION_ORDER]);
  });

  it("every colour is unique", () => {
    const colors = STATION_ORDER.map((id) => STATIONS[id].color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("every colour reads on the cream background (WCAG contrast >= 3:1)", () => {
    for (const id of STATION_ORDER) {
      const c = contrast(hexToRgb(STATIONS[id].color), CREAM);
      expect(c, `${id} contrast ${c.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the 9 chromatic hues stay at least 18° apart (the neutral 'other' grey is exempt)", () => {
    const chromatic = STATION_ORDER.filter((id) => id !== "other");
    const hues = chromatic.map((id) => ({ id, h: hue(hexToRgb(STATIONS[id].color)) }));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const d = hueDist(hues[i]!.h, hues[j]!.h);
        expect(d, `${hues[i]!.id} vs ${hues[j]!.id}: ${d.toFixed(0)}°`).toBeGreaterThanOrEqual(18);
      }
    }
  });

  it("'other' is a neutral grey (near-zero saturation), so it never competes with a real hue", () => {
    const [r, g, b] = hexToRgb(STATIONS.other.color);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(4);
  });
});

describe("stationOf", () => {
  const cases: [string, StationId][] = [
    ["Bash", "bash"],
    ["BashOutput", "bash"],
    ["KillShell", "bash"],
    ["Edit", "edit"],
    ["MultiEdit", "edit"],
    ["Write", "edit"],
    ["NotebookEdit", "edit"],
    ["Read", "read"],
    ["Grep", "read"],
    ["Glob", "read"],
    ["WebFetch", "web"],
    ["WebSearch", "web"],
    ["Skill", "skill"],
    ["Agent", "subagent"],
    ["Task", "subagent"],
    ["SendMessage", "subagent"],
    ["Monitor", "subagent"],
    ["Workflow", "subagent"],
    ["TodoWrite", "plan"],
    ["EnterPlanMode", "plan"],
    ["ExitPlanMode", "plan"],
    ["TaskCreate", "plan"],
    ["TaskUpdate", "plan"],
    ["TaskList", "plan"],
    ["TaskGet", "plan"],
    ["TaskOutput", "plan"],
    ["TaskStop", "plan"],
    ["AskUserQuestion", "other"],
    ["ToolSearch", "other"],
    ["EnterWorktree", "other"],
    ["ExitWorktree", "other"],
    ["SomeFutureTool", "other"],
  ];
  for (const [name, want] of cases) {
    it(`${name} → ${want}`, () => expect(stationOf(name)).toBe(want));
  }

  it("any mcp__<server>__<tool> name is 'mcp', regardless of the tool suffix", () => {
    expect(stationOf("mcp__linear__save_issue")).toBe("mcp");
    expect(stationOf("mcp__obscura__browser_navigate")).toBe("mcp");
  });

  it("a name that merely mentions 'browser' (not mcp-prefixed) reads as 'web'", () => {
    expect(stationOf("BrowserNavigate")).toBe("web");
  });

  it("empty, null and undefined all fall back to 'other'", () => {
    expect(stationOf("")).toBe("other");
    expect(stationOf(null)).toBe("other");
    expect(stationOf(undefined)).toBe("other");
  });
});

describe("stationOfActivity", () => {
  it("prefers the tool name even when the stage is 'plan' (Skill, TodoWrite)", () => {
    expect(stationOfActivity({ stage: "plan", toolName: "Skill" })).toBe("skill");
    expect(stationOfActivity({ stage: "plan", toolName: "TodoWrite" })).toBe("plan");
  });

  it("an Edit to a vault/memory path (stage 'brain') is still the edit station", () => {
    expect(stationOfActivity({ stage: "brain", toolName: "Edit" })).toBe("edit");
  });

  it("falls back to 'hook' for a toolless hook-stage line (a new prompt, or the PermissionRequest hook)", () => {
    expect(stationOfActivity({ stage: "hook", toolName: null })).toBe("hook");
  });

  it("falls back to 'other' for toolless reasoning (assistant thinking/text)", () => {
    expect(stationOfActivity({ stage: "reason", toolName: null })).toBe("other");
  });
});

describe("stationForObjectKind", () => {
  it("maps skill/hook/mcp straight across, and everything else to 'other'", () => {
    expect(stationForObjectKind("skill")).toBe("skill");
    expect(stationForObjectKind("hook")).toBe("hook");
    expect(stationForObjectKind("mcp")).toBe("mcp");
    expect(stationForObjectKind("file")).toBe("other");
    expect(stationForObjectKind("repo")).toBe("other");
  });
});

describe("mcpServerFromToolName", () => {
  it("extracts the server between the double underscores", () => {
    expect(mcpServerFromToolName("mcp__linear__save_issue")).toBe("linear");
    expect(mcpServerFromToolName("mcp__claude_ai_Gmail__send_message")).toBe("claude_ai_Gmail");
  });
  it("returns null for a non-mcp name, or a malformed/empty server", () => {
    expect(mcpServerFromToolName("Bash")).toBeNull();
    expect(mcpServerFromToolName("mcp__")).toBeNull();
  });
});

describe("mcpTint", () => {
  it("is stable: the same server always gets the same colour", () => {
    expect(mcpTint("linear")).toBe(mcpTint("linear"));
  });
  it("returns a valid, cream-readable hex colour", () => {
    for (const server of ["linear", "cloudflare", "figma", "growth"]) {
      const c = mcpTint(server);
      expect(c).toMatch(HEX_RE);
      expect(contrast(hexToRgb(c), CREAM)).toBeGreaterThanOrEqual(2.5);
    }
  });
  it("distinguishes at least most of a varied set of server names", () => {
    const servers = ["linear", "cloudflare", "figma", "growth", "inboxkit", "examplevendor", "notion", "posthog"];
    const tints = new Set(servers.map(mcpTint));
    expect(tints.size).toBeGreaterThanOrEqual(servers.length - 1); // allow one hash collision, not a wipeout
  });
});

describe("hslToHex", () => {
  it("round-trips primaries", () => {
    expect(hslToHex(0, 100, 50).toLowerCase()).toBe("#ff0000");
    expect(hslToHex(120, 100, 50).toLowerCase()).toBe("#00ff00");
    expect(hslToHex(240, 100, 50).toLowerCase()).toBe("#0000ff");
  });
});
