// Wiring test for the completeness feature's onSnapshot/onMessage (the actual bug this covers:
// the pure lib (workspace-lib.test.ts's healthCandidates tests) always stamped `generatedAt =
// now`, hiding the fact that the wired client only ever refreshed its cached Health summary at
// boot / a WS reconnect — never on a live recompute — so a page-load-old summary could sit in
// the Town square looking current for up to ~63 minutes. See PR #44's review findings.
//
// No jsdom in this repo (vitest defaults to the "node" environment; see vitest.config.ts) — the
// business logic under test (parsing, the score-drop feed push, the cached-summary refresh) has
// no DOM dependency of its own, so the only stub needed is `document.getElementById` for
// paintChip's chip lookup (real DOM element lookup, correctly a no-op with nothing mounted).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompletenessCheck } from "../../../shared/features/completeness";
import type { WorldSnapshot } from "../../../shared/types";
import type { FeedItem } from "../shell/feed-types";
import { completenessFeature, currentHealthSummary } from "./completeness";
import type { ClientContext, FeatureMessage } from "./registry";

beforeAll(() => {
  (globalThis as unknown as { document: { getElementById(): null } }).document = { getElementById: () => null };
});
afterAll(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

const liveVisibleFail: CompletenessCheck = { id: "live-visible", label: "Live sessions are visible", group: "see", weight: 3, state: "fail", detail: "2 live claude processes, 0 visible", confidence: "measured" };
const routinesWarn: CompletenessCheck = { id: "routines", label: "Routines are healthy", group: "routines", weight: 2, state: "warn", detail: "At least one routine's last run exited non-zero.", confidence: "measured" };

function fakeCtx(pushed: FeedItem[]): ClientContext {
  return {
    feed: {
      push: (items: FeedItem | readonly FeedItem[]): boolean => {
        pushed.push(...(Array.isArray(items) ? items : [items]));
        return true;
      },
      resolve: () => {},
    },
  } as unknown as ClientContext;
}

describe("completeness client feature: onSnapshot + onMessage keep the cached Health summary current", () => {
  it("onSnapshot stamps generatedAt from the SERVER's summary, not this session's clock", () => {
    const serverGeneratedAt = "2026-09-28T03:25:00.000Z"; // deliberately not "now"
    const pushed: FeedItem[] = [];
    completenessFeature.onSnapshot?.(
      { extras: { "completeness.summary": { generatedAt: serverGeneratedAt, score: 60, checks: [liveVisibleFail] } } } as unknown as WorldSnapshot,
      fakeCtx(pushed),
    );
    expect(currentHealthSummary()?.generatedAt).toBe(serverGeneratedAt);
    expect(currentHealthSummary()?.checks).toEqual([liveVisibleFail]);
  });

  it("onMessage exists and refreshes the cache on a live recompute — a check that starts failing mid-session reaches it without a reload", () => {
    expect(typeof completenessFeature.onMessage).toBe("function");
    const laterGeneratedAt = "2026-09-28T03:26:00.000Z";
    const pushed: FeedItem[] = [];
    const msg: FeatureMessage = { type: "feature", feature: "completeness", payload: { kind: "summary", generatedAt: laterGeneratedAt, score: 45, checks: [liveVisibleFail, routinesWarn] } };
    completenessFeature.onMessage?.(msg, fakeCtx(pushed));
    expect(currentHealthSummary()?.generatedAt).toBe(laterGeneratedAt);
    expect(currentHealthSummary()?.checks).toEqual([liveVisibleFail, routinesWarn]);
  });

  it("a 5+ point score drop across two live messages still feeds a real Feed item (unchanged behavior, now reachable outside onSnapshot too)", () => {
    const pushed: FeedItem[] = [];
    const ctx = fakeCtx(pushed);
    completenessFeature.onMessage?.({ type: "feature", feature: "completeness", payload: { kind: "summary", generatedAt: "2026-09-28T03:30:00.000Z", score: 80, checks: [] } }, ctx);
    completenessFeature.onMessage?.({ type: "feature", feature: "completeness", payload: { kind: "summary", generatedAt: "2026-09-28T03:31:00.000Z", score: 70, checks: [] } }, ctx);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ title: "Health score dropped to 70%", detail: "Was 80% — open 🩺 Health to see what changed." });
  });

  it("a foreign or malformed 'feature' message is ignored, not thrown on", () => {
    const before = currentHealthSummary();
    const pushed: FeedItem[] = [];
    const ctx = fakeCtx(pushed);
    expect(() => completenessFeature.onMessage?.({ type: "feature", feature: "completeness", payload: { kind: "board", board: {} } }, ctx)).not.toThrow();
    expect(() => completenessFeature.onMessage?.({ type: "feature", feature: "completeness", payload: null }, ctx)).not.toThrow();
    expect(() => completenessFeature.onMessage?.({ type: "feature", feature: "completeness", payload: { kind: "summary", score: "not a number", checks: [] } }, ctx)).not.toThrow();
    expect(currentHealthSummary()).toBe(before); // untouched by any of the three
  });
});
