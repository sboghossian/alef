import { describe, expect, it } from "vitest";
import { RUNNING_ELSEWHERE_TEXT, resumeOffer, resumeStartedText } from "./resume-guard";

describe("resumeOffer", () => {
  it("bound: an agent already in a world tmux session has nothing to resume", () => {
    expect(resumeOffer({ status: "live", bound: true, tmuxAvailable: true })).toBe("bound");
    expect(resumeOffer({ status: "dormant", bound: true, tmuxAvailable: true })).toBe("bound");
  });

  it("resume: a dormant, unbound agent with tmux installed", () => {
    expect(resumeOffer({ status: "dormant", bound: false, tmuxAvailable: true })).toBe("resume");
  });

  // Probe 2026-09-28: resuming live a9c4eac1 (running in VS Code) started a second copy.
  it("running-elsewhere: a live agent outside a world tmux session, whether or not tmux is installed", () => {
    expect(resumeOffer({ status: "live", bound: false, tmuxAvailable: true })).toBe("running-elsewhere");
    expect(resumeOffer({ status: "live", bound: false, tmuxAvailable: false })).toBe("running-elsewhere");
  });

  it("no-tmux: a dormant agent when tmux is missing", () => {
    expect(resumeOffer({ status: "dormant", bound: false, tmuxAvailable: false })).toBe("no-tmux");
  });

  it("the running-elsewhere text says why there is no button and what to do", () => {
    expect(RUNNING_ELSEWHERE_TEXT).toContain("Running in another terminal (VS Code or Terminal)");
    expect(RUNNING_ELSEWHERE_TEXT).toContain("stop it there first");
    expect(RUNNING_ELSEWHERE_TEXT).toContain("second copy");
  });
});

describe("resumeStartedText", () => {
  it("says where it runs from the server's answer, never that it is done", () => {
    const t = resumeStartedText({ ok: true, mode: "tmux", tmuxName: "aw-a9c4eac1" });
    expect(t).toBe("Resumed (claude --resume) in tmux aw-a9c4eac1: Stop, Talk and the Screen reach it.");
    expect(t).not.toMatch(/Launched|Done/);
  });

  it("a resume waiting on the trust dialog says to answer it in Terminal (a resume has no relaunch button)", () => {
    const t = resumeStartedText({ ok: true, mode: "tmux", tmuxName: "aw-a9c4eac1", waitingOn: "trust", cwd: "/Users/s/Code/acme-www" });
    expect(t).toContain("waiting on its trust dialog for acme-www: answer it in Terminal (Yes, I trust this folder)");
  });

  it("an attach to its existing tmux session says nothing new started", () => {
    expect(resumeStartedText({ ok: true, mode: "tmux", tmuxName: "aw-1", attached: true })).toBe("Already in tmux aw-1: Terminal attached, nothing new started.");
  });
});
