// jobs-lib: what a Job chip shows, how a fetched /api/jobs/:id body is validated, the client cache
// (sessions from the push are authoritative, fetched ids expire), and the shared wire parsers the
// client relies on (nothing off the wire is trusted).

import { describe, expect, it } from "vitest";
import { parseJobsByAgent, parseJobsCounts, parseJobsMessage } from "../../../shared/features/jobs";
import { chipView, FETCHED_TTL_MS, JobCache, verdictFromEntry } from "./jobs-lib";

describe("chipView", () => {
  it("a job shows its name, the signal and the rule + precedence in the tooltip", () => {
    const v = chipView({ job: "lawyer", reason: "used legal-data-hunter x12" });
    expect(v).toMatchObject({ kind: "lawyer", label: "lawyer", reason: "used legal-data-hunter x12" });
    expect(v.title).toContain("legal-* MCP");
    expect(v.title).toContain("lawyer > hacker > learner > builder > gatherer");
  });

  it("no evidence is shown as such, never as a job", () => {
    expect(chipView({ job: null, reason: "no job evidence" })).toMatchObject({ kind: "none", label: "no job evidence", reason: "" });
  });

  it("an unknown id (not computed yet, a 404 or a network failure) says so", () => {
    expect(chipView(null)).toMatchObject({ kind: "unknown", label: "job not computed yet", reason: "" });
  });
});

describe("verdictFromEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(verdictFromEntry({ id: "a1", kind: "subagent", job: "hacker", reason: "agent type code-reviewer" })).toEqual({ job: "hacker", reason: "agent type code-reviewer" });
    expect(verdictFromEntry({ id: "s1", kind: "session", job: null, reason: "no job evidence" })).toEqual({ job: null, reason: "no job evidence" });
  });

  it("rejects anything malformed, and a 404 (getJson's null)", () => {
    expect(verdictFromEntry(null)).toBeNull();
    expect(verdictFromEntry({ ok: false, error: "no such session or subagent" })).toBeNull();
    expect(verdictFromEntry({ id: "a1", kind: "subagent", job: "wizard", reason: "x" })).toBeNull();
    expect(verdictFromEntry({ id: "a1", kind: "robot", job: "builder", reason: "x" })).toBeNull();
    expect(verdictFromEntry({ id: "a1", kind: "subagent", job: "builder" })).toBeNull();
  });

  it("caps an oversized reason", () => {
    expect(verdictFromEntry({ id: "a1", kind: "subagent", job: "builder", reason: "x".repeat(5000) })?.reason).toHaveLength(200);
  });
});

describe("JobCache", () => {
  it("sessions from the push win, and are replaced whole by the next push", () => {
    const c = new JobCache();
    c.setSessions({ s1: { job: "builder", reason: "Edit/Write x1" } });
    expect(c.get("s1", 0)).toEqual({ job: "builder", reason: "Edit/Write x1" });
    c.setSessions({});
    expect(c.get("s1", 0)).toBeUndefined();
  });

  it("a fetched verdict is reused for a minute, then fetched again", () => {
    const c = new JobCache();
    c.put("a1", { job: "gatherer", reason: "Read x3; no writes" }, 1_000);
    expect(c.get("a1", 1_000 + FETCHED_TTL_MS - 1)?.job).toBe("gatherer");
    expect(c.get("a1", 1_000 + FETCHED_TTL_MS)).toBeUndefined();
  });

  it("never reads an id off the object prototype", () => {
    const c = new JobCache();
    c.setSessions(parseJobsByAgent(JSON.parse('{"__proto__": {"job": "hacker", "reason": "x"}, "toString": {"job": "builder", "reason": "y"}}')));
    expect(c.get("__proto__", 0)).toBeUndefined();
    expect(c.get("constructor", 0)).toBeUndefined();
    expect(c.get("toString", 0)).toEqual({ job: "builder", reason: "y" });
  });
});

describe("wire parsers", () => {
  const counts = { lawyer: 1, hacker: 2, learner: 3, builder: 4, gatherer: 5, none: 6 };

  it("parses a jobs message and drops bad entries", () => {
    const m = parseJobsMessage({ kind: "jobs", counts: { sessions: counts, subagents: null }, byAgent: { s1: { job: "learner", reason: "wrote memory/a.md" }, s2: { job: "chef", reason: "x" }, s3: "builder" } });
    expect(m).toEqual({ kind: "jobs", counts: { sessions: counts, subagents: null }, byAgent: { s1: { job: "learner", reason: "wrote memory/a.md" } } });
  });

  it("rejects counts that aren't finite, non-negative numbers", () => {
    expect(parseJobsCounts({ sessions: { ...counts, none: -1 }, subagents: null })).toBeNull();
    expect(parseJobsCounts({ sessions: { ...counts, lawyer: "1" }, subagents: null })).toBeNull();
    expect(parseJobsCounts({ sessions: counts, subagents: counts })).toEqual({ sessions: counts, subagents: counts });
    expect(parseJobsMessage({ kind: "other" })).toBeNull();
  });
});
