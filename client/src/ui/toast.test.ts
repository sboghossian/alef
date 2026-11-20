// Toasts can't be missed: capped text, a real stack, a z-index above every other layer, and an error
// that stays up long enough to act on. Client tests run in Node, so mountToast gets a small stub
// document/window with fake timers (a toast's lifetime is checked the way a person sees it: is it
// still in the stack?), and the stacking order is checked on the CSS text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchToast } from "../features/loops-lib";
import { TOAST_MAX, TOAST_TEXT_MAX, mountToast, toastText } from "./toast";
import { ERROR_TOAST_MIN_MS, INFO_TOAST_MS, toastLifetimeMs } from "./toast-lib";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return name.endsWith(".css") ? [p] : [];
  });
}

/** Just enough of an element for mountToast: a child list, classes, dataset and listeners. */
class FakeEl {
  id = "";
  type = "";
  hidden = false;
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  parent: FakeEl | null = null;
  kids: FakeEl[] = [];
  private listeners = new Map<string, Array<() => void>>();
  setAttribute(): void {}
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  get children(): FakeEl[] {
    return this.kids;
  }
  get firstElementChild(): FakeEl | null {
    return this.kids[0] ?? null;
  }
  get lastElementChild(): FakeEl | null {
    return this.kids[this.kids.length - 1] ?? null;
  }
  append(...els: FakeEl[]): void {
    for (const el of els) {
      el.parent = this;
      this.kids.push(el);
    }
  }
  prepend(el: FakeEl): void {
    el.parent = this;
    this.kids.unshift(el);
  }
  remove(): void {
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  /** Direct children only, by class (".toast-item", ".toast-item.info"): all the toast asks for. */
  querySelectorAll(selector: string): FakeEl[] {
    const want = selector.split(".").filter(Boolean);
    return this.kids.filter((k) => want.every((c) => k.className.split(" ").includes(c)));
  }
  matches(): boolean {
    return false;
  }
  contains(): boolean {
    return false;
  }
}

/** Mounts the toast on a stub DOM; `items` reads the stack as a person sees it, newest first. */
function mount(): { toast: ReturnType<typeof mountToast>; box: () => FakeEl; items: () => Array<{ kind: string; text: string }> } {
  const made: FakeEl[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const el = new FakeEl();
      made.push(el);
      return el;
    },
    body: { appendChild: (): void => {} },
    activeElement: null,
  });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => clearTimeout(id),
  });
  const toast = mountToast();
  const box = (): FakeEl => {
    const b = made[0];
    if (!b) throw new Error("mountToast made no container");
    return b;
  };
  const items = (): Array<{ kind: string; text: string }> =>
    box().hidden ? [] : box().kids.map((el) => ({ kind: el.dataset.kind ?? "", text: el.kids[0]?.textContent ?? "" }));
  return { toast, box, items };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("toast action button", () => {
  it("a toast with an action shows its button; clicking it runs the action once and puts the toast away", () => {
    const { toast, box, items } = mount();
    let ran = 0;
    toast("Claude is waiting on its trust dialog for acme-www.", "error", { label: "Trust acme-www & relaunch", run: () => void ran++ });
    const item = box().kids[0]!;
    const act = item.kids.find((k) => k.className === "toast-act");
    expect(act?.textContent).toBe("Trust acme-www & relaunch");
    act?.fire("click");
    expect(ran).toBe(1);
    expect(items()).toEqual([]);
  });

  it("a toast without one has no action button", () => {
    const { toast, box } = mount();
    toast("Opened acme-www in VS Code.");
    expect(box().kids[0]!.kids.some((k) => k.className === "toast-act")).toBe(false);
  });
});

