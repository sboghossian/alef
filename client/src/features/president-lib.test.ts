import { describe, expect, it } from "vitest";
import { cooldownText, dismissToast, recordLineHtml, renderProposalsSection, retireConfirmText, retireToast } from "./president-lib";
import { launchToast } from "./loops-lib";
import { DISMISS_COOLDOWN_MS, parsePresidentBoard, type PresidentActionResult, type PresidentBoard, type PresidentCommencementProposal, type PresidentRecord } from "../../../shared/features/president";

function board(proposals: PresidentBoard["proposals"]): PresidentBoard {
  return { generatedAt: "2026-09-26T00:00:00Z", proposals, source: "rules" };
}

describe("renderProposalsSection", () => {
  it("renders nothing for an empty board", () => {
    expect(renderProposalsSection(board([]))).toBe("");
  });

  it("renders a session proposal with a Launch and a Dismiss button", () => {
    const html = renderProposalsSection(board([{ id: "s1", kind: "session", task: "Fix the thing", city: "agent-world", model: "sonnet", why: "because reasons" }]));
    expect(html).toContain("Fix the thing");
    expect(html).toContain("agent-world");
    expect(html).toContain("sonnet");
    expect(html).toContain("because reasons");
    expect(html).toContain('data-launch="s1"');
    expect(html).toContain('data-dismiss="s1"');
    expect(html).toContain(">Launch<");
    expect(html).not.toContain("data-merge"); // never renders a merge action for a session row
  });

  // (e) A double-click inside the ~2s launch window used to start two sessions.
  it("draws a proposal's Launch busy (disabled, 'Starting…') while its launch is in flight", () => {
    const b = board([{ id: "s1", kind: "session", task: "Fix the thing", city: "agent-world", model: "sonnet", why: "w" }]);
    const busy = renderProposalsSection(b, (id) => id === "s1");
    expect(busy).toMatch(/data-launch="s1" disabled aria-busy="true">Starting…</);
    expect(renderProposalsSection(b, () => false)).toContain('data-launch="s1">Launch<');
  });

  it("says where a proposal came from, with its sickness case count", () => {
    const html = renderProposalsSection(
      board([
        { id: "t1", kind: "session", task: "OpenRouter key read into 3 /yalla-brief transcripts", city: "yalla-brief", model: "sonnet", why: "w", origin: "treat", caseIds: ["a", "b", "c"] },
        { id: "r1", kind: "session", task: "Draft a lesson tripwire", city: "agent-world", model: "opus", why: "w", origin: "research", caseIds: ["a"] },
        { id: "s1", kind: "session", task: "Old board", city: "c", model: "m", why: "w" },
      ]),
    );
    expect(html).toContain("yalla-brief · sonnet · treatment (3 cases)");
    expect(html).toContain("agent-world · opus · new tripwire (1 case)");
    expect(html).toContain("c · m</span>"); // a board persisted before origins existed
  });

  it("renders a merge proposal with a Merge and a Dismiss button", () => {
    const html = renderProposalsSection(board([{ id: "m1", kind: "merge", districts: ["a", "b", "c"], into: "a", sessions: 4, why: "3 districts, 4 sessions, none active in 14+ days" }]));
    expect(html).toContain("Merge 3 districts into a");
    expect(html).toContain("a, b, c");
    expect(html).toContain("none active in 14+ days");
    expect(html).toContain('data-merge="m1"');
    expect(html).toContain('data-dismiss="m1"');
    expect(html).toContain(">Merge<");
    expect(html).not.toContain("data-launch");
  });

  it("escapes untrusted task/why text", () => {
    const html = renderProposalsSection(board([{ id: "s1", kind: "session", task: '<img src=x onerror=alert(1)>', city: "c", model: "m", why: "<script>bad</script>" }]));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("&lt;img");
  });

  it("renders the proposal count in the header", () => {
    const html = renderProposalsSection(
      board([
        { id: "s1", kind: "session", task: "A", city: "c", model: "m", why: "w" },
        { id: "s2", kind: "session", task: "B", city: "c", model: "m", why: "w" },
      ]),
    );
    expect(html).toContain('<span class="alef-fcount">2</span>');
  });
});

