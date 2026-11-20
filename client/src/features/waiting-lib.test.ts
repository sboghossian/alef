import { describe, expect, it } from "vitest";
import { countWaiting, faviconHref, titleFor, waitingIds, waitingTransition } from "./waiting-lib";

describe("titleFor", () => {
  it("leaves the view title alone when nobody is waiting", () => {
    expect(titleFor("Alef", 0)).toBe("Alef");
    expect(titleFor("Board · Alef", 0)).toBe("Board · Alef");
  });

  it("prefixes the count when one or more agents are waiting", () => {
    expect(titleFor("Alef", 1)).toBe("(1) Alef");
    expect(titleFor("Board · Alef", 2)).toBe("(2) Board · Alef");
  });

  it("never goes negative even if a caller passes a bad count", () => {
    expect(titleFor("Alef", -1)).toBe("Alef");
  });
});

describe("waitingIds / countWaiting", () => {
  it("counts only agents with awaitingInput true", () => {
    const agents = [
      { id: "a", awaitingInput: true },
      { id: "b", awaitingInput: false },
      { id: "c", awaitingInput: true },
    ];
    expect(waitingIds(agents)).toEqual(new Set(["a", "c"]));
    expect(countWaiting(agents)).toBe(2);
  });

  it("is zero for an empty or all-not-waiting list", () => {
    expect(countWaiting([])).toBe(0);
    expect(countWaiting([{ id: "a", awaitingInput: false }])).toBe(0);
  });
});

describe("waitingTransition", () => {
  it("fires on a false → true transition", () => {
    const prev = new Set(["a"]);
    const agents = [
      { id: "a", awaitingInput: true }, // already waiting — no fire
      { id: "b", awaitingInput: true }, // newly waiting — fires
    ];
    const { fired, now } = waitingTransition(prev, agents);
    expect(fired).toEqual(["b"]);
    expect(now).toEqual(new Set(["a", "b"]));
  });

  it("does not fire again while an agent stays waiting (true → true)", () => {
    const prev = new Set(["a"]);
    const agents = [{ id: "a", awaitingInput: true }];
    expect(waitingTransition(prev, agents).fired).toEqual([]);
  });

  it("re-arms after a true → false → true cycle", () => {
    const waitingAgent = (waiting: boolean) => [{ id: "a", awaitingInput: waiting }];

    // starts waiting
    let state = waitingTransition(new Set(), waitingAgent(true));
    expect(state.fired).toEqual(["a"]);

    // stops waiting — drops out of the tracked set
    state = waitingTransition(state.now, waitingAgent(false));
    expect(state.fired).toEqual([]);
    expect(state.now.has("a")).toBe(false);

    // starts waiting again — fires again
    state = waitingTransition(state.now, waitingAgent(true));
    expect(state.fired).toEqual(["a"]);
  });

  it("seeded from the first snapshot never fires for agents already waiting at load", () => {
    const agents = [
      { id: "a", awaitingInput: true },
      { id: "b", awaitingInput: true },
    ];
    // Seed `prev` from the first snapshot itself (not an empty set) — the caller's contract.
    const seeded = waitingIds(agents);
    expect(waitingTransition(seeded, agents).fired).toEqual([]);

    // A genuinely new agent starting to wait afterwards still fires.
    const next = [...agents, { id: "c", awaitingInput: true }];
    expect(waitingTransition(seeded, next).fired).toEqual(["c"]);
  });

  it("an empty initial prev (no seeding) would incorrectly fire for pre-existing waiters", () => {
    // Documents WHY seeding matters: starting from an empty set treats every already-waiting
    // agent as newly waiting, which is exactly the false notification the seeding contract avoids.
    const agents = [{ id: "a", awaitingInput: true }];
    expect(waitingTransition(new Set(), agents).fired).toEqual(["a"]);
  });
});

describe("faviconHref", () => {
  it("returns a data: SVG URI", () => {
    expect(faviconHref(0).startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("differs between waiting and not waiting", () => {
    expect(faviconHref(0)).not.toBe(faviconHref(1));
  });

  it("is stable for any positive count (a badge, not a number)", () => {
    expect(faviconHref(1)).toBe(faviconHref(5));
  });
});