describe("toast", () => {
  it("caps the text at 400 chars (the Health test toast once dumped ~360 KB)", () => {
    const huge = toastText("x".repeat(360_000));
    expect(huge.length).toBe(TOAST_TEXT_MAX);
    expect(huge.endsWith("…")).toBe(true);
    expect(toastText("  short  ")).toBe("short");
  });

  it("stacks three, keeps errors longer than info", () => {
    expect(TOAST_MAX).toBe(3);
    expect(INFO_TOAST_MS).toBe(4000);
    expect(ERROR_TOAST_MIN_MS).toBeGreaterThan(INFO_TOAST_MS);
  });

  it("sits above every other layer in the client's CSS (Room, grid, Health, #panel, modals)", () => {
    const style = readFileSync(join(srcDir, "style.css"), "utf8");
    const block = /#toast\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    const toastZ = Number(/z-index:\s*(\d+)/.exec(block)?.[1]);
    expect(toastZ).toBeGreaterThan(0);
    const others: Array<[string, number]> = [];
    for (const file of cssFiles(srcDir)) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = (m[1] ?? "").trim();
        if (selector.startsWith("#toast")) continue;
        const z = /z-index:\s*(\d+)/.exec(m[2] ?? "")?.[1];
        if (z) others.push([`${file.slice(srcDir.length)} ${selector}`, Number(z)]);
      }
    }
    expect(others.length).toBeGreaterThan(10);
    expect(others.filter(([, z]) => z >= toastZ)).toEqual([]);
  });
});

describe("mountToast lifetime", () => {
  it("an info toast is gone after 4 s", () => {
    const { toast, box, items } = mount();
    toast("Started aw-x in Terminal (plan mode).");
    vi.advanceTimersByTime(INFO_TOAST_MS - 1);
    expect(items()).toEqual([{ kind: "info", text: "Started aw-x in Terminal (plan mode)." }]);
    vi.advanceTimersByTime(1);
    expect(items()).toEqual([]);
    expect(box().hidden).toBe(true);
  });

  // 2026-09-28 review: this exact message was visible at 300 ms and hidden at 3.8 s.
  it("the untrusted launch toast is still up at 3.8 s and 9 s, and goes when its error lifetime ends", () => {
    const { toast, items } = mount();
    const t = launchToast({ ok: true, mode: "tmux", tmuxName: "aw-1375f4fa", trust: "untrusted", cwd: "/Users/s/Documents/Code/acme-www" });
    const lifetime = toastLifetimeMs(t.text, "error");
    expect(lifetime).toBeGreaterThanOrEqual(10_000);
    toast(t.text, t.kind);
    vi.advanceTimersByTime(3800);
    expect(items()).toEqual([{ kind: "error", text: t.text }]);
    vi.advanceTimersByTime(9000 - 3800);
    expect(items()).toHaveLength(1);
    vi.advanceTimersByTime(lifetime - 9000);
    expect(items()).toEqual([]);
  });

  it("the refused-osascript failure toast stays up past 10 s", () => {
    const { toast, items } = mount();
    const t = launchToast({
      ok: false,
      error:
        "Error: Command failed: osascript -e tell application \"Terminal\" to do script \"'/opt/homebrew/bin/tmux' attach -t 'aw-a7cd977f'\"\n0:43: execution error: Not authorized to send Apple events to Terminal. (-1743)\n",
    });
    toast(t.text, t.kind);
    vi.advanceTimersByTime(10_000);
    expect(items()).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(items()).toEqual([]);
  });

  it("a click hides an error toast early", () => {
    const { toast, box, items } = mount();
    toast("Couldn't launch: tmux is not installed", "error");
    vi.advanceTimersByTime(1000);
    box().kids[0]?.fire("click");
    expect(items()).toEqual([]);
    expect(box().hidden).toBe(true);
  });

  it("an error outlives the info chatter after it: still up, and for its full 10 s", () => {
    const { toast, items } = mount();
    toast("Activate failed: tmux: server exited unexpectedly", "error");
    for (const n of [1, 2, 3]) toast(`Opened acme-www in VS Code (${n}).`);
    vi.advanceTimersByTime(50);
    expect(items().map((x) => x.kind)).toEqual(["info", "info", "error"]);
    vi.advanceTimersByTime(ERROR_TOAST_MIN_MS - 100);
    expect(items()).toEqual([{ kind: "error", text: "Activate failed: tmux: server exited unexpectedly" }]);
    vi.advanceTimersByTime(100);
    expect(items()).toEqual([]);
  });
});

describe("toastLifetimeMs", () => {
  it("info is 4 s however long the text", () => {
    expect(toastLifetimeMs("x".repeat(500), "info")).toBe(INFO_TOAST_MS);
  });

  it("error is at least 10 s, grows with the text, and stops at 30 s", () => {
    expect(toastLifetimeMs("Nothing was restored.", "error")).toBe(10_000);
    expect(toastLifetimeMs("x".repeat(200), "error")).toBe(14_000);
    expect(toastLifetimeMs("x".repeat(5000), "error")).toBe(30_000);
  });
});
