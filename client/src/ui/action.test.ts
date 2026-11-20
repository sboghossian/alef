import { describe, expect, it } from "vitest";
import { describeError, runAction, type ActionResultLike } from "./action";

type Toasted = Array<[string, string | undefined]>;

function fakeButton(): HTMLButtonElement & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  return {
    disabled: false,
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  } as unknown as HTMLButtonElement & { attrs: Map<string, string> };
}

function fakeStatus(): HTMLElement & { classes: Set<string> } {
  const classes = new Set<string>();
  return {
    textContent: "",
    classes,
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
  } as unknown as HTMLElement & { classes: Set<string> };
}

describe("describeError", () => {
  it("translates the cryptic reasons people actually hit", () => {
    expect(describeError("world server unreachable")).toBe("Alef's server didn't answer (it may be restarting). Try again in a few seconds.");
    expect(describeError("timed out")).toBe("No answer in time. It may still be running: check the Logs tab.");
    expect(describeError("Error: Command failed: osascript -e …\n36:120: execution error: Not authorized to send Apple events to Terminal. (-1743)")).toBe(
      "macOS blocked Alef from controlling that app: allow it in System Settings › Privacy & Security › Automation.",
    );
    expect(describeError("execution error: (-1743)")).toMatch(/^macOS blocked Alef/);
    expect(describeError("Error: spawn code ENOENT")).toBe("VS Code's code command isn't on the PATH.");
  });

  it("keeps anything else as its first line, without the Error: prefix", () => {
    expect(describeError("Error: unknown or expired request")).toBe("unknown or expired request");
    expect(describeError("invalid agent id\nstack line 1\nstack line 2")).toBe("invalid agent id");
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("the tmux session timed out while starting")).toBe("the tmux session timed out while starting");
  });

  it("caps long reasons at 240 chars and never returns an empty string", () => {
    const long = describeError(`Error: ${"x".repeat(1000)}`);
    expect(long.length).toBe(240);
    expect(long.endsWith("…")).toBe(true);
    expect(describeError(undefined)).toBe("unknown error");
    expect(describeError(null)).toBe("unknown error");
    expect(describeError("   ")).toBe("unknown error");
  });
});

