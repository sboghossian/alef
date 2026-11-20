import { describe, expect, it } from "vitest";
import type { ControlResult } from "../../../shared/features/control";
import type { TalkActionResult } from "../../../shared/features/talk";
import type { ReactivateResult, WorldAgent } from "../../../shared/types";
import { RUNNING_ELSEWHERE_TEXT, TRUST_HINT, resumeOffer, resumeStartedText } from "../features/resume-guard";
import { roomActivate, roomInterrupt, roomOpenEditor, type RoomActionDeps } from "./room-actions";

type Toasted = Array<[string, string | undefined]>;

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id,
  islandId: "acme-www",
  cwd: "/Users/me/Code/acme-www",
  title: "rewrite the DPA page",
  status: "dormant",
  startedAt: "2026-09-20T00:00:00Z",
  lastActive: "2026-09-23T00:00:00Z",
  messageCount: 3,
  model: null,
  role: "builder",
  color: "#2563eb",
  targetIslandId: "acme-www",
  tokens: 10,
  awaitingInput: false,
  ...extra,
});

function fakeStatus(): HTMLElement & { classes: Set<string> } {
  const classes = new Set<string>();
  return {
    textContent: "",
    classes,
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
  } as unknown as HTMLElement & { classes: Set<string> };
}

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

interface Server {
  openEditor?: ReactivateResult;
  reactivate?: ReactivateResult;
  resume?: TalkActionResult;
  interrupt?: ControlResult;
}

/** `bound`: agent ids in a world tmux session; `tmux`: whether tmux is installed (resume guard input). */
function deps(
  server: Server,
  agents: WorldAgent[] = [agent("r1")],
  world: { bound?: string[]; tmux?: boolean } = {},
): { d: RoomActionDeps; toasts: Toasted; calls: string[] } {
  const toasts: Toasted = [];
  const calls: string[] = [];
  const answer = <T,>(name: string, r: T | undefined): Promise<T> => {
    calls.push(name);
    return r ? Promise.resolve(r) : Promise.reject(new Error(`unexpected ${name}`));
  };
  return {
    d: {
      agent: (id) => agents.find((a) => a.id === id),
      openEditor: (id) => answer(`editor:${id}`, server.openEditor),
      reactivate: (id) => answer(`reactivate:${id}`, server.reactivate),
      resume: (id) => answer(`resume:${id}`, server.resume),
      interrupt: (id, hard) => answer(`interrupt:${id}:${hard ? "hard" : "soft"}`, server.interrupt),
      resumeOffer: (id) =>
        resumeOffer({
          status: agents.find((a) => a.id === id)?.status === "live" ? "live" : "dormant",
          bound: world.bound?.includes(id) ?? false,
          tmuxAvailable: world.tmux ?? true,
        }),
      toast: (t, k) => void toasts.push([t, k]),
    },
    toasts,
    calls,
  };
}

