import { describe, expect, it } from "vitest";
import { buildLayers, recallMake, skillCounts } from "../features/system-layers.js";
import { buildPlanes, type SystemSources } from "../features/system-nodes.js";
import { redactSystem, type Settled } from "../features/system-lib.js";
import { categorizeSkill, categoryCounts, countConductCases, countConstitutionLayers, countSince, countWikilinks, hostedGroup, jobStatus, skillDescription } from "../features/system-layers-lib.js";
import type { SystemResponse } from "../../shared/features/system.js";
import { layerSources } from "./system-layers-fixtures.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const ok = <T,>(value: T): Settled<T> => ({ ok: true, value });
const src = (): SystemSources => ({
  host: ok({ load1: 1, cpus: 10, uptimeSec: 9 }), claudeVersion: ok("2.1.300"),
  settings: ok({ model: "opus[1m]", effort: "high", hookCount: 3, hookEvents: ["Stop", "SessionStart"], hookByEvent: [{ event: "Stop", count: 2 }, { event: "SessionStart", count: 1 }], permissionHook: true, denyCount: 2, allowCount: 5 }),
  harness: ok({ skills: 3, agents: 9, mcp: 2, mcpNames: [] }), memory: ok({ files: 80, byType: { project: 50, feedback: 30 }, indexLines: 150 }),
  vault: ok({ path: "/secret/vault", notes: 10, lastCommitMs: NOW, mirrorMs: NOW, ahead: 0, brainGraphMs: NOW }), mini: ok({ configured: true, reachable: true }),
  routines: ok({ total: 2, loaded: 2, paused: 0, running: 0, failed: 0, firedToday: 1, voiceLoaded: true }),
  launchd: ok({ launchctlRead: true, jobs: [{ label: "com.stephane.a", kind: "scheduled", schedule: "daily 08:00", loaded: true, running: false, lastExit: 1 }, { label: "com.stephane.b", kind: "scheduled", schedule: "hourly", loaded: false, running: false, lastExit: null }] }),
  tunnel: ok({ hostnames: ["lawgraph.dashable.dev", "other.dashable.dev"] }),
  services: ok([{ host: "lawgraph", port: 1, managed: true, up: false, dir: "d", public: true }]),
  prompts: ok({ sessionsToday: 4, liveNow: null }), outputs: ok({ prsToday: 1, shippedToday: 1, artifactsToday: 2 }),
});
const layers = (l = layerSources()) => buildLayers(NOW, src(), l, buildPlanes(NOW, src()));

describe("pure helpers", () => {
  it("categorizes skills by name then description", () => {
    expect(categorizeSkill("divorce-practice")).toBe("Legal");
    expect(categorizeSkill("linkedin-post")).toBe("Growth and GTM");
    expect(categorizeSkill("qa")).toBe("Engineering");
    expect(categorizeSkill("zzz", "")).toBe("Other");
    expect(categorizeSkill("zzz", "scrape any page")).toBe("Research and scraping");
  });
  it("counts categories biggest first with Other last", () => {
    const c = categoryCounts([{ name: "zzz" }, { name: "qa" }, { name: "review" }, { name: "legal-x" }]);
    expect(c.map((x) => x.name)).toEqual(["Engineering", "Legal", "Other"]);
    expect(c[0]?.count).toBe(2);
  });
  it("reads frontmatter descriptions inline and as blocks", () => {
    expect(skillDescription("---\nname: a\ndescription: \"Hi there\"\n---\nbody")).toBe("Hi there");
    expect(skillDescription("---\nname: a\ndescription: |\n  line one\n  line two\nother: x\n---")).toBe("line one line two");
    expect(skillDescription("no frontmatter")).toBe("");
  });
  it("counts cases, layers, wikilinks, route cards", () => {
    expect(countConductCases("### Case 1 — a\n### Case 2 — b\ntext ### Case 3")).toBe(2);
    expect(countConstitutionLayers("# Layer 1 — x\n# Layer 2 — y\n## Layer 2 — dup")).toBe(2);
    expect(countWikilinks("a [[b]] c [[d|e]]\n```\n[[no]]\n```")).toBe(2);
    expect(countSince('{"ts":"2026-10-14T10:00:00Z"}\n{"ts":"2026-10-13T10:00:00Z"}\nbroken{', Date.parse("2026-10-14T00:00:00Z"))).toEqual({ today: 1, total: 2 });
  });
  it("maps job exit status and hosted groups", () => {
    expect(jobStatus(true, 0)).toBe("ok");
    expect(jobStatus(true, 1)).toBe("warn");
    expect(jobStatus(true, 137)).toBe("bad");
    expect(jobStatus(false, null)).toBe("warn");
    expect(jobStatus(null, null)).toBe("unknown");
    expect(hostedGroup("claude.ai Gmail")).toBe("Comms and docs");
  });
});

