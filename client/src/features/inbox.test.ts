import { describe, expect, it } from "vitest";
import type { StrandedDispatch, TalkActionResult } from "../../../shared/features/talk";
import type { ClientApi } from "./registry";
import type { HealthKeeperInboxItem, HealthKeeperState } from "../../../shared/features/health-keeper";
import { openHealthInboxItem } from "./health-keeper";
import { makeStrandedActions, renderEmptyState, renderHealthSection, renderStrandedSection, STRANDED_CLOSE_CONFIRM, strandedSuccessText } from "./inbox";

const stranded = (over: Partial<StrandedDispatch> = {}): StrandedDispatch => ({
  tmuxName: "aw-68597ce4",
  cwd: "/Users/alexboghossian/Documents/Code/acme-www",
  startedAt: "2026-09-26T08:33:12.168Z",
  blockedOn: "empty-prompt",
  closable: true,
  promptHead: "Open PR aligning acme.ai FAQ 'end-to-end encryption'",
  lastLine: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
  ...over,
});

describe("renderStrandedSection", () => {
  it("is empty for an empty list — no section, no empty-state clutter", () => {
    expect(renderStrandedSection([])).toBe("");
  });

  it("shows the section header with the count and the cwd's basename", () => {
    const html = renderStrandedSection([stranded()]);
    expect(html).toContain("Started from Alef but never began");
    expect(html).toContain(">1<");
    expect(html).toContain("acme-www");
  });

  it("labels every blockedOn value in plain language", () => {
    const cases: Array<[StrandedDispatch["blockedOn"], string]> = [
      ["trust", "waiting for folder trust"],
      ["chrome", "blocked on the Chrome prompt"],
      ["menu", "waiting on a prompt"],
      ["empty-prompt", "sitting at an empty prompt"],
      ["exited", "exited before it started"],
      ["unknown", "in an unknown state"],
    ];
    for (const [blockedOn, label] of cases) {
      expect(renderStrandedSection([stranded({ blockedOn })])).toContain(label);
    }
  });

  it("renders a hostile promptHead as inert text, never as markup", () => {
    const html = renderStrandedSection([stranded({ promptHead: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("omits the prompt line entirely when promptHead is null", () => {
    const html = renderStrandedSection([stranded({ promptHead: null })]);
    expect(html).not.toContain("i-stranded-prompt");
  });

  it("carries the tmux name on both the Attach and Close buttons, escaped", () => {
    const html = renderStrandedSection([stranded({ tmuxName: "aw-e3199626", blockedOn: "chrome" })]);
    expect(html).toContain('data-attach="aw-e3199626"');
    expect(html).toContain('data-close="aw-e3199626"');
  });

  it("renders the two real live stranded sessions (captured 2026-09-27, verified against production code)", () => {
    const real: StrandedDispatch[] = [
      {
        tmuxName: "aw-68597ce4",
        cwd: "/Users/alexboghossian/Documents/Code/acme-www",
        startedAt: "2026-09-26T08:33:12.168Z",
        blockedOn: "empty-prompt",
        closable: false,
        promptHead: "Open PR aligning acme.ai FAQ 'end-to-end encryption' + homepage 'no one can access your data but you' with the DPA (Nat…",
        lastLine: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
      },
      {
        tmuxName: "aw-e3199626",
        cwd: "/Users/alexboghossian/Documents/Code/acme-www",
        startedAt: "2026-09-26T15:53:31.256Z",
        blockedOn: "chrome",
        closable: true,
        promptHead: "Open PR aligning acme.ai FAQ 'end-to-end encryption' + homepage 'no one can access your data but you' with the DPA (Nat…",
        lastLine: "Enter to confirm · Esc to keep browser tools off",
      },
    ];
    const html = renderStrandedSection(real);
    expect(html).toContain(">2<");
    expect(html).toContain("sitting at an empty prompt");
    expect(html).toContain("blocked on the Chrome prompt");
    expect(html).toContain('data-attach="aw-68597ce4"');
    expect(html).toContain('data-attach="aw-e3199626"');
    expect(html).toContain("Open PR aligning acme.ai FAQ");
  });

  it("sorts oldest first", () => {
    const older = stranded({ tmuxName: "aw-older111", startedAt: "2026-09-26T08:00:00.000Z" });
    const newer = stranded({ tmuxName: "aw-newer111", startedAt: "2026-09-27T08:00:00.000Z" });
    const html = renderStrandedSection([newer, older]);
    expect(html.indexOf("aw-older111")).toBeLessThan(html.indexOf("aw-newer111"));
  });

  // Decision 2b: a row waiting on claude's trust dialog offers the one fix that doesn't answer it by keys.
  it("a row waiting on the trust dialog offers Trust <folder> & relaunch, with its tmux name and folder; no other row does", () => {
    const html = renderStrandedSection([stranded({ blockedOn: "trust" })]);
    expect(html).toContain('data-trust-relaunch="aw-68597ce4" data-cwd="/Users/alexboghossian/Documents/Code/acme-www">Trust acme-www &amp; relaunch</button>');
    for (const blockedOn of ["chrome", "exited", "empty-prompt", "menu", "unknown"] as const) {
      expect(renderStrandedSection([stranded({ blockedOn })])).not.toContain("data-trust-relaunch");
    }
    const hostile = renderStrandedSection([stranded({ blockedOn: "trust", cwd: '/Users/s/Code/"><img src=x>' })]);
    expect(hostile).not.toContain("<img");
  });

  it("marks Close as the destructive action, distinct from Attach", () => {
    const html = renderStrandedSection([stranded({ blockedOn: "trust" })]);
    expect(html).toMatch(/class="i-btn-danger" data-close="/);
    expect(html).not.toMatch(/class="i-btn-danger"[^>]*data-attach=/);
  });

  // Regression (PR #29 review): Close was offered on every row, including an empty prompt, a menu
  // and an unknown screen, which a working agent also shows. The route now refuses those every
  // time, so the row offers only Attach, with a hint saying how to close it.
  it("offers Close only on the trust dialog, the Chrome dialog or a shell, never where a working agent could be", () => {
    for (const blockedOn of ["trust", "chrome", "exited"] as const) {
      expect(renderStrandedSection([stranded({ blockedOn })])).toContain('data-close="aw-68597ce4"');
    }
    for (const blockedOn of ["empty-prompt", "menu", "unknown"] as const) {
      const html = renderStrandedSection([stranded({ blockedOn })]);
      expect(html).not.toContain("data-close");
      expect(html).toContain('data-attach="aw-68597ce4"');
      expect(html).toContain("exit it in Terminal");
    }
  });

  // Probe 2026-09-28: the reason lived only in Attach's hover title, so the row silently offered
  // Attach alone. It is now a visible line under the row.
  it("shows why Close isn't offered as a visible line under the row, not only a hover title", () => {
    const cases: Array<[Partial<StrandedDispatch>, string]> = [
      [{ blockedOn: "empty-prompt" }, "A working agent can look like this, so Alef won&#39;t close it. Attach and exit it in Terminal."],
      [{ blockedOn: "menu" }, "A working agent can look like this"],
      [{ blockedOn: "unknown" }, "A working agent can look like this"],
      [{ blockedOn: "trust", closable: false }, "This tmux session has other windows or panes, so Alef won&#39;t close it."],
    ];
    for (const [over, reason] of cases) {
      const html = renderStrandedSection([stranded(over)]);
      const why = html.indexOf('<small class="i-stranded-why">');
      expect(why).toBeGreaterThan(html.indexOf("i-stranded-actions"));
      expect(html.slice(why)).toContain(reason);
      expect(html).not.toContain("title=");
    }
    const closable = renderStrandedSection([stranded({ blockedOn: "chrome", closable: true })]);
    expect(closable).toContain("data-close");
    expect(closable).not.toContain("i-stranded-why");
  });

  // Regression (PR #29 review, HIGH): the screen is read from the active pane only, but Close runs
  // kill-session on the whole session, so a closable screen in a session with another window or
  // pane offered Close. The server marks those closable:false; the row offers only Attach.
  it("offers no Close on a closable screen whose session has other windows or panes", () => {
    for (const blockedOn of ["trust", "chrome", "exited"] as const) {
      const html = renderStrandedSection([stranded({ blockedOn, closable: false })]);
      expect(html).not.toContain("data-close");
      expect(html).toContain('data-attach="aw-68597ce4"');
      expect(html).toContain("other windows or panes");
    }
  });
});

// Regression (PR #29 review): the confirm said "anything unread in it is lost" and called it a
// "stranded session" — but the route saves the whole scrollback to ~/.alef-trash before the kill,
// and what's being closed is a stuck dispatch.
describe("STRANDED_CLOSE_CONFIRM", () => {
  it("names a stuck dispatch and says the scrollback is saved to ~/.alef-trash, not lost", () => {
    expect(STRANDED_CLOSE_CONFIRM).toContain("stuck dispatch");
    expect(STRANDED_CLOSE_CONFIRM).toContain("scrollback is saved to ~/.alef-trash");
    expect(STRANDED_CLOSE_CONFIRM).not.toMatch(/\blost\b/);
  });

  // Regression (PR #29 review): it promised "nothing is closed if it has started working since",
  // which the server could not keep, and it pushed the user toward Close on live agents.
  it("states the conditions Close checks instead of promising it can spot a working agent", () => {
    expect(STRANDED_CLOSE_CONFIRM).not.toContain("started working");
    expect(STRANDED_CLOSE_CONFIRM).toContain("folder-trust or Chrome dialog, or back at a shell");
    expect(STRANDED_CLOSE_CONFIRM).toContain("one window and one pane");
    expect(STRANDED_CLOSE_CONFIRM).toContain("no session in this project has been active since it was dispatched");
  });
});

describe("renderEmptyState", () => {
  it("shows 'Inbox zero' only when nothing is waiting AND nothing is stranded", () => {
    expect(renderEmptyState(0, 0)).toContain("Inbox zero");
  });

  it("is empty once anything is waiting", () => {
    expect(renderEmptyState(1, 0)).toBe("");
  });

  // Regression (PR #29 review): the old render() baked "Inbox zero. Nobody is waiting on you."
  // into the waiting-list markup by itself, so it rendered right above a non-empty "Started from
  // Alef but never began" section whenever nothing was waiting but something was stranded.
  it("is empty once anything is stranded, even with nothing waiting", () => {
    expect(renderEmptyState(0, 1)).toBe("");
  });

  it("is empty while the Health keeper's item for the day is open", () => {
    expect(renderEmptyState(0, 0, 1)).toBe("");
    expect(renderEmptyState(0, 0, 0)).toContain("Inbox zero");
  });
});

const healthItem = (over: Partial<HealthKeeperInboxItem> = {}): HealthKeeperInboxItem => ({
  date: "2026-09-30",
  at: "2026-09-30T02:31:00.000Z",
  score: 87,
  text: "Health 87%: Tests pass — Health › Run tests",
  issues: [
    { id: "tests", label: "Tests pass", state: "warn", detail: "Last run 28h ago", fix: "Health › Run tests (a red run: fix the failing tests)" },
    { id: "trust-targets", label: "Launch targets <b>x</b>", state: "warn", detail: "22 of 28", fix: "Health › Trust these N folders" },
  ],
  resolvedAt: null,
  ...over,
});

describe("renderHealthSection (the Health keeper's Inbox item)", () => {
  it("shows the score, each check with its fix, and an Open Health button; text is escaped", () => {
    const html = renderHealthSection(healthItem());
    expect(html).toContain("Health 87%");
    expect(html).toContain("<b>Tests pass</b> — Health › Run tests (a red run: fix the failing tests)");
    expect(html).toContain("Launch targets &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('data-open-health="1"');
  });

  it("renders nothing without an open item", () => {
    expect(renderHealthSection(null)).toBe("");
  });

  it("only an unresolved item is open", () => {
    const state = (inbox: HealthKeeperInboxItem | null): HealthKeeperState => ({ lastRunAt: null, nextRunAt: "2026-10-01T02:30:00.000Z", lastScore: 87, lastFailing: [], lastTests: null, running: false, inbox, lastError: null });
    expect(openHealthInboxItem(state(healthItem()))).toMatchObject({ score: 87 });
    expect(openHealthInboxItem(state(healthItem({ resolvedAt: "2026-09-30T09:00:00.000Z" })))).toBeNull();
    expect(openHealthInboxItem(state(null))).toBeNull();
    expect(openHealthInboxItem(null)).toBeNull();
  });
});

describe("makeStrandedActions", () => {
  function fakeApi(result: TalkActionResult): { api: ClientApi; calls: string[] } {
    const calls: string[] = [];
    const api = {
      postJson: async (path: string) => {
        calls.push(path);
        return result;
      },
    } as unknown as ClientApi;
    return { api, calls };
  }

  it("posts to the right stranded endpoint for attach and close", async () => {
    const { api, calls } = fakeApi({ ok: true });
    const actions = makeStrandedActions(api, () => {});
    actions.attach("aw-x");
    actions.close("aw-y");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["/api/talk/stranded/aw-x/attach", "/api/talk/stranded/aw-y/close"]);
  });

  // Probe 2026-09-28: a successful Attach or Close showed nothing in-app, and Attach's Terminal
  // window can open behind the browser.
  it("says what a successful attach and close did", async () => {
    const toasts: Array<[string, string | undefined]> = [];
    const attach = makeStrandedActions(fakeApi({ ok: true, tmuxName: "aw-5c67d47b" }).api, (text, kind) => toasts.push([text, kind]));
    attach.attach("aw-5c67d47b");
    const close = makeStrandedActions(fakeApi({ ok: true, tmuxName: "aw-e3199626" }).api, (text, kind) => toasts.push([text, kind]));
    close.close("aw-e3199626");
    await Promise.resolve();
    await Promise.resolve();
    expect(toasts).toEqual([
      ["Opened Terminal on aw-5c67d47b. Answer Claude's question there (look for trust this folder, or a menu).", undefined],
      ["Closed aw-e3199626. Its screen was saved in ~/.alef-trash.", undefined],
    ]);
  });

  it("names the clicked session when the server's answer omits it", () => {
    expect(strandedSuccessText("close", "aw-y")).toBe("Closed aw-y. Its screen was saved in ~/.alef-trash.");
  });

  // Regression (PR #29 review): the mount() wiring did `void ctx.api.postJson(...)` and threw the
  // result away — a 404/409/500 gave the user no feedback at all; the click just did nothing.
  it("surfaces a failed attach/close through the toast instead of dropping it silently", async () => {
    const { api } = fakeApi({ ok: false, error: "not a stranded dispatch" });
    const toasts: Array<[string, string | undefined]> = [];
    const actions = makeStrandedActions(api, (text, kind) => toasts.push([text, kind]));
    actions.close("aw-gone");
    await Promise.resolve();
    await Promise.resolve();
    expect(toasts).toEqual([["not a stranded dispatch", "error"]]);
  });
});
