import { describe, expect, it } from "vitest";
import type { Automation } from "../../../shared/features/automations";
import { cityForOutputDir, countdown, emojiOf, groupAutomations, groupOf, readerStyle, runFinished, shortDescription, statusOf, workflowPrompt } from "./automations-lib";

const base: Automation = {
  id: "x",
  name: "x",
  description: null,
  kind: "launchd",
  launchdLabel: "com.stephane.x",
  skill: null,
  schedule: null,
  nextRunAt: null,
  lastRunAt: null,
  lastExitStatus: null,
  running: false,
  runnable: true,
  dispatchCommand: null,
  latestOutput: null,
  outputDir: null,
  link: null,
};

describe("groupOf", () => {
  it.each([
    ["yalla-brief", "rituals"],
    ["daily-recap", "rituals"],
    ["inbox-sweep", "rituals"],
    ["artifact-ritual", "rituals"],
    ["ig-innovation", "growth"],
    ["linkedin-post", "growth"],
    ["plg-ritual", "growth"],
    ["eulex-bench", "growth"],
    ["brain-sync", "brain"],
    ["vault-sync", "brain"],
    ["auto-capture", "brain"],
    ["connection-synthesis", "brain"],
    ["worktree-janitor", "dev"],
    ["rotate-logs", "dev"],
    ["something-new", "dev"],
  ])("%s → %s", (id, g) => expect(groupOf({ id })).toBe(g));
});

describe("statusOf", () => {
  it("running / ok / failed / killed / never", () => {
    expect(statusOf({ ...base, running: true }).status).toBe("running");
    expect(statusOf({ ...base, lastExitStatus: 0, lastRunAt: "2026-09-25T00:00:00Z" })).toEqual({ status: "ok", label: "last run ok" });
    expect(statusOf({ ...base, lastExitStatus: 1, lastRunAt: "x" })).toEqual({ status: "failed", label: "failed (exit 1)" });
    expect(statusOf({ ...base, lastExitStatus: -15, lastRunAt: "x" })).toEqual({ status: "failed", label: "killed (signal 15)" });
    expect(statusOf(base).status).toBe("never");
  });
});

describe("countdown", () => {
  const now = Date.parse("2026-09-25T10:00:00Z");
  it("formats", () => {
    expect(countdown(null, now)).toBeNull();
    expect(countdown("garbage", now)).toBeNull();
    expect(countdown("2026-09-25T09:00:00Z", now)).toBe("due now");
    expect(countdown("2026-09-25T10:00:45Z", now)).toBe("in 45s");
    expect(countdown("2026-09-25T10:05:10Z", now)).toBe("in 5m 10s");
    expect(countdown("2026-09-25T12:14:00Z", now)).toBe("in 2h 14m");
    expect(countdown("2026-09-27T13:00:00Z", now)).toBe("in 2d 3h");
  });
});

describe("misc", () => {
  it("shortDescription keeps the first sentence and clips", () => {
    expect(shortDescription("Rebuild the dispatch — the 08:00 artifact. Collects from Linear.")).toBe("Rebuild the dispatch — the 08:00 artifact.");
    expect(shortDescription(null)).toBe("");
    expect(shortDescription("a".repeat(400)).length).toBe(150);
  });

  it("runFinished: only a newer, non-running run counts", () => {
    const started = Date.parse("2026-09-25T10:00:00Z");
    expect(runFinished({ running: true, lastRunAt: "2026-09-25T10:01:00Z" }, started)).toBe(false);
    expect(runFinished({ running: false, lastRunAt: "2026-09-24T10:01:00Z" }, started)).toBe(false);
    expect(runFinished({ running: false, lastRunAt: "2026-09-25T10:01:00Z" }, started)).toBe(true);
    expect(runFinished({ running: false, lastRunAt: null }, started)).toBe(false);
  });

  it("readerStyle + emoji", () => {
    expect(readerStyle("yalla-brief")).toBe("newspaper");
    expect(readerStyle("daily-recap")).toBe("cards");
    expect(readerStyle("inbox-sweep")).toBe("doc");
    expect(emojiOf({ id: "yalla-brief" })).toBe("🗞️");
    expect(emojiOf({ id: "unknown-thing" })).toBe("🛠️");
  });

  it("groupAutomations sorts by next run, unscheduled last", () => {
    const g = groupAutomations([
      { ...base, id: "rotate-logs", name: "b", nextRunAt: null },
      { ...base, id: "worktree-janitor", name: "a", nextRunAt: "2026-09-26T00:00:00Z" },
      { ...base, id: "prune-sessions", name: "c", nextRunAt: "2026-09-25T00:00:00Z" },
    ]);
    expect(g.get("dev")?.map((a) => a.id)).toEqual(["prune-sessions", "worktree-janitor", "rotate-logs"]);
  });
});

describe("workflowPrompt", () => {
  it("uses the real dispatch command when known", () => {
    expect(workflowPrompt({ name: "yalla-brief", description: "does things", dispatchCommand: "/yalla-brief" })).toBe("/yalla-brief");
  });
  it("falls back to name + description when there's no skill command", () => {
    expect(workflowPrompt({ name: "some-job", description: "backs up the vault", dispatchCommand: null })).toBe("Run some-job: backs up the vault");
  });
  it("falls back to just the name when there's no description either", () => {
    expect(workflowPrompt({ name: "some-job", description: null, dispatchCommand: null })).toBe("Run some-job.");
  });
});

describe("cityForOutputDir", () => {
  const islands = [
    { id: "yalla-brief", path: "/Users/s/Documents/Code/yalla-brief" },
    { id: "alex_claude", path: "/Users/s/Documents/Code/alex_claude" },
  ];
  it("matches a directory under a known island's path", () => {
    expect(cityForOutputDir("/Users/s/Documents/Code/yalla-brief/out", islands)).toBe("yalla-brief");
  });
  it("matches the island's path exactly", () => {
    expect(cityForOutputDir("/Users/s/Documents/Code/alex_claude", islands)).toBe("alex_claude");
  });
  it("prefers the more specific (longer) match", () => {
    const nested = [...islands, { id: "alex_claude-60-meta", path: "/Users/s/Documents/Code/alex_claude/60-Meta" }];
    expect(cityForOutputDir("/Users/s/Documents/Code/alex_claude/60-Meta/dashboards", nested)).toBe("alex_claude-60-meta");
  });
  it("null when nothing matches, or there's no output dir", () => {
    expect(cityForOutputDir("/Users/s/.claude/skills/ig-innovation/verdicts", islands)).toBeNull();
    expect(cityForOutputDir(null, islands)).toBeNull();
  });
  it("never matches a sibling directory that merely shares a prefix", () => {
    const tricky = [{ id: "yalla", path: "/Users/s/Documents/Code/yalla" }];
    expect(cityForOutputDir("/Users/s/Documents/Code/yalla-brief/out", tricky)).toBeNull();
  });
});