describe("buildLayers", () => {
  it("fills every layer with live values", () => {
    const l = layers();
    expect(l.machines.items.map((i) => i.label)).toEqual(["This Mac", "Mac mini", "iCloud vault", "GitHub mirror"]);
    expect(l.guardrails.find((i) => i.id === "l2.conduct")?.value).toBe("12 cases");
    expect(l.engine.model.value).toContain("1M context");
    expect(l.engine.steps.map((s) => s.label)).toEqual(["Prompt", "① Hook", "② Plan / Skill", "③ Reason", "④ Tools", "⑤ Subagents", "⑥ Verify", "⑦ Persist", "Response"]);
    expect(l.engine.steps[1]?.value).toBe("1 hooks");
    expect(l.engine.judgment[1]?.value).toBe("43 today");
    expect(l.skills.recent.map((s) => s.label)).toEqual(["grill-me", "zzz", "linear"]);
    expect(l.jobs.map((j) => j.status)).toEqual(["warn", "warn"]);
    expect(l.live.map((i) => i.label)).toEqual(["lawgraph", "other.dashable.dev"]);
    expect(l.live[0]?.status).toBe("bad");
    expect(l.mcp.map((g) => g.group)).toContain("Local servers");
    expect(l.outputs.map((o) => o.label)).toEqual(["Response", "Artifacts", "Deploys", "PRs", "Memory written", "Vault captured"]);
    expect(l.memory.find((m) => m.id === "l4.mem.recall")).toMatchObject({ value: "12,345 chunks", status: "ok", sub: "DB updated 1 h ago" });
    const ids = [l.prompt, l.guardrails, l.engine.steps, l.memory, l.jobs, l.live, l.outputs].flat().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("greys only the items of a source that failed", () => {
    const l = layers(layerSources({ conduct: { ok: false, error: "took over 4000 ms" }, mcpMeta: { ok: false, error: "ENOENT" } }));
    expect(l.guardrails.find((i) => i.id === "l2.conduct")).toMatchObject({ status: "unknown", value: "unknown" });
    expect(l.mcp[0]?.items[0]?.status).toBe("unknown");
    expect(l.engine.chips[0]?.status).toBe("ok");
    expect(l.skills.total.status).toBe("ok");
  });
  it("uses the SKILL.md folder count for both L3 places, with both numbers in the facts", () => {
    const l = layers();
    expect(l.engine.chips[0]?.value).toBe("3 skills");
    expect(l.engine.steps[2]?.value).toBe("3 skills");
    const more = layers(layerSources({ skillMeta: ok(Array.from({ length: 174 }, (_, i) => ({ name: `s${i}`, description: "", mtimeMs: 1 }))) }));
    expect(more.engine.chips[0]?.value).toBe("174 skills");
    expect(more.engine.steps[2]?.facts).toEqual([{ label: "SKILL.md folders", value: "174" }, { label: "Loaded by the harness", value: "3" }]);
    expect(skillCounts(null, 40)).toMatchObject({ value: "40 skills", status: "ok" });
    expect(skillCounts(null, null)).toMatchObject({ value: "unknown", status: "unknown" });
  });
  it("shows recall as unknown with the reason when the store cannot be read", () => {
    const l = layers(layerSources({ recall: { ok: false, error: "SQLITE_CANTOPEN" } }));
    const r = l.memory.find((m) => m.id === "l4.mem.recall");
    expect(r).toMatchObject({ status: "unknown", value: "unknown" });
    expect(JSON.stringify(r?.facts)).toContain("SQLITE_CANTOPEN");
    expect(recallMake({ chunks: 0, mtimeMs: NOW }, NOW)).toMatchObject({ value: "0 chunks", status: "warn" });
  });
  it("redacts host labels and private facts but not counts", () => {
    const base = { ok: true, at: "x", planes: [], layers: layers(), unavailable: [] } as SystemResponse;
    const txt = JSON.stringify(redactSystem(base));
    expect(txt).not.toContain("lawgraph");
    expect(txt).not.toContain("Documents/Code/agent-world");
    expect(txt).toContain("hidden");
    expect(txt).toContain("43 today");
  });
});
