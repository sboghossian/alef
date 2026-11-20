import { describe, expect, it } from "vitest";
import type { ServerMessage, WorldSnapshot } from "../../../shared/types";
import { clientFeatures } from "./index";
import { ClientFeatureHost, type ClientContext, type ClientFeature, type FeatureMessage } from "./registry";

// The host never dereferences ctx itself; it only passes it through to hooks.
const ctx = {} as ClientContext;

const world: WorldSnapshot = {
  generatedAt: "2026-09-24T00:00:00Z",
  stats: { liveCount: 0, awaitingCount: 0, tokensToday: 0 },
  islands: [],
  agents: [],
  objects: [],
  edges: [],
  jev: { status: "disabled", lastTickAt: null, decisions: [] },
  extras: { "weather.now": "rain" },
};

describe("ClientFeatureHost", () => {
  it("rejects duplicate feature ids and duplicate panel ids", () => {
    expect(() => new ClientFeatureHost([{ id: "a" }, { id: "a" }], ctx)).toThrow(/duplicate client feature/);
    const panel = { id: "p", title: "P", render: () => {} };
    expect(() => new ClientFeatureHost([{ id: "a", panels: [panel] }, { id: "b", panels: [panel] }], ctx)).toThrow(/duplicate panel/);
  });

  it("routes feature messages only to the feature whose id matches", () => {
    const got: string[] = [];
    const mk = (id: string): ClientFeature => ({ id, onMessage: (msg: FeatureMessage) => void got.push(`${id}<-${String(msg.payload)}`) });
    const host = new ClientFeatureHost([mk("todos"), mk("weather")], ctx);
    expect(host.message({ type: "feature", feature: "weather", payload: "rain" })).toBe(true);
    expect(host.message({ type: "feature", feature: "nobody", payload: 1 })).toBe(true);
    const stats: ServerMessage = { type: "stats", stats: { liveCount: 1, awaitingCount: 0, tokensToday: 0 } };
    expect(host.message(stats)).toBe(false);
    expect(got).toEqual(["weather<-rain"]);
  });

  it("mount runs mount then onSnapshot with the initial world; a throwing feature does not stop the others", () => {
    const order: string[] = [];
    const host = new ClientFeatureHost(
      [
        { id: "bad", mount: () => { throw new Error("boom"); } },
        { id: "ok", mount: () => void order.push("mount"), onSnapshot: (w) => void order.push(`snap:${String(w.extras?.["weather.now"])}`) },
      ],
      ctx,
    );
    host.mount(world);
    expect(order).toEqual(["mount", "snap:rain"]);
  });

  it("disables a throwing onFrame after the first error but keeps other features ticking", () => {
    let bad = 0;
    let good = 0;
    const host = new ClientFeatureHost(
      [
        { id: "bad", onFrame: () => { bad++; throw new Error("boom"); } },
        { id: "good", onFrame: () => void good++ },
      ],
      ctx,
    );
    host.frame(0.016);
    host.frame(0.016);
    expect(bad).toBe(1);
    expect(good).toBe(2);
  });

  it("escape stops at the first feature that consumes it", () => {
    const asked: string[] = [];
    const host = new ClientFeatureHost(
      [
        { id: "a", onEscape: () => (asked.push("a"), false) },
        { id: "b", onEscape: () => (asked.push("b"), true) },
        { id: "c", onEscape: () => (asked.push("c"), true) },
      ],
      ctx,
    );
    expect(host.escape()).toBe(true);
    expect(asked).toEqual(["a", "b"]);
    expect(new ClientFeatureHost([{ id: "x" }], ctx).escape()).toBe(false);
  });

  it("namespaces palette commands by feature id and runs them by that id", () => {
    let ran = 0;
    const host = new ClientFeatureHost([{ id: "weather", paletteCommands: () => [{ id: "refresh", title: "Refresh weather", run: () => void ran++ }] }], ctx);
    expect(host.paletteCommands().map((c) => c.id)).toEqual(["weather:refresh"]);
    expect(host.runCommand("weather:refresh")).toBe(true);
    expect(host.runCommand("refresh")).toBe(false);
    expect(ran).toBe(1);
  });

  it("a throwing or rejecting palette command becomes an error toast, not an uncaught error", async () => {
    const toasts: Array<[string, string | undefined]> = [];
    const withToast = { toast: (t: string, k?: "info" | "error") => void toasts.push([t, k]) } as ClientContext;
    const host = new ClientFeatureHost(
      [
        {
          id: "mac",
          paletteCommands: () => [
            { id: "boom", title: "Lock the screen", run: () => { throw new Error("Error: osascript failed\nstack"); } },
          ],
        },
      ],
      withToast,
    );
    expect(() => host.runCommand("mac:boom")).not.toThrow();
    expect(host.runCommand("mac:boom")).toBe(true);
    expect(toasts[0]).toEqual(["Lock the screen failed: osascript failed", "error"]);
    // A command that returns its promise gets its rejection caught too.
    const asyncHost = new ClientFeatureHost(
      [{ id: "w", paletteCommands: () => [{ id: "sync", title: "Sync weather", run: () => Promise.reject(new Error("world server unreachable")) }] }],
      withToast,
    );
    expect(asyncHost.runCommand("w:sync")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(toasts.at(-1)).toEqual(["Sync weather failed: Alef's server didn't answer (it may be restarting). Try again in a few seconds.", "error"]);
  });

  it("exposes hud buttons with their owner and finds panels across features", () => {
    const host = new ClientFeatureHost(
      [
        { id: "a", hudButtons: [{ id: "go", label: "Go", title: "Go", onClick: () => {} }] },
        { id: "b", panels: [{ id: "b-panel", title: "B", render: () => {} }] },
      ],
      ctx,
    );
    expect(host.hudButtons().map((h) => `${h.featureId}/${h.button.id}`)).toEqual(["a/go"]);
    expect(host.panel("b-panel")?.title).toBe("B");
    expect(host.panel("missing")).toBeUndefined();
  });

  it("ride hooks go to the first feature with a ride; a throwing hook reports false", () => {
    const calls: string[] = [];
    const host = new ClientFeatureHost(
      [
        { id: "plain" },
        { id: "a", ride: { start: () => void calls.push("start"), frame: (dt) => void calls.push(`frame ${dt}`), stop: () => { throw new Error("boom"); } } },
        { id: "b", ride: { start: () => void calls.push("b"), frame: () => {}, stop: () => {} } },
      ],
      ctx,
    );
    expect(host.hasRide()).toBe(true);
    expect(host.ride("start")).toBe(true);
    expect(host.ride("frame", 0.5)).toBe(true);
    expect(host.ride("stop")).toBe(false);
    expect(calls).toEqual(["start", "frame 0.5"]);
    expect(new ClientFeatureHost([{ id: "x" }], ctx).ride("start")).toBe(false);
  });

  it("the enabled list has unique ids and includes the moved features", () => {
    const ids = clientFeatures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["inbox", "quick-prompts"]));
    expect(ids).not.toContain("status-bar"); // the Alef shell owns the status bar now
  });
});
