import { describe, expect, it } from "vitest";
import { PLAIN_TERMINAL_NOTE } from "../../../shared/features/talk";
import { launchInFlight, launchNeedsYou, launchSuccessText, runLaunchOnce, trustRelaunchAction } from "./launch-result";

const tmux = { ok: true, mode: "tmux" as const, tmuxName: "aw-5c67d47b", cwd: "/Users/s/Documents/Code/acme-www" };

describe("launchSuccessText", () => {
  it("a world tmux launch says Stop, Talk and the Screen reach it", () => {
    expect(launchSuccessText(tmux, "Dispatched to acme-www")).toBe("Dispatched to acme-www in tmux aw-5c67d47b: Stop, Talk and the Screen reach it.");
  });

  it("a plain-Terminal fallback says so, with the server's note", () => {
    expect(launchSuccessText({ ok: true, mode: "terminal", warning: PLAIN_TERMINAL_NOTE }, "Dispatched to acme-www")).toBe(
      "Dispatched to acme-www in a plain Terminal window. Tmux isn't installed, so it opened in a plain Terminal window: Stop, Talk, Note and the Screen can't reach it.",
    );
  });

  it("claude waiting on its trust dialog: names the folder and the way out", () => {
    expect(launchSuccessText({ ...tmux, waitingOn: "trust" }, "Started")).toContain("Claude is waiting on its trust dialog for acme-www: nothing runs until you trust the folder (button here or in the Inbox) or answer it in Terminal.");
    expect(launchSuccessText({ ...tmux, waitingOn: "chrome" }, "Started")).toContain("waiting on its Chrome dialog: answer it in Terminal");
  });

  it("a Terminal that didn't open: the session runs, the warning is said", () => {
    expect(launchSuccessText({ ...tmux, warning: "couldn't open Terminal (-1743); it's running in tmux aw-5c67d47b: use Attach or the Screen" }, "Started")).toBe(
      "Started in tmux aw-5c67d47b: Stop, Talk and the Screen reach it. Couldn't open Terminal (-1743); it's running in tmux aw-5c67d47b: use Attach or the Screen.",
    );
  });

  it("a repeat or an attach never claims a new launch; an answer without a mode claims nothing", () => {
    expect(launchSuccessText({ ...tmux, reused: true }, "Started")).toBe("Already started as aw-5c67d47b, so nothing new was launched.");
    expect(launchSuccessText({ ...tmux, attached: true }, "Resumed")).toBe("Already in tmux aw-5c67d47b: Terminal attached, nothing new started.");
    expect(launchSuccessText({ ok: true }, "Resumed x")).toBe("Resumed x.");
  });
});

describe("launchNeedsYou / trustRelaunchAction", () => {
  const api = { postJson: async <T,>(_u: string, _b: unknown, fallback: (e: string) => T): Promise<T> => fallback("unused") };
  it("stays up (error toast) only when something still needs the person", () => {
    expect(launchNeedsYou(tmux)).toBe(false);
    expect(launchNeedsYou({ ...tmux, waitingOn: "trust" })).toBe(true);
    expect(launchNeedsYou({ ...tmux, warning: "couldn't open Terminal" })).toBe(true);
    expect(launchNeedsYou({ ok: true, mode: "terminal", warning: PLAIN_TERMINAL_NOTE })).toBe(false);
  });

  it("offers Trust <folder> & relaunch only on a launch waiting on the trust dialog", () => {
    expect(trustRelaunchAction(api, () => {}, { ...tmux, waitingOn: "trust" })?.label).toBe("Trust acme-www & relaunch");
    expect(trustRelaunchAction(api, () => {}, tmux)).toBeUndefined();
    expect(trustRelaunchAction(api, () => {}, { ...tmux, waitingOn: "chrome" })).toBeUndefined();
    expect(trustRelaunchAction(api, () => {}, { ...tmux, ok: false, waitingOn: "trust" })).toBeUndefined();
  });

  it("the action posts to the stranded row's trust-relaunch route", async () => {
    const urls: string[] = [];
    const toasts: string[] = [];
    const spy = {
      postJson: async <T,>(url: string): Promise<T> => {
        urls.push(url);
        return { ok: true, mode: "tmux", tmuxName: "aw-11111111", relaunchedFrom: "aw-5c67d47b", trusted: true, cwd: tmux.cwd } as T;
      },
    };
    trustRelaunchAction(spy, (t) => void toasts.push(t), { ...tmux, waitingOn: "trust" })?.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(urls).toEqual(["/api/talk/stranded/aw-5c67d47b/trust-relaunch"]);
    expect(toasts[0]).toBe("Trusted acme-www and closed aw-5c67d47b. Relaunched its prompt in tmux aw-11111111: Stop, Talk and the Screen reach it.");
  });
});

describe("runLaunchOnce", () => {
  it("one launch per key at a time: a second click while it runs sends nothing and says so", async () => {
    let release: (r: { ok: boolean }) => void = () => {};
    const toasts: string[] = [];
    let sent = 0;
    const opts = {
      label: "Launch",
      run: () => {
        sent++;
        return new Promise<{ ok: boolean }>((r) => (release = r));
      },
      success: () => "Started.",
      toast: (t: string) => void toasts.push(t),
    };
    const first = runLaunchOnce("loops:a", opts);
    expect(launchInFlight("loops:a")).toBe(true);
    expect(await runLaunchOnce("loops:a", opts)).toBeNull();
    expect(sent).toBe(1);
    expect(toasts).toEqual(["Still starting that one…"]);
    release({ ok: true });
    await first;
    expect(launchInFlight("loops:a")).toBe(false);
  });
});
