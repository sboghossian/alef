import { describe, expect, it } from "vitest";
import type { CompletenessCheck, CompletenessCheckId } from "../../../shared/features/completeness";
import { CHECK_META } from "../../../shared/features/completeness";
import {
  buildFpsCheck,
  bulkTrustFailureText,
  bulkTrustSuccessText,
  trustAllLabel,
  confidenceBadge,
  defaultStartAgentCity,
  dismissalText,
  FIX_STEPS,
  groupChecks,
  isFirstRun,
  issueCounts,
  issuesCaption,
  issuesList,
  medianFps,
  presetTemplate,
  PRESETS,
  severityRank,
  testsResultMessage,
  TESTS_RUN_TIMEOUT_MS,
  toFixCount,
  welcomeMessage,
  WHY_IT_MATTERS,
} from "./health-lib";

describe("preset templating", () => {
  it("every preset's template mentions the given city", () => {
    for (const p of PRESETS) {
      expect(p.template("my-repo")).toContain("my-repo");
    }
  });

  it("presetTemplate looks up by id and substitutes the city", () => {
    expect(presetTemplate("fix-bug", "acme-ai-next")).toContain("acme-ai-next");
    expect(presetTemplate("research", "agent-world")).toMatch(/Research/);
  });

  it("falls back to the first preset for an unknown id instead of throwing", () => {
    expect(() => presetTemplate("not-a-real-preset", "x")).not.toThrow();
    expect(presetTemplate("not-a-real-preset", "x")).toBe(presetTemplate(PRESETS[0]!.id, "x"));
  });

  it("falls back to a generic noun when the city name is empty", () => {
    expect(presetTemplate("fix-bug", "")).toContain("this project");
  });
});

describe("defaultStartAgentCity", () => {
  it("picks the highest agent count, excluding harness", () => {
    const id = defaultStartAgentCity([
      { id: "harness", name: "Harness", agentCount: 999, lastActive: "2026-09-25T00:00:00Z" },
      { id: "a", name: "A", agentCount: 2, lastActive: "2026-09-24T00:00:00Z" },
      { id: "b", name: "B", agentCount: 5, lastActive: "2026-09-20T00:00:00Z" },
    ]);
    expect(id).toBe("b");
  });

  it("breaks a tie by most recently active", () => {
    const id = defaultStartAgentCity([
      { id: "a", name: "A", agentCount: 3, lastActive: "2026-09-20T00:00:00Z" },
      { id: "b", name: "B", agentCount: 3, lastActive: "2026-09-25T00:00:00Z" },
    ]);
    expect(id).toBe("b");
  });

  it("null with no candidate cities", () => {
    expect(defaultStartAgentCity([])).toBeNull();
    expect(defaultStartAgentCity([{ id: "harness", name: "Harness", agentCount: 10, lastActive: "2026-09-25T00:00:00Z" }])).toBeNull();
  });
});

describe("first-run detection", () => {
  it("first run when the flag was never stored", () => {
    expect(isFirstRun(null)).toBe(true);
  });
  it("first run when the flag is corrupted/unexpected", () => {
    expect(isFirstRun("")).toBe(true);
    expect(isFirstRun("true")).toBe(true);
    expect(isFirstRun("0")).toBe(true);
  });
  it("not first run once the flag is exactly \"1\"", () => {
    expect(isFirstRun("1")).toBe(false);
  });
});

describe("welcomeMessage", () => {
  it("states the real counts and pluralizes correctly", () => {
    expect(welcomeMessage(5, 40, 3)).toBe("Alef found 40 agents in 5 cities, 3 live — here's what's set up and what's missing.");
    expect(welcomeMessage(1, 1, 0)).toBe("Alef found 1 agent in 1 city, 0 live — here's what's set up and what's missing.");
  });
});

function check(id: string, group: CompletenessCheck["group"], state: CompletenessCheck["state"]): CompletenessCheck {
  return { id: id as CompletenessCheck["id"], label: id, group, weight: 1, state, detail: "" };
}

