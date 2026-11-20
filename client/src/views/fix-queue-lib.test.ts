import { describe, expect, it } from "vitest";
import { emptyFixCounts, type FixLaunch } from "../../../shared/features/fixes";
import { asideText, chipQueueLine, dismissRequest, isFixesResponse, launchLine, queueCaption, rowMeta } from "./fix-queue-lib";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const launch = (p: Partial<FixLaunch> = {}): FixLaunch => ({ at: new Date(NOW - 3 * 3_600_000).toISOString(), tmuxName: "aw-12ab", sessionId: null, outcome: null, outcomeReason: null, ...p });

describe("Fix queue lib", () => {
  it("sends a Health row's snooze to the check's own dismissal, every other row to /api/fixes", () => {
    expect(dismissRequest({ id: "health:jev-key", source: "health" }, "snooze")).toEqual({ url: "/api/completeness/jev-key/dismiss", body: { kind: "snooze", days: 7 } });
    expect(dismissRequest({ id: "vault-ghost:A / B", source: "vault-ghost" }, null)).toEqual({ url: "/api/fixes/vault-ghost%3AA%20%2F%20B/undismiss", body: {} });
  });

  it("reads where a row came from, its district and its age", () => {
    expect(rowMeta({ source: "sickness", cityId: "demo", since: new Date(NOW - 2 * 86_400_000).toISOString() }, NOW, (id) => id.toUpperCase())).toBe("Sickness · DEMO · since 2d ago");
    expect(rowMeta({ source: "vault-project", cityId: null, since: null }, NOW)).toBe("Vault");
  });

  it("follows a fix's session from its tmux name to its verdict", () => {
    expect(launchLine(launch(), NOW)).toBe("Fix started 3h ago in aw-12ab, waiting for its session to appear");
    expect(launchLine(launch({ tmuxName: null }), NOW)).toBe("Fix started 3h ago in a plain Terminal (Alef can't follow it)");
    expect(launchLine(launch({ sessionId: "0123456789abcdef" }), NOW)).toBe("Fix started 3h ago · session 01234567 · no verdict yet");
    expect(launchLine(launch({ sessionId: "0123456789abcdef", outcome: "shipped", outcomeReason: "o/r#3 merged" }), NOW)).toBe("Fix started 3h ago · session 01234567 · shipped: o/r#3 merged");
  });

  it("says what a set-aside row is", () => {
    expect(asideText({ dismissed: { kind: "wont-fix", at: new Date(NOW - 86_400_000).toISOString(), until: null, reason: null } }, NOW)).toBe("Won't fix (set 1d ago)");
    expect(asideText({ dismissed: null }, NOW)).toBe("");
  });

  it("captions the queue by source and names what is still being read, never as zero", () => {
    const open = { ...emptyFixCounts(), health: 2, "vault-project": 1, "vault-ghost": 2 };
    expect(queueCaption({ open, pending: [] })).toBe("5 to fix: 2 Health, 3 Vault");
    expect(queueCaption({ open: emptyFixCounts(), pending: ["vault-project", "vault-ghost", "abandoned"] })).toBe("Nothing to fix · still reading the vault, session outcomes");
  });

  it("feeds the Health chip's tooltip one plural-correct line", () => {
    expect(chipQueueLine(null)).toBe("");
    expect(chipQueueLine(0)).toBe("Fix queue: nothing to fix");
    expect(chipQueueLine(1)).toBe("Fix queue: 1 thing to fix");
    expect(chipQueueLine(4)).toBe("Fix queue: 4 things to fix");
  });

  it("accepts only a queue-shaped answer", () => {
    expect(isFixesResponse({ ok: true, rows: [], open: emptyFixCounts(), pending: [], generatedAt: "x" })).toBe(true);
    expect(isFixesResponse({ ok: false, error: "x" })).toBe(false);
    expect(isFixesResponse(null)).toBe(false);
  });
});