describe("runAction", () => {
  it("toasts what happened on success and writes it to the status line", async () => {
    const toasts: Toasted = [];
    const status = fakeStatus();
    const r = await runAction({
      label: "Reactivate",
      pending: "Opening Terminal…",
      run: () => Promise.resolve({ ok: true, agentId: "a1" }),
      success: (res) => `Opened Terminal: resuming ${res.agentId}.`,
      toast: (t, k) => void toasts.push([t, k]),
      status,
    });
    expect(r).toEqual({ ok: true, agentId: "a1" });
    expect(toasts).toEqual([["Opened Terminal: resuming a1.", undefined]]);
    expect(status.textContent).toBe("Opened Terminal: resuming a1.");
    expect(status.classes.has("error")).toBe(false);
  });

  it("stays quiet when success returns null", async () => {
    const toasts: Toasted = [];
    await runAction({ label: "Save", run: () => Promise.resolve({ ok: true }), success: () => null, toast: (t, k) => void toasts.push([t, k]) });
    expect(toasts).toEqual([]);
  });

  it("toasts a failure with the server's reason, translated, as an error", async () => {
    const toasts: Toasted = [];
    const status = fakeStatus();
    const r = await runAction<ActionResultLike>({
      label: "Open in VS Code",
      run: () => Promise.resolve({ ok: false, error: "Error: spawn code ENOENT" }),
      success: () => "never",
      toast: (t, k) => void toasts.push([t, k]),
      status,
    });
    expect(r.ok).toBe(false);
    expect(toasts).toEqual([["Open in VS Code failed: VS Code's code command isn't on the PATH.", "error"]]);
    expect(status.textContent).toBe("Open in VS Code failed: VS Code's code command isn't on the PATH.");
    expect(status.classes.has("error")).toBe(true);
  });

  it("uses the caller's failure text when it gives one", async () => {
    const toasts: Toasted = [];
    await runAction<ActionResultLike>({
      label: "Approve",
      run: () => Promise.resolve({ ok: false, error: "unknown or expired request" }),
      success: () => null,
      failure: () => "Too late: that request expired and the terminal prompt took over.",
      toast: (t, k) => void toasts.push([t, k]),
    });
    expect(toasts).toEqual([["Too late: that request expired and the terminal prompt took over.", "error"]]);
  });

  it("never throws: a throwing run becomes { ok: false, error }", async () => {
    const toasts: Toasted = [];
    const r = await runAction<ActionResultLike>({
      label: "Dispatch",
      run: () => Promise.reject(new Error("network down")),
      success: () => "never",
      toast: (t, k) => void toasts.push([t, k]),
    });
    expect(r).toEqual({ ok: false, error: "network down" });
    expect(toasts).toEqual([["Dispatch failed: network down", "error"]]);
  });

  it("never throws even when the toast itself does", async () => {
    const r = await runAction({ label: "X", run: () => Promise.resolve({ ok: true }), success: () => "done", toast: () => { throw new Error("no DOM"); } });
    expect(r.ok).toBe(true);
  });

  it("disables the button (aria-busy) while running and restores it after, so a double click can't fire twice", async () => {
    const button = fakeButton();
    let release: (v: ActionResultLike) => void = () => {};
    let runs = 0;
    const click = (): Promise<ActionResultLike> | null =>
      button.disabled
        ? null
        : runAction<ActionResultLike>({
            label: "Reactivate",
            run: () => {
              runs++;
              return new Promise((res) => (release = res));
            },
            success: () => null,
            toast: () => {},
            button,
          });
    const first = click();
    expect(button.disabled).toBe(true);
    expect(button.attrs.get("aria-busy")).toBe("true");
    expect(click()).toBeNull(); // the second click finds the button disabled
    release({ ok: true });
    await first;
    expect(runs).toBe(1);
    expect(button.disabled).toBe(false);
    expect(button.attrs.has("aria-busy")).toBe(false);
  });

  it("leaves a button that was already disabled disabled", async () => {
    const button = fakeButton();
    button.disabled = true;
    await runAction({ label: "X", run: () => Promise.resolve({ ok: false, error: "no" }), success: () => null, toast: () => {}, button });
    expect(button.disabled).toBe(true);
  });

  it("shows the pending text while running", async () => {
    const status = fakeStatus();
    let seen = "";
    await runAction({
      label: "Reactivate",
      pending: "Opening Terminal…",
      run: () => {
        seen = status.textContent ?? "";
        return Promise.resolve({ ok: true });
      },
      success: () => null,
      toast: () => {},
      status,
    });
    expect(seen).toBe("Opening Terminal…");
    expect(status.textContent).toBe("");
  });

  it("writes the outcome into the nodes on screen when it settles, not into ones a re-render detached", async () => {
    // The details panel re-renders on every live update: at settle, the getters return new nodes.
    const toasts: Toasted = [];
    const [oldStatus, newStatus] = [fakeStatus(), fakeStatus()];
    const [oldButton, newButton] = [fakeButton(), fakeButton()];
    let onScreen = { status: oldStatus, button: oldButton };
    let release: (v: ActionResultLike) => void = () => {};
    const running = runAction<ActionResultLike>({
      label: "Reactivate",
      pending: "Opening Terminal…",
      run: () => new Promise((res) => (release = res)),
      success: () => "never",
      toast: (t, k) => void toasts.push([t, k]),
      status: () => onScreen.status,
      button: () => onScreen.button,
    });
    expect(oldButton.disabled).toBe(true);
    expect(oldStatus.textContent).toBe("Opening Terminal…");
    // the re-render draws the new button busy (ui/panel.ts panelActionsHtml, from openPending)
    newButton.disabled = true;
    newButton.setAttribute("aria-busy", "true");
    onScreen = { status: newStatus, button: newButton };
    release({ ok: false, error: "Error: Command failed: osascript\nexecution error: (-1743)" });
    await running;
    expect(newStatus.textContent).toMatch(/^Reactivate failed: macOS blocked Alef/);
    expect(newStatus.classes.has("error")).toBe(true);
    expect(newButton.disabled).toBe(false);
    expect(newButton.attrs.has("aria-busy")).toBe(false);
    expect(toasts).toHaveLength(1);
  });

  it("leaves a re-rendered button that isn't busy as its renderer drew it (e.g. disabled: already live)", async () => {
    const first = fakeButton();
    const redrawn = fakeButton();
    redrawn.disabled = true;
    let onScreen = first;
    let release: (v: ActionResultLike) => void = () => {};
    const running = runAction<ActionResultLike>({ label: "X", run: () => new Promise((res) => (release = res)), success: () => null, toast: () => {}, button: () => onScreen });
    onScreen = redrawn;
    release({ ok: true });
    await running;
    expect(redrawn.disabled).toBe(true);
  });

  it("tells onOutcome the line it wrote, flagged when it failed", async () => {
    const seen: Array<[string, boolean]> = [];
    const onOutcome = (t: string, e: boolean): void => void seen.push([t, e]);
    await runAction({ label: "X", run: () => Promise.resolve({ ok: true }), success: () => "done", toast: () => {}, onOutcome });
    await runAction({ label: "X", run: () => Promise.resolve({ ok: false, error: "no" }), success: () => null, toast: () => {}, onOutcome });
    await runAction({ label: "X", run: () => Promise.resolve({ ok: true }), success: () => null, toast: () => {}, onOutcome });
    expect(seen).toEqual([
      ["done", false],
      ["X failed: no", true],
    ]);
  });

  it("writes nothing when the getter finds no node (the panel now shows another agent)", async () => {
    const status = fakeStatus();
    let shown: typeof status | null = status;
    let release: (v: ActionResultLike) => void = () => {};
    const toasts: Toasted = [];
    const running = runAction<ActionResultLike>({
      label: "X",
      run: () => new Promise((res) => (release = res)),
      success: () => "done",
      toast: (t, k) => void toasts.push([t, k]),
      status: () => shown,
    });
    shown = null;
    status.textContent = "another agent's line";
    release({ ok: true });
    await running;
    expect(status.textContent).toBe("another agent's line");
    expect(toasts).toEqual([["done", undefined]]);
  });
});

describe("runAction success kind and action", () => {
  it("an 'error' success kind keeps the toast up; an action rides on the success toast; plain successes keep one argument", async () => {
    const calls: unknown[][] = [];
    const toast = (...args: unknown[]): void => void calls.push(args);
    const act = { label: "Trust acme-www & relaunch", run: () => {} };
    await runAction({ label: "Launch", run: async () => ({ ok: true }), success: () => "Waiting on the trust dialog.", successKind: () => "error", action: () => act, toast });
    await runAction({ label: "Launch", run: async () => ({ ok: true }), success: () => "Still needs you.", successKind: () => "error", toast });
    await runAction({ label: "Launch", run: async () => ({ ok: true }), success: () => "Started.", successKind: () => "info", action: () => undefined, toast });
    expect(calls).toEqual([["Waiting on the trust dialog.", "error", act], ["Still needs you.", "error"], ["Started."]]);
  });
});