describe("groupChecks", () => {
  it("groups in the fixed See/Control/Jev/Routines/Code/Tidy order and omits empty groups", () => {
    const checks = [check("tidy", "tidy", "pass"), check("index-coverage", "see", "pass"), check("jev-key", "jev", "warn")];
    const rows = groupChecks(checks);
    expect(rows.map((r) => r.group)).toEqual(["see", "jev", "tidy"]);
  });

  it("keeps each group's checks in their given order", () => {
    const checks = [check("a", "code", "pass"), check("b", "code", "fail")];
    const rows = groupChecks(checks);
    expect(rows[0]!.checks.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("toFixCount", () => {
  it("counts warn and fail, not pass or unknown", () => {
    const checks = [check("a", "see", "pass"), check("b", "see", "warn"), check("c", "see", "fail"), check("d", "see", "unknown")];
    expect(toFixCount(checks)).toBe(2);
  });
});

describe("one issue count (the ring and the Issues heading agree)", () => {
  const snooze = { kind: "snooze" as const, at: "2026-10-27T08:00:00.000Z", until: "2026-11-03T08:00:00.000Z", reason: null };
  const checks = [
    check("a", "see", "pass"),
    check("b", "see", "warn"),
    check("c", "see", "fail"),
    check("d", "see", "unknown"),
    check("e", "see", "unknown"),
    { ...check("f", "see", "fail"), dismissed: snooze },
  ];

  it("to fix = warn/fail not set aside; unmeasured and set-aside counted apart", () => {
    expect(issueCounts(checks)).toEqual({ toFix: 2, unmeasured: 2, dismissed: 1 });
    expect(toFixCount(checks)).toBe(issueCounts(checks).toFix);
    expect(issuesCaption(issueCounts(checks))).toBe("2 things to fix · 2 not measured · 1 set aside");
    expect(issuesCaption({ toFix: 0, unmeasured: 0, dismissed: 0 })).toBe("Nothing to fix right now");
  });

  it("the Issues list keeps dismissed checks, muted at the end", () => {
    expect(issuesList(checks).map((c) => c.id)).toEqual(["c", "b", "d", "e", "f"]);
  });

  it("says what the dismissal is", () => {
    expect(dismissalText(snooze, "en-US")).toBe("Snoozed until Nov 3");
    expect(dismissalText({ ...snooze, kind: "wont-fix", until: null })).toBe("Won't fix");
    expect(dismissalText({ ...snooze, kind: "wont-fix", until: null, reason: "no tmux here" })).toBe("Won't fix: no tmux here");
  });
});

describe("buildFpsCheck", () => {
  it("unknown before any samples exist", () => {
    expect(buildFpsCheck(null).state).toBe("unknown");
  });
  it("passes at/above 40 fps, no fix offered", () => {
    const c = buildFpsCheck(45);
    expect(c.state).toBe("pass");
    expect(c.fixLabel).toBeUndefined();
  });
  it("warns below 40 fps and offers to lower quality", () => {
    const c = buildFpsCheck(25);
    expect(c.state).toBe("warn");
    expect(c.fixLabel).toBe("Lower quality");
  });
  it("no WebGL: unknown with the real reason, never 'open Orbit' (it would not help) and no fix", () => {
    const c = buildFpsCheck(null, { state: "off", reason: "the browser returned no WebGL context" });
    expect(c.state).toBe("unknown");
    expect(c.detail).toContain("the browser returned no WebGL context");
    expect(c.detail).not.toContain("open Orbit");
    expect(c.fixLabel).toBeUndefined();
  });
  it("context lost: a stale median from before the loss is not reported as a frame rate", () => {
    const c = buildFpsCheck(12, { state: "lost" });
    expect(c.state).toBe("unknown");
    expect(c.detail).toContain("context was lost");
    expect(c.fixLabel).toBeUndefined();
  });
  it("WebGL on (or not reported yet): unchanged", () => {
    expect(buildFpsCheck(45, { state: "on" })).toEqual(buildFpsCheck(45));
    expect(buildFpsCheck(null, undefined)).toEqual(buildFpsCheck(null));
  });
  it("a low frame rate on an overloaded machine is unknown, with the load in the reason", () => {
    const c = buildFpsCheck(18, { state: "on" }, { load1: 58.2, cpus: 12 });
    expect(c.state).toBe("unknown");
    expect(c.detail).toContain("load 58.2 on 12 cores");
    expect(c.fixLabel).toBeUndefined();
  });
  it("a low frame rate on a quiet machine still warns, and a good one still passes when busy", () => {
    expect(buildFpsCheck(18, { state: "on" }, { load1: 3, cpus: 12 }).state).toBe("warn");
    expect(buildFpsCheck(55, { state: "on" }, { load1: 58, cpus: 12 }).state).toBe("pass");
  });
});

describe("WHY_IT_MATTERS / FIX_STEPS: every check id from CHECK_META is covered or intentionally not", () => {
  const ids = Object.keys(CHECK_META) as CompletenessCheckId[];
  it("has a why-it-matters line for every known check id", () => {
    for (const id of ids) expect(WHY_IT_MATTERS[id], `missing WHY_IT_MATTERS for "${id}"`).toBeTruthy();
  });
  it("fix steps are non-empty arrays where present", () => {
    for (const id of ids) {
      const steps = FIX_STEPS[id];
      if (steps !== undefined) expect(steps.length).toBeGreaterThan(0);
    }
  });
});

describe("severityRank / issuesList", () => {
  it("ranks fail above warn above unknown/pass", () => {
    const fail = check("a", "code", "fail");
    const warn = check("b", "code", "warn");
    const unknown = check("c", "code", "unknown");
    expect(severityRank(fail)).toBeGreaterThan(severityRank(warn));
    expect(severityRank(warn)).toBeGreaterThan(severityRank(unknown));
  });
  it("breaks ties within the same state by weight", () => {
    const light = { ...check("a", "code", "warn"), weight: 1 };
    const heavy = { ...check("b", "code", "warn"), weight: 3 };
    expect(severityRank(heavy)).toBeGreaterThan(severityRank(light));
  });
  it("issuesList excludes pass and sorts worst-first", () => {
    const pass = { ...check("p", "code", "pass"), weight: 3 };
    const warn = { ...check("w", "code", "warn"), weight: 1 };
    const fail = { ...check("f", "code", "fail"), weight: 1 };
    const unknown = { ...check("u", "code", "unknown"), weight: 1 };
    const out = issuesList([pass, warn, fail, unknown]);
    expect(out.map((c) => c.id)).toEqual(["f", "w", "u"]);
  });
});

describe("confidenceBadge", () => {
  it("shows the measured badge by default (no confidence set)", () => {
    expect(confidenceBadge({})).toBe("✅ measured");
  });
  it("shows each explicit level", () => {
    expect(confidenceBadge({ confidence: "measured" })).toBe("✅ measured");
    expect(confidenceBadge({ confidence: "reported" })).toBe("📣 reported");
    expect(confidenceBadge({ confidence: "guess" })).toBe("🧪 guess");
  });
});

describe("testsResultMessage", () => {
  it("reads 'Tests: N passed, M failing.' on a completed run, even with failures", () => {
    expect(testsResultMessage({ ok: true, total: 10, passed: 8, failed: 2 })).toBe("Tests: 8 passed, 2 failing.");
    expect(testsResultMessage({ ok: true, total: 5, passed: 5, failed: 0 })).toBe("Tests: 5 passed, 0 failing.");
  });
  it("derives passed from total/failed when the server didn't send it", () => {
    expect(testsResultMessage({ ok: true, total: 10, failed: 3 })).toBe("Tests: 7 passed, 3 failing.");
  });
  it("reads 'Tests couldn't run: <reason>' when the run itself failed", () => {
    expect(testsResultMessage({ ok: false, error: "timed out" })).toBe("Tests couldn't run: timed out");
  });
  it("never reads blank when the run failed with no error text", () => {
    expect(testsResultMessage({ ok: false })).toBe("Tests couldn't run: no reason given");
  });
  it("is generous enough that a real 2000+ test run outlives it, unlike postJson's old 20s default", () => {
    expect(TESTS_RUN_TIMEOUT_MS).toBeGreaterThan(20_000); // postJson's old default — the actual bug
    expect(TESTS_RUN_TIMEOUT_MS).toBe(200_000); // ≥ the server's own 180s ceiling, with margin
  });
});

describe("medianFps", () => {
  it("null with no samples", () => {
    expect(medianFps([])).toBeNull();
  });
  it("the middle value for an odd count", () => {
    expect(medianFps([10, 60, 30])).toBe(30);
  });
  it("the average of the two middle values for an even count", () => {
    expect(medianFps([10, 20, 30, 40])).toBe(25);
  });
  it("ignores sample order", () => {
    expect(medianFps([60, 10, 40, 20, 30])).toBe(30);
  });
});

describe("Trust these N folders (POST /api/trust/bulk)", () => {
  it("labels the one button with the count it will trust", () => {
    expect(trustAllLabel(22)).toBe("Trust these 22 folders");
    expect(trustAllLabel(1)).toBe("Trust this folder");
  });

  it("success says how many are trusted now, counting the ones Claude already had", () => {
    expect(bulkTrustSuccessText({ trusted: 22, already: 0 })).toBe("Trusted 22 folders: launches there start without the trust dialog.");
    expect(bulkTrustSuccessText({ trusted: 20, already: 2 })).toBe("Trusted 22 folders (2 were already trusted): launches there start without the trust dialog.");
  });

  it("a partial failure says what was trusted and names each folder that wasn't, with the reason", () => {
    const r = {
      trusted: 20,
      already: 0,
      refused: 2,
      results: [
        ...Array.from({ length: 20 }, (_, i) => ({ path: `/Users/s/Code/p${i}`, outcome: "trusted" as const })),
        { path: "/Users/s/Code/gone", outcome: "refused" as const, error: "folder not found" },
        { path: "/Users/s/Code/busy", outcome: "refused" as const, error: "Claude Code is writing ~/.claude.json right now" },
      ],
    };
    expect(bulkTrustFailureText(r)).toBe("Trusted 20 of 22 folders; not trusted: gone (folder not found); busy (Claude Code is writing ~/.claude.json right now).");
  });

  it("a request refused as a whole (no per-folder results) falls back to runAction's default text", () => {
    expect(bulkTrustFailureText({ trusted: 0, already: 0, refused: 0, results: [] })).toBeNull();
  });
});
