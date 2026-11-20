import { describe, expect, it } from "vitest";
import type { ReactivateResult, WorldAgent } from "../../../shared/types";
import { ALREADY_RUNNING, OUTCOME_MS, openAgentIn, openOutcome, openPending, type OpenDeps } from "./agent-open";
import { panelActionsHtml } from "./panel";

type Toasted = Array<[string, string | undefined]>;

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id,
  islandId: "agent-world",
  cwd: "/Users/me/Code/agent-world",
  title: "fix the room dock",
  status: "dormant",
  startedAt: "2026-09-20T00:00:00Z",
  lastActive: "2026-09-23T00:00:00Z",
  messageCount: 3,
  model: null,
  role: "builder",
  color: "#2563eb",
  targetIslandId: "agent-world",
  tokens: 10,
  awaitingInput: false,
  ...extra,
});

function fakeStatus(): HTMLElement {
  return { textContent: "", classList: { add: () => {}, remove: () => {} } } as unknown as HTMLElement;
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

/** A server whose answers the test releases by hand (a cold Terminal launch can take >5 s). */
function slowDeps(agents: WorldAgent[]): { deps: OpenDeps; toasts: Toasted; calls: string[]; settle: (r: ReactivateResult) => void } {
  const toasts: Toasted = [];
  const calls: string[] = [];
  const waiting: Array<(r: ReactivateResult) => void> = [];
  const req = (kind: string) => (id: string): Promise<ReactivateResult> => {
    calls.push(`${kind}:${id}`);
    return new Promise((res) => waiting.push(res));
  };
  return {
    deps: { agent: (id) => agents.find((a) => a.id === id), reactivate: req("reactivate"), openEditor: req("editor"), toast: (t, k) => void toasts.push([t, k]) },
    toasts,
    calls,
    settle: (r) => waiting.shift()?.(r),
  };
}

describe("openAgentIn", () => {
  it("answers a second click while the first is still running, instead of swallowing it", async () => {
    const { deps, toasts, calls, settle } = slowDeps([agent("a1")]);
    const first = openAgentIn(deps, "reactivate", "a1");
    const second = await openAgentIn(deps, "reactivate", "a1");
    expect(second).toBeNull();
    expect(calls).toEqual(["reactivate:a1"]); // no second POST
    expect(toasts).toEqual([["Still opening Terminal for fix the room dock…", undefined]]);
    settle({ ok: true, agentId: "a1", mode: "tmux", tmuxName: "aw-a1a1a1a1" });
    await first;
    expect(toasts[1]).toEqual(["Resumed fix the room dock in tmux aw-a1a1a1a1: Stop, Talk and the Screen reach it.", undefined]);
  });

  it("says VS Code, not Terminal, for a duplicate Open in VS Code", async () => {
    const { deps, toasts, settle } = slowDeps([agent("a2")]);
    const first = openAgentIn(deps, "editor", "a2");
    await openAgentIn(deps, "editor", "a2");
    expect(toasts).toEqual([["Still opening VS Code for fix the room dock…", undefined]]);
    settle({ ok: true, agentId: "a2" });
    await first;
  });

  it("exposes the pending text while a request runs, so a re-rendered panel can draw it", async () => {
    const { deps, settle } = slowDeps([agent("a3")]);
    expect(openPending("reactivate", "a3")).toBeNull();
    const running = openAgentIn(deps, "reactivate", "a3");
    expect(openPending("reactivate", "a3")).toBe("Opening Terminal…");
    expect(openPending("editor", "a3")).toBeNull();
    settle({ ok: false, agentId: "a3", error: "boom" });
    await running;
    expect(openPending("reactivate", "a3")).toBeNull();
  });

  it("clears the pending entry even when the request rejects", async () => {
    const deps: OpenDeps = { agent: () => agent("a4"), reactivate: () => Promise.reject(new Error("network down")), openEditor: () => Promise.reject(new Error("x")), toast: () => {} };
    const r = await openAgentIn(deps, "reactivate", "a4");
    expect(r).toEqual({ ok: false, error: "network down" });
    expect(openPending("reactivate", "a4")).toBeNull();
  });

  it("refuses a live agent without a request", async () => {
    const { deps, toasts, calls } = slowDeps([agent("a5", { status: "live" })]);
    const status = fakeStatus();
    expect(await openAgentIn(deps, "reactivate", "a5", { status: () => status })).toBeNull();
    expect(calls).toEqual([]);
    expect(toasts).toEqual([[ALREADY_RUNNING, undefined]]);
    expect(status.textContent).toBe("Already running.");
  });

  it("toasts a failed Open in VS Code with the translated reason", async () => {
    const toasts: Toasted = [];
    const deps: OpenDeps = {
      agent: () => agent("a6"),
      reactivate: () => Promise.resolve({ ok: true, agentId: "a6" }),
      openEditor: () => Promise.resolve({ ok: false, agentId: "a6", error: "Error: spawn code ENOENT" }),
      toast: (t, k) => void toasts.push([t, k]),
    };
    await openAgentIn(deps, "editor", "a6");
    expect(toasts).toEqual([["Open in VS Code failed: VS Code's code command isn't on the PATH.", "error"]]);
  });

  it("keeps the details panel honest across a live re-render: busy button, pending line, outcome where you can see it", async () => {
    // The measured failure: the panel re-rendered ~3 s after the click, replacing a busy button and
    // "Opening Terminal…" with a fresh enabled button and an empty line; a second click then did
    // nothing at all, and the outcome went into the detached line.
    const { deps, toasts, calls, settle } = slowDeps([agent("a7")]);
    let onScreen = { status: fakeStatus(), button: fakeButton() };
    const ui = { status: () => onScreen.status, button: () => onScreen.button };
    const running = openAgentIn(deps, "reactivate", "a7", ui);

    // the live update re-renders the panel from openPending
    const html = panelActionsHtml(false, { reactivate: openPending("reactivate", "a7"), editor: openPending("editor", "a7") });
    expect(html).toMatch(/<button id="reactivate-btn" class="comic-btn" disabled aria-busy="true">/);
    expect(html).toContain('<div id="reactivate-status" role="status">Opening Terminal…</div>');
    const redrawn = { status: fakeStatus(), button: fakeButton() };
    redrawn.button.disabled = true;
    redrawn.button.setAttribute("aria-busy", "true");
    redrawn.status.textContent = "Opening Terminal…";
    onScreen = redrawn;

    await openAgentIn(deps, "reactivate", "a7", ui); // a second click is answered
    expect(toasts).toEqual([["Still opening Terminal for fix the room dock…", undefined]]);
    expect(calls).toHaveLength(1);

    settle({ ok: false, agentId: "a7", error: "No answer from Terminal" });
    await running;
    expect(redrawn.status.textContent).toBe("Reactivate failed: No answer from Terminal");
    expect(redrawn.button.disabled).toBe(false);
    expect(redrawn.button.attrs.has("aria-busy")).toBe(false);

    // measured: the next live update came <1 s after the settle; the outcome line must survive it
    const after = panelActionsHtml(false, { reactivate: openPending("reactivate", "a7"), editor: openPending("editor", "a7") }, openOutcome("a7"));
    expect(after).toContain('<div id="reactivate-status" role="status" class="error">Reactivate failed: No answer from Terminal</div>');
    expect(after).toContain('<button id="reactivate-btn" class="comic-btn" >Reactivate</button>');
  });

  it("keeps the last outcome for OUTCOME_MS, then lets it go", async () => {
    const { deps, settle } = slowDeps([agent("a8")]);
    const running = openAgentIn(deps, "editor", "a8");
    expect(openOutcome("a8")).toBeNull();
    settle({ ok: true, agentId: "a8" });
    await running;
    expect(openOutcome("a8")).toEqual({ text: "Opened agent-world in VS Code.", error: false });
    expect(openOutcome("a8", Date.now() + OUTCOME_MS + 1)).toBeNull();
  });
});

describe("panelActionsHtml", () => {
  it("draws nothing pending as plain enabled buttons and an empty line", () => {
    const html = panelActionsHtml(false, { reactivate: null, editor: null });
    expect(html).toContain('<button id="reactivate-btn" class="comic-btn" >Reactivate</button>');
    expect(html).toContain('<button id="editor-btn" class="comic-btn secondary" type="button" >Open in VS Code</button>');
    expect(html).toContain('<div id="reactivate-status" role="status"></div>');
  });

  it("draws a pending Open in VS Code busy with its line", () => {
    const html = panelActionsHtml(false, { reactivate: null, editor: "Opening VS Code…" });
    expect(html).toContain('<button id="editor-btn" class="comic-btn secondary" type="button" disabled aria-busy="true">');
    expect(html).toContain(">Opening VS Code…</div>");
  });

  it("keeps a live agent's Reactivate disabled as already live, not busy", () => {
    const html = panelActionsHtml(true, { reactivate: "Opening Terminal…", editor: null });
    expect(html).toContain('<button id="reactivate-btn" class="comic-btn" disabled title="already live">');
  });

  it("draws a finished request's outcome line, red when it failed, unless a new request is running", () => {
    expect(panelActionsHtml(false, { reactivate: null, editor: null }, { text: "Opened x in VS Code.", error: false })).toContain(
      '<div id="reactivate-status" role="status">Opened x in VS Code.</div>',
    );
    expect(panelActionsHtml(false, { reactivate: null, editor: null }, { text: "Reactivate failed: boom", error: true })).toContain(
      '<div id="reactivate-status" role="status" class="error">Reactivate failed: boom</div>',
    );
    expect(panelActionsHtml(false, { reactivate: "Opening Terminal…", editor: null }, { text: "Reactivate failed: boom", error: true })).toContain(
      '<div id="reactivate-status" role="status">Opening Terminal…</div>',
    );
  });

  it("escapes the pending text", () => {
    expect(panelActionsHtml(false, { reactivate: "<b>x</b>", editor: null })).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
