import { describe, expect, it } from "vitest";
import { TALK_INSTALL_HINT } from "../../../shared/features/talk";
import { RUNNING_ELSEWHERE_TEXT } from "../features/resume-guard";
import { NOT_AVAILABLE_TEXT, inputFrame, parseServerFrame, resizeFrame, stateAfterClose, stateLabel, termUrl, unavailableView } from "./terminal-lib";

describe("terminal-lib", () => {
  it("builds a same-origin ws url and encodes the agent id", () => {
    expect(termUrl({ protocol: "http:", host: "localhost:5178" }, "abc")).toBe("ws://localhost:5178/ws/term/abc");
    expect(termUrl({ protocol: "https:", host: "x.dev" }, "a/b c")).toBe("wss://x.dev/ws/term/a%2Fb%20c");
    expect(termUrl({ protocol: "http:", host: "h" }, "a", { cols: 100.4, rows: 30 })).toBe("ws://h/ws/term/a?cols=100&rows=30");
    expect(termUrl({ protocol: "http:", host: "h" }, "a", { cols: 2, rows: 30 })).toBe("ws://h/ws/term/a");
  });

  it("frames input and clamps resize", () => {
    expect(JSON.parse(inputFrame("ls\r"))).toEqual({ type: "input", data: "ls\r" });
    expect(JSON.parse(resizeFrame(80.7, 24) ?? "")).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(JSON.parse(resizeFrame(9999, 999) ?? "")).toEqual({ type: "resize", cols: 500, rows: 200 });
    expect(resizeFrame(0, 24)).toBeNull();
    expect(resizeFrame(Number.NaN, 24)).toBeNull();
  });

  it("reads raw output, JSON output and state envelopes", () => {
    expect(parseServerFrame("hello\r\n")).toEqual({ kind: "output", data: "hello\r\n" });
    expect(parseServerFrame("{not json")).toEqual({ kind: "output", data: "{not json" });
    expect(parseServerFrame(JSON.stringify({ type: "output", data: "x" }))).toEqual({ kind: "output", data: "x" });
    expect(parseServerFrame(JSON.stringify({ type: "exit" }))).toMatchObject({ kind: "state", state: "ended" });
    expect(parseServerFrame(JSON.stringify({ type: "unavailable", message: "no tmux" }))).toEqual({
      kind: "state",
      state: "unavailable",
      message: "no tmux",
    });
    expect(parseServerFrame(JSON.stringify({ type: "status", state: "live" }))).toMatchObject({ state: "live" });
    expect(parseServerFrame(JSON.stringify({ type: "ready", mode: "pty", tmuxName: "aw-x", cols: 80, rows: 24 }))).toMatchObject({ state: "live" });
    expect(parseServerFrame(JSON.stringify({ type: "screen", data: "pane" }))).toEqual({ kind: "screen", data: "pane" });
    expect(parseServerFrame(JSON.stringify({ type: "error", error: "no tmux session for this agent" }))).toEqual({
      kind: "state",
      state: "unavailable",
      message: "no tmux session for this agent",
    });
    expect(parseServerFrame(JSON.stringify({ type: "mystery" }))).toEqual({ kind: "ignore" });
    expect(parseServerFrame(JSON.stringify({ type: "output", data: 3 }))).toEqual({ kind: "ignore" });
  });

  it("maps socket closes to states", () => {
    expect(stateAfterClose(1006, false, "connecting")).toBe("unavailable");
    expect(stateAfterClose(1000, true, "live")).toBe("ended");
    expect(stateAfterClose(4404, true, "live")).toBe("unavailable");
    expect(stateAfterClose(1000, true, "unavailable")).toBe("unavailable");
  });

  it("labels every state", () => {
    expect(stateLabel("live").text).toBe("Live");
    expect(stateLabel("unavailable").text).toBe("Not available");
  });

  // Probe 2026-09-28: the Code view's terminal offered "Resume here" for a live agent running in
  // VS Code, and resuming started a second copy of it.
  it("offers no Resume for a live agent running in another terminal, and says why", () => {
    expect(unavailableView("running-elsewhere", true)).toEqual({ text: RUNNING_ELSEWHERE_TEXT, resume: false });
  });

  it("offers no Resume when tmux is missing, and shows the install hint", () => {
    expect(unavailableView("no-tmux", true)).toEqual({ text: TALK_INSTALL_HINT, resume: false });
  });

  it("offers Resume for a dormant or bound agent when the host passed one, as before", () => {
    expect(unavailableView("resume", true)).toEqual({ text: NOT_AVAILABLE_TEXT, resume: true });
    expect(unavailableView("bound", true)).toEqual({ text: NOT_AVAILABLE_TEXT, resume: true });
    expect(unavailableView(undefined, true)).toEqual({ text: NOT_AVAILABLE_TEXT, resume: true });
    expect(unavailableView("resume", false)).toEqual({ text: NOT_AVAILABLE_TEXT, resume: false });
  });
});