describe("the Room dock's Open in VS Code", () => {
  it("toasts the failure with the translated reason, not only a line of sidebar text", async () => {
    // Measured before this fix: with `code` not on the PATH, the dock showed only
    // "Failed: Error: spawn code ENOENT" in small sidebar text, and no toast.
    const { d, toasts, calls } = deps({ openEditor: { ok: false, agentId: "r1", error: "Error: spawn code ENOENT" } });
    const status = fakeStatus();
    const button = fakeButton();
    await roomOpenEditor(d, "r1", { status: () => status, button });
    expect(calls).toEqual(["editor:r1"]);
    expect(toasts).toEqual([["Open in VS Code failed: VS Code's code command isn't on the PATH.", "error"]]);
    expect(status.textContent).toBe("Open in VS Code failed: VS Code's code command isn't on the PATH.");
    expect(status.classes.has("error")).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it("keeps the button busy while the request runs, and toasts the folder it opened", async () => {
    const { d, toasts } = deps({ openEditor: { ok: true, agentId: "r1" } });
    const button = fakeButton();
    const running = roomOpenEditor(d, "r1", { button });
    expect(button.disabled).toBe(true);
    expect(button.attrs.get("aria-busy")).toBe("true");
    await running;
    expect(button.disabled).toBe(false);
    expect(toasts).toEqual([["Opened acme-www in VS Code.", undefined]]);
  });
});

describe("the Room dock's Activate", () => {
  it("resumes in a world tmux session and toasts where, from the server's answer", async () => {
    const { d, toasts, calls } = deps({ resume: { ok: true, mode: "tmux", tmuxName: "aw-1234" } });
    const status = fakeStatus();
    await roomActivate(d, "r1", true, { status: () => status, button: fakeButton() });
    expect(calls).toEqual(["resume:r1"]);
    const said = "Resumed in tmux aw-1234: Stop, Talk and the Screen reach it. Click the screen for its live terminal.";
    expect(toasts).toEqual([[said, undefined]]);
    expect(status.textContent).toBe(said);
  });

  it("a resume waiting on claude's trust dialog says to answer it in Terminal, and the toast stays up", async () => {
    const { d, toasts } = deps({ resume: { ok: true, mode: "tmux", tmuxName: "aw-1234", waitingOn: "trust", cwd: "/Users/s/Code/acme-www" } });
    await roomActivate(d, "r1", true, {});
    expect(toasts[0]?.[0]).toContain("waiting on its trust dialog for acme-www: answer it in Terminal");
    expect(toasts[0]?.[1]).toBe("error");
  });

  // Probe 2026-09-28: POST /api/talk/reactivate/<live id> answered 200 and started a second copy.
  it("never resumes an agent running in another terminal: no request, and it says why (checked at click time)", async () => {
    const { d, toasts, calls } = deps({ resume: { ok: true, tmuxName: "aw-2" } }, [agent("r1", { status: "live" })]);
    const status = fakeStatus();
    const button = fakeButton();
    expect(await roomActivate(d, "r1", true, { status: () => status, button })).toBeNull();
    expect(calls).toEqual([]);
    expect(toasts).toEqual([[RUNNING_ELSEWHERE_TEXT, "error"]]);
    expect(status.textContent).toBe(RUNNING_ELSEWHERE_TEXT);
    expect(button.disabled).toBe(false);
  });

  it("a live agent already in a world tmux session is not 'running elsewhere'", async () => {
    const { d, calls } = deps({ resume: { ok: true, tmuxName: "aw-3" } }, [agent("r1", { status: "live" })], { bound: ["r1"] });
    await roomActivate(d, "r1", true, {});
    expect(calls).toEqual(["resume:r1"]);
  });

  it("toasts a refused resume as an error", async () => {
    const { d, toasts } = deps({ resume: { ok: false, error: "tmux: server exited unexpectedly" } });
    await roomActivate(d, "r1", true, {});
    expect(toasts).toEqual([["Activate failed: tmux: server exited unexpectedly", "error"]]);
  });

  it("without tmux, opens a Terminal like the panel's Reactivate (its wording plus the trust hint; never for a live agent)", async () => {
    const note = "tmux isn't installed, so it opened in a plain Terminal window: Stop, Talk, Note and the Screen can't reach it.";
    const { d, toasts, calls } = deps({ reactivate: { ok: true, agentId: "r1", mode: "terminal", warning: note } }, [agent("r1")], { tmux: false });
    await roomActivate(d, "r1", false, {});
    expect(calls).toEqual(["reactivate:r1"]);
    expect(toasts).toEqual([[`Resumed rewrite the DPA page in a plain Terminal window. Tmux isn't installed, so it opened in a plain Terminal window: Stop, Talk, Note and the Screen can't reach it. ${TRUST_HINT}`, undefined]]);

    const live = deps({ reactivate: { ok: true, agentId: "r2" } }, [agent("r2", { status: "live" })], { tmux: false });
    expect(await roomActivate(live.d, "r2", false, {})).toBeNull();
    expect(live.calls).toEqual([]);
    expect(live.toasts).toEqual([[RUNNING_ELSEWHERE_TEXT, "error"]]);
  });

  it("uses Resume here's own wording when given one", async () => {
    const { d, toasts } = deps({ resume: { ok: true, mode: "tmux", tmuxName: "aw-9" } });
    await roomActivate(d, "r1", true, {}, (r) => `${resumeStartedText(r)} Opening its terminal here…`);
    expect(toasts).toEqual([["Resumed (claude --resume) in tmux aw-9: Stop, Talk and the Screen reach it. Opening its terminal here…", undefined]]);
  });
});

describe("the Room dock's Stop and Ctrl-C", () => {
  it("sends Esc, busy while it runs, and toasts what was sent", async () => {
    const { d, toasts, calls } = deps({ interrupt: { ok: true, tmuxName: "aw-1", sent: "Escape" } });
    const button = fakeButton();
    const running = roomInterrupt(d, "r1", false, { button });
    expect(button.disabled).toBe(true);
    await running;
    expect(calls).toEqual(["interrupt:r1:soft"]);
    expect(button.disabled).toBe(false);
    expect(toasts).toEqual([["Sent Escape to aw-1.", undefined]]);
  });

  it("sends Ctrl-C for the hard one and toasts a refusal as an error with its reason", async () => {
    const { d, toasts, calls } = deps({ interrupt: { ok: false, error: "open its Terminal to stop it" } });
    const status = fakeStatus();
    await roomInterrupt(d, "r1", true, { status: () => status });
    expect(calls).toEqual(["interrupt:r1:hard"]);
    expect(toasts).toEqual([["Not stopped: open its Terminal to stop it", "error"]]);
    expect(status.textContent).toBe("Not stopped: open its Terminal to stop it");
  });

  it("never throws when the request does", async () => {
    const { d, toasts } = deps({});
    const r = await roomInterrupt(d, "r1", false, {});
    expect(r.ok).toBe(false);
    expect(toasts).toEqual([["Not stopped: unexpected interrupt:r1:soft", "error"]]);
  });
});