describe("dismissToast", () => {
  it("says how long Jev stays quiet, from the server's real cooldown constant (7 days)", () => {
    expect(DISMISS_COOLDOWN_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(dismissToast({ ok: true })).toEqual({ text: "Dismissed. Jev won't suggest it again for 7 days.", kind: "info" });
  });

  // Probe 2026-09-28: a failed dismiss (server restart, timeout) showed nothing and the row stayed.
  it("surfaces a failed dismiss with the server's reason", () => {
    expect(dismissToast({ ok: false, error: "unknown or expired proposal" })).toEqual({ text: "Couldn't dismiss: unknown or expired proposal", kind: "error" });
    expect(dismissToast({ ok: false, error: "world server unreachable" }).text).toBe("Couldn't dismiss: world server unreachable");
    expect(dismissToast({ ok: false }).text).toBe("Couldn't dismiss: unknown error");
  });

  it("words other cooldowns honestly", () => {
    expect(cooldownText(24 * 60 * 60 * 1000)).toBe("for 1 day");
    expect(cooldownText(3 * 60 * 60 * 1000)).toBe("for 3 hours");
    expect(cooldownText(90 * 60 * 1000)).toBe("for a while");
    expect(cooldownText(0)).toBe("for a while");
    expect(dismissToast({ ok: true }, 90 * 60 * 1000).text).toBe("Dismissed. Jev won't suggest it again for a while.");
  });
});

describe("Jev proposes › Launch uses the shared launch message", () => {
  it("shows the result, never 'Launching that session…'", () => {
    const r: PresidentActionResult = { ok: true, mode: "tmux", tmuxName: "aw-e10a9ec9", trust: "untrusted", waitingOn: "trust", cwd: "/Users/s/Documents/Code/legal-taxonomy" };
    expect(launchToast(r)).toEqual({
      text: "Started (plan mode) in tmux aw-e10a9ec9: Stop, Talk and the Screen reach it. Claude is waiting on its trust dialog for legal-taxonomy: nothing runs until you trust the folder (button here or in the Inbox) or answer it in Terminal.",
      kind: "error",
    });
    expect(launchToast({ ok: false, error: "Alef is still reading your proposals after a restart. Try again in a few seconds." }).text).toBe(
      "Couldn't launch: Alef is still reading your proposals after a restart. Try again in a few seconds.",
    );
  });
});

describe("🎓 Commencement block + Jev's record line", () => {
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const retire = (over: Partial<PresidentCommencementProposal> = {}): PresidentCommencementProposal => ({
    id: "retire-9f86d081884c",
    kind: "commencement",
    action: "retire",
    subject: "/inbox-operator",
    title: "Retire /inbox-operator (61 runs, last 2026-07-28)",
    task: "",
    why: "No run for 61 days (it lapses after 72h without one); 61 runs lifetime: 0 clean, 0 bad, 0 only wrote files",
    ...over,
  });
  const hook: PresidentCommencementProposal = {
    id: "hook-2c26b46b68ff",
    kind: "commencement",
    action: "hook",
    subject: "shared-checkout-stash",
    title: "Make lesson shared-checkout-stash a hook",
    task: "Lesson shared-checkout-stash: … Draft a Claude Code PreToolUse hook … Do not install it",
    why: "5 sessions repeated this lesson since the server started 2026-09-28 08:55Z (tripwire shared-checkout-stash, warn)",
  };
  const record: PresidentRecord = { days: 30, shown: 7, actedOn: 3, dismissed: 2, launched: 2, linked: 1, shipped: 1, rulesShown: 4, since: "2026-08-01T10:00:00.000Z" };

  it("renders commencement cards in their own block under the session list, with the record line closing the section", () => {
    const b: PresidentBoard = { ...board([{ id: "s1", kind: "session", task: "Fix", city: "c", model: "m", why: "w" }, retire(), hook]), record };
    const html = renderProposalsSection(b, () => false, NOW);
    expect(html).toContain('Jev proposes <span class="alef-fcount">3</span>');
    expect(html.indexOf('data-launch="s1"')).toBeLessThan(html.indexOf("🎓 Commencement"));
    expect(html).toContain('🎓 Commencement <span class="alef-fcount">2</span>');
    expect(html.trim().endsWith('<p class="pres-record" title="2 dismissed · 2 launched, 1 of them with a session Alef could follow to its outcome · 4 more shown by the rules fallback while Jev gave no answer (not counted) · record kept since 2026-08-01">Jev&#39;s proposals, 30 days: 7 shown · 3 acted on · 1 shipped</p>'.replace("&#39;", "'"))).toBe(true);
  });

  it("a retire card: Retire carries the id and subject for its confirm; no routine means no Unload button", () => {
    const html = renderProposalsSection(board([retire()]), () => false, NOW);
    expect(html).toContain('data-retire="retire-9f86d081884c" data-subject="/inbox-operator">Retire…<');
    expect(html).not.toContain("data-launch");
    expect(html).not.toContain("<details"); // nothing to launch, nothing to show
    expect(html).toContain("retire · only changes what Alef shows");
  });

  it("with a routine: an Unload button (a plan-mode launch) and its task shown; once started, the tmux name instead", () => {
    const withRoutine = retire({ routine: "com.stephane.inbox-operator", task: "The routine com.stephane.inbox-operator … Only after I confirm, unload it with launchctl." });
    const html = renderProposalsSection(board([withRoutine]), () => false, NOW);
    expect(html).toContain('data-launch="retire-9f86d081884c">Unload com.stephane.inbox-operator… (plan mode)<');
    expect(html).toContain("<summary>The unload session&#39;s task</summary>".replace("&#39;", "'"));
    const started = renderProposalsSection(board([{ ...withRoutine, unloadStartedAs: "aw-0dd10ad0" }]), () => false, NOW);
    expect(started).toContain("Unload session started: aw-0dd10ad0");
    expect(started).not.toContain("data-launch");
  });

  it("an unload-only card (a retired worker) has no Retire button and says what its session does", () => {
    const html = renderProposalsSection(board([retire({ id: "unload-1", retired: true, routine: "com.stephane.inbox-operator", title: "Unload com.stephane.inbox-operator: /inbox-operator is retired", task: "…" })]), () => false, NOW);
    expect(html).not.toContain("data-retire");
    expect(html).toContain('data-launch="unload-1">Unload com.stephane.inbox-operator… (plan mode)<');
    expect(html).toContain("unload · a plan-mode session shows the routine; it unloads only after you confirm there");
    expect(html).not.toContain("only changes what Alef shows");
  });

  it("launch cards say plan mode, show the server's task, and go busy while starting", () => {
    expect(renderProposalsSection(board([hook]), () => false, NOW)).toContain('data-launch="hook-2c26b46b68ff">Launch (plan mode)<');
    expect(renderProposalsSection(board([hook]), (id) => id === hook.id, NOW)).toContain('data-launch="hook-2c26b46b68ff" disabled aria-busy="true">Starting…<');
    expect(renderProposalsSection(board([hook]), () => false, NOW)).toContain("<summary>The task it starts with</summary>");
  });

  it("escapes every untrusted field (a subject from a title, a task from a todo file)", () => {
    const html = renderProposalsSection(board([{ ...hook, subject: '"><img src=x onerror=alert(1)>', title: "<b>t</b>", task: "<script>x</script>", why: "<i>w</i>" }]), () => false, NOW);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<b>t</b>");
  });

  it("no proposals: the record line alone once Jev has shown something, else nothing at all", () => {
    expect(renderProposalsSection({ ...board([]), record }, () => false, NOW)).toBe(recordLineHtml(record, NOW));
    expect(renderProposalsSection({ ...board([]), record: { ...record, shown: 0 } }, () => false, NOW)).toBe("");
    expect(renderProposalsSection(board([]), () => false, NOW)).toBe("");
  });

  it("a young record says since when it has been kept", () => {
    expect(recordLineHtml({ ...record, since: "2026-09-28T10:00:00.000Z" }, NOW)).toContain("1 shipped (record since 2026-09-28)</p>");
    expect(recordLineHtml(record, NOW)).toContain("1 shipped</p>");
  });

  it("Retire's confirm and toast say what it writes and what it never touches", () => {
    expect(retireConfirmText("/inbox-operator")).toBe("Retire /inbox-operator? This only changes what Alef shows (data/careers.json): nothing is written to launchd, skills or transcripts. Un-retire in the Tower undoes it.");
    expect(retireToast({ ok: false, error: "already retired" })).toEqual({ text: "Couldn't retire: already retired", kind: "error" });
    expect(retireToast({ ok: true }).kind).toBe("info");
  });

  it("parsePresidentBoard keeps a board with a malformed record, minus the record", () => {
    const raw = { ...board([hook]), record: { ...record, shipped: -1 } };
    expect(parsePresidentBoard(raw)).toEqual(board([hook]));
    expect(parsePresidentBoard({ ...board([hook]), record })?.record).toEqual(record);
    expect(parsePresidentBoard({ generatedAt: "x", proposals: [{ kind: "commencement", id: "a", action: "launch-missiles", subject: "", title: "", task: "", why: "" }], source: "jev" })).toBeNull();
  });
});
