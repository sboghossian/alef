import { describe, expect, it } from "vitest";
import { VOICE_REMEMBER_MAX_BODY, type VoiceAction, type VoicePlanStep } from "../../../shared/features/voice-brain";
import {
  advanceVad,
  armConfirm,
  confirmationPrompt,
  heardOverReadBack,
  initialVadState,
  isStepAnswer,
  isStopWord,
  matchWakeWord,
  matchYesNo,
  needsConfirmation,
  PENDING_TTL_MS,
  planCursor,
  routeUtterance,
  runPlanSteps,
  voiceCityKeys,
  stepPendingConfirm,
  stripWakeWord,
  VAD_SILENCE_THRESHOLD,
  type VadState,
} from "./voice-logic";

const SPEECH = 0.5; // well above VAD_SILENCE_THRESHOLD
const SILENCE = 0.001; // well below it

describe("advanceVad", () => {
  it("never finalizes on silence before any speech was seen", () => {
    let state = initialVadState();
    for (let ms = 0; ms <= 5000; ms += 100) {
      const step = advanceVad(state, ms, SILENCE, "snappy");
      expect(step.finalize).toBe(false);
      state = step.state;
    }
  });

  it("finalizes once continuous silence reaches the preset's hangover after speech", () => {
    let state: VadState = initialVadState();
    state = advanceVad(state, 0, SPEECH, "snappy").state; // speech starts
    let finalizedAt = -1;
    for (let ms = 10; ms <= 2000; ms += 10) {
      const step = advanceVad(state, ms, SILENCE, "snappy");
      state = step.state;
      if (step.finalize) {
        finalizedAt = ms;
        break;
      }
    }
    // "snappy" = 800ms hangover; silence began right after the ms=0 speech sample.
    expect(finalizedAt).toBeGreaterThanOrEqual(800);
    expect(finalizedAt).toBeLessThan(820);
  });

  it("cancels the hangover the instant speech resumes", () => {
    let state: VadState = initialVadState();
    state = advanceVad(state, 0, SPEECH, "snappy").state;
    state = advanceVad(state, 500, SILENCE, "snappy").state; // 500ms of silence (< 800ms hangover)
    state = advanceVad(state, 550, SPEECH, "snappy").state; // speaks again — resets the clock
    const step = advanceVad(state, 1300, SILENCE, "snappy"); // only 750ms since the resumed speech
    expect(step.finalize).toBe(false);
  });

  it("uses a longer hangover for patient than snappy", () => {
    const runUntilFinalize = (preset: "snappy" | "patient"): number => {
      let state: VadState = initialVadState();
      state = advanceVad(state, 0, SPEECH, preset).state;
      for (let ms = 10; ms <= 5000; ms += 10) {
        const step = advanceVad(state, ms, SILENCE, preset);
        state = step.state;
        if (step.finalize) return ms;
      }
      return -1;
    };
    expect(runUntilFinalize("patient")).toBeGreaterThan(runUntilFinalize("snappy"));
  });

  it("is inert once finalized — the caller starts a fresh state for the next utterance", () => {
    let state: VadState = initialVadState();
    state = advanceVad(state, 0, SPEECH, "snappy").state;
    let finalized: VadState | null = null;
    for (let ms = 10; ms <= 2000 && !finalized; ms += 10) {
      const step = advanceVad(state, ms, SILENCE, "snappy");
      state = step.state;
      if (step.finalize) finalized = state;
    }
    expect(finalized).not.toBeNull();
    // Feeding more samples (even loud speech) to an already-finalized state is a no-op —
    // the real caller is expected to start a fresh initialVadState() for the next utterance.
    const after = advanceVad(finalized as VadState, 2100, SPEECH, "snappy");
    expect(after.finalize).toBe(false);
    expect(after.state).toEqual(finalized);
  });

  it("VAD_SILENCE_THRESHOLD matches aleph's ported constant", () => {
    expect(VAD_SILENCE_THRESHOLD).toBe(0.012);
  });
});

describe("matchWakeWord", () => {
  it("matches 'hey jev', 'yo jev' and bare 'jev', case-insensitively", () => {
    expect(matchWakeWord("Hey Jev what's up")).toEqual({ rest: "what's up" });
    expect(matchWakeWord("yo jev")).toEqual({ rest: "" });
    expect(matchWakeWord("JEV who worked on this")).toEqual({ rest: "who worked on this" });
  });
  it("returns null when there is no wake word", () => {
    expect(matchWakeWord("just some other transcript")).toBeNull();
  });
  it("does not false-positive on a word that merely contains 'jev'", () => {
    expect(matchWakeWord("jeveuxparlerfrancais")).toBeNull();
  });
});

describe("routeUtterance", () => {
  const cities = ["acme-ai-next", "agent-world", "yalla-brief"];

  it("routes ask/who/find/where starters to Ask Jev", () => {
    expect(routeUtterance("ask who worked on the pricing page", cities)).toEqual({ kind: "ask", question: "ask who worked on the pricing page" });
    expect(routeUtterance("who worked on the moon renderer", cities)).toEqual({ kind: "ask", question: "who worked on the moon renderer" });
    expect(routeUtterance("find the jessica email", cities)).toEqual({ kind: "ask", question: "find the jessica email" });
    expect(routeUtterance("where is the dispatch bar code", cities)).toEqual({ kind: "ask", question: "where is the dispatch bar code" });
  });

  it("routes dispatch/build/tell to the dispatch bar and extracts the known city", () => {
    expect(routeUtterance("dispatch agent-world to fix the moon glow", cities)).toEqual({
      kind: "dispatch",
      city: "agent-world",
      prompt: "fix the moon glow",
    });
    expect(routeUtterance("tell acme-ai-next to add a dark mode toggle", cities)).toEqual({
      kind: "dispatch",
      city: "acme-ai-next",
      prompt: "add a dark mode toggle",
    });
    expect(routeUtterance("build in agent-world a new billboard", cities)).toEqual({
      kind: "dispatch",
      city: "agent-world",
      prompt: "a new billboard",
    });
  });

  it("falls back to city:null (keep the currently selected city) when none is recognized", () => {
    expect(routeUtterance("dispatch to fix the header", cities)).toEqual({ kind: "dispatch", city: null, prompt: "to fix the header" });
  });

  it("routes anything else to Ask Jev", () => {
    expect(routeUtterance("what happened today", cities)).toEqual({ kind: "ask", question: "what happened today" });
  });

  it("routes an empty utterance to an empty ask rather than throwing", () => {
    expect(routeUtterance("   ", cities)).toEqual({ kind: "ask", question: "" });
  });
});

describe("matchWakeWord: Alef", () => {
  it("wakes on Hey Alef / Aleph / bare Alef, alongside Hey Jev", () => {
    expect(matchWakeWord("hey alef who is waiting on me")).toEqual({ rest: "who is waiting on me" });
    expect(matchWakeWord("Hey Aleph, play Claude FM")?.rest).toBe(", play Claude FM");
    expect(matchWakeWord("alef")).toEqual({ rest: "" });
    expect(matchWakeWord("hey jev open the board")).toEqual({ rest: "open the board" });
    expect(matchWakeWord("alphabet soup")).toBeNull();
  });
});

describe("stripWakeWord (whisper hears the wake word too)", () => {
  it("drops a leading wake word in whisper's spellings", () => {
    expect(stripWakeWord("Hey Aleph, how many agents are live?")).toBe("how many agents are live?");
    expect(stripWakeWord("hey, alef. open the board")).toBe("open the board");
    expect(stripWakeWord("Jev: who's waiting?")).toBe("who's waiting?");
    expect(stripWakeWord("Hey Alef")).toBe("");
  });
  it("keeps a name that isn't leading, and plain text untouched", () => {
    expect(stripWakeWord("tell alef I said hi")).toBe("tell alef I said hi");
    expect(stripWakeWord("alphabet soup")).toBe("alphabet soup");
    expect(stripWakeWord("")).toBe("");
  });
});

describe("matchYesNo", () => {
  it("short, unambiguous answers only", () => {
    for (const y of ["yes", "Yes.", "yeah", "yes please", "Go ahead", "do it", "OK", "confirm", "Hey Aleph, yes.", "sure, thanks"]) expect(matchYesNo(y), y).toBe("yes");
    for (const n of ["no", "No thanks.", "cancel", "nope", "never mind", "don't", "stop"]) expect(matchYesNo(n), n).toBe("no");
  });
  it("a sentence that merely contains yes/no is neither", () => {
    for (const t of ["yes but first check the tests", "no idea, how many agents are live?", "yesterday's report", "okay what happened today", "", "   "]) expect(matchYesNo(t), t).toBeNull();
  });
});

describe("the confirmation state machine", () => {
  const dispatch: VoiceAction = { type: "dispatch_session", islandId: "acme-leadgen", city: "acme-leadgen", prompt: "fix the login bug" };
  const T0 = 1_000_000;
  const armed = () => armConfirm(dispatch, "Shall I…?", T0);

  it("arms with a 30 s expiry", () => {
    expect(armed().expiresAt).toBe(T0 + PENDING_TTL_MS);
    expect(PENDING_TTL_MS).toBe(30_000);
  });

  it('a spoken "yes" runs it, exactly once', () => {
    const s = stepPendingConfirm(armed(), { kind: "utterance", text: "Yes, please." }, T0 + 5000);
    expect(s).toEqual({ pending: null, effect: "run", action: dispatch });
    expect(stepPendingConfirm(s.pending, { kind: "utterance", text: "yes" }, T0 + 6000).effect).toBe("pass");
  });

  it("a click works like the voice", () => {
    expect(stepPendingConfirm(armed(), { kind: "click", choice: "yes" }, T0 + 1).effect).toBe("run");
    expect(stepPendingConfirm(armed(), { kind: "click", choice: "no" }, T0 + 1)).toEqual({ pending: null, effect: "cancelled", action: null });
  });

  it('"no" cancels; anything else drops it and routes normally — never runs', () => {
    expect(stepPendingConfirm(armed(), { kind: "utterance", text: "no" }, T0 + 1).effect).toBe("cancelled");
    const other = stepPendingConfirm(armed(), { kind: "utterance", text: "yes but make it acme-ai-next instead" }, T0 + 1);
    expect(other).toEqual({ pending: null, effect: "pass", action: null });
  });

  it("after 30 s nothing runs: a late yes is told it expired, other speech passes", () => {
    const late = T0 + PENDING_TTL_MS;
    expect(stepPendingConfirm(armed(), { kind: "utterance", text: "yes" }, late)).toEqual({ pending: null, effect: "expired", action: null });
    expect(stepPendingConfirm(armed(), { kind: "click", choice: "yes" }, late + 1).effect).toBe("expired");
    expect(stepPendingConfirm(armed(), { kind: "utterance", text: "how many agents?" }, late + 1).effect).toBe("pass");
  });

  it("a tick before expiry keeps it pending; with nothing pending, utterances pass and clicks do nothing", () => {
    const p = armed();
    expect(stepPendingConfirm(p, { kind: "tick" }, T0 + 1)).toEqual({ pending: p, effect: "none", action: null });
    expect(stepPendingConfirm(null, { kind: "utterance", text: "yes" }, T0).effect).toBe("pass");
    expect(stepPendingConfirm(null, { kind: "click", choice: "yes" }, T0).effect).toBe("none");
  });
});

describe("which actions need a yes, and the read-back", () => {
  it("read-only actions run at once; anything that starts, stops or sends needs a yes", () => {
    expect(needsConfirmation({ type: "open_view", view: "board" })).toBe(false);
    expect(needsConfirmation({ type: "fly_to_agent", agentId: "a", title: "t" })).toBe(false);
    expect(needsConfirmation({ type: "open_room", agentId: "a", title: "t" })).toBe(false);
    expect(needsConfirmation({ type: "dispatch_session", islandId: "x", city: "x", prompt: "p" })).toBe(true);
    expect(needsConfirmation({ type: "approve" })).toBe(true);
    expect(needsConfirmation({ type: "deny" })).toBe(true);
    expect(needsConfirmation({ type: "mac_action", kind: "system", action: "lock" })).toBe(true);
  });

  it("reads the action back in plain words", () => {
    expect(confirmationPrompt({ type: "dispatch_session", islandId: "h", city: "acme-leadgen", prompt: "fix the login bug" }, null).prompt).toBe('Shall I dispatch "fix the login bug" to acme-leadgen, sir?');
    expect(confirmationPrompt({ type: "approve" }, { toolName: "Bash", agentTitle: "Fix login", summary: "npm test" }).prompt).toBe('Shall I approve Bash for "Fix login": npm test?');
    expect(confirmationPrompt({ type: "mac_action", kind: "app", action: "quit", app: "Safari" }, null).prompt).toBe("Shall I quit Safari, sir?");
    expect(confirmationPrompt({ type: "mac_action", kind: "system", action: "volume", value: 30 }, null).prompt).toBe("Shall I set the volume to 30 percent?");
  });

  it("approve/deny with nothing waiting is refused, not asked", () => {
    expect(confirmationPrompt({ type: "deny" }, null)).toEqual({ prompt: null, refusal: "There's nothing waiting for approval, sir." });
  });

  it("a very long dispatch prompt is shortened in the question", () => {
    const p = confirmationPrompt({ type: "dispatch_session", islandId: "h", city: "c", prompt: "x".repeat(300) }, null).prompt ?? "";
    expect(p.length).toBeLessThan(130);
    expect(p).toContain("…");
  });
});

describe("voiceCityKeys", () => {
  const islands = [
    { id: "alexboghossian", name: "alexboghossian", path: "/Users/someone" },
    { id: "alex-claude", name: "alex_claude", path: "/Users/someone/Documents/Code/alex_claude" },
    { id: "acme-ai-next", name: "acme-ai-next", path: "/Users/someone/Documents/Code/acme-ai-next" },
    { id: "harness", name: "harness", path: "" },
  ];
  it("resolves both the displayed name and the old folder name", () => {
    const keys = voiceCityKeys(islands);
    expect(keys.get("Home")).toBe("alexboghossian");
    expect(keys.get("alexboghossian")).toBe("alexboghossian");
    expect(keys.get("Vault")).toBe("alex-claude");
    expect(keys.get("alex_claude")).toBe("alex-claude");
    expect(keys.get("acme-ai-next")).toBe("acme-ai-next");
    expect(keys.has("harness")).toBe(false);
  });
  it("a spoken old folder name dispatches to the right district", () => {
    const keys = voiceCityKeys(islands);
    const r = routeUtterance("dispatch alexboghossian to tidy the downloads folder", [...keys.keys()]);
    expect(r.kind === "dispatch" && r.city ? keys.get(r.city) : null).toBe("alexboghossian");
  });
});

// ---------------------------------------------------------------- ported from Aleph (2026-10-14)

describe('barge-in words ("wa2ef")', () => {
  it.each(["stop", "Wa2ef!", "wa'ef.", "waef", "Hey Alef, wa2ef", "arrête", "hush", "Stop talking."])("%s stops Alef", (t) => {
    expect(isStopWord(t)).toBe(true);
  });
  it.each(["stop the music", "what if we stop", "wait for it", "stopwatch", ""])("%s is not a bare stop", (t) => {
    expect(isStopWord(t)).toBe(false);
  });
  it('"wa2ef" also cancels a pending "Shall I…?"', () => {
    expect(matchYesNo("wa2ef")).toBe("no");
  });
});

const PLAN: VoiceAction = {
  type: "plan",
  steps: [
    { type: "open_view", view: "board" },
    { type: "dispatch_session", islandId: "vault", city: "Vault", prompt: "tidy the inbox" },
    { type: "mac_action", kind: "system", action: "mute" },
  ],
};

describe("multi-step plan approval", () => {
  it("a plan with a mutating step needs a yes; an all read-only plan does not", () => {
    expect(needsConfirmation(PLAN)).toBe(true);
    expect(needsConfirmation({ type: "plan", steps: [{ type: "open_view", view: "board" }, { type: "open_view", view: "brain" }] })).toBe(false);
  });
  it("the read-back lists every step and the three answers", () => {
    const q = confirmationPrompt(PLAN, null);
    expect(q.prompt).toBe('I\'d do 3 things: one, open the board view; two, dispatch "tidy the inbox" to Vault; three, toggle mute. Say yes for all of them, "step by step", or no.');
  });
  it.each(["step by step", "Step-by-step.", "yes, one at a time", "one by one please"])("%s is a step answer", (t) => {
    expect(isStepAnswer(t)).toBe(true);
  });
  it("yes runs the whole plan; step by step hands it back for per-step yeses; no runs nothing", () => {
    const p = armConfirm(PLAN, "q", 1000, PENDING_TTL_MS, true);
    expect(stepPendingConfirm(p, { kind: "utterance", text: "yes" }, 2000)).toMatchObject({ effect: "run", action: PLAN });
    expect(stepPendingConfirm(p, { kind: "utterance", text: "step by step" }, 2000)).toMatchObject({ effect: "step", action: PLAN });
    expect(stepPendingConfirm(p, { kind: "click", choice: "step" }, 2000)).toMatchObject({ effect: "step", action: PLAN });
    expect(stepPendingConfirm(p, { kind: "utterance", text: "no" }, 2000)).toMatchObject({ effect: "cancelled", action: null });
    expect(stepPendingConfirm(p, { kind: "utterance", text: "approve all of them now" }, 2000)).toMatchObject({ effect: "pass", action: null });
  });
  it('"step by step" is never a yes to a single action, and a late one runs nothing', () => {
    const single = armConfirm<VoiceAction>({ type: "approve" }, "q", 1000);
    expect(stepPendingConfirm(single, { kind: "utterance", text: "step by step" }, 2000)).toMatchObject({ effect: "pass", action: null });
    const p = armConfirm(PLAN, "q", 1000, PENDING_TTL_MS, true);
    expect(stepPendingConfirm(p, { kind: "utterance", text: "step by step" }, 1000 + PENDING_TTL_MS)).toMatchObject({ effect: "expired", action: null });
  });
  it("planCursor runs read-only steps at once and stops at the next one that needs a yes", () => {
    const steps = (PLAN.type === "plan" ? PLAN.steps : []) as VoicePlanStep[];
    expect(planCursor(steps, 0)).toEqual({ runNow: [steps[0]], next: { step: steps[1], index: 1 } });
    expect(planCursor(steps, 2)).toEqual({ runNow: [], next: { step: steps[2], index: 2 } });
    expect(planCursor(steps, 3)).toEqual({ runNow: [], next: null });
  });
});

describe("memory write-back read-back", () => {
  it("needs a yes and reads the whole note back before anything is staged", () => {
    const a: VoiceAction = { type: "remember", title: "Doremi demo", body: "The Doremi Touch demo is on Thursday." };
    expect(needsConfirmation(a)).toBe(true);
    expect(confirmationPrompt(a, null).prompt).toBe('Shall I stage this note, "Doremi demo": The Doremi Touch demo is on Thursday?');
    const p = armConfirm(a, "q", 0);
    expect(stepPendingConfirm(p, { kind: "utterance", text: "sure, but change it" }, 10)).toMatchObject({ effect: "pass", action: null });
    expect(stepPendingConfirm(p, { kind: "tick" }, PENDING_TTL_MS)).toMatchObject({ effect: "expired", action: null });
  });
});

describe("plan execution (review R90)", () => {
  it("a failed step stops the plan: no later step runs on top of it", async () => {
    const ran: string[] = [];
    const r = await runPlanSteps(["a", "b", "c"], async (s) => (ran.push(s), s !== "b"), () => false);
    expect(r).toEqual({ done: 1, end: "failed" });
    expect(ran).toEqual(["a", "b"]);
  });
  it("a stop said while a step runs stops before the next one", async () => {
    let stop = false;
    const ran: string[] = [];
    const r = await runPlanSteps(["a", "b"], async (s) => {
      ran.push(s);
      stop = true; // "wa2ef" while step a is running
      return true;
    }, () => stop);
    expect(r).toEqual({ done: 1, end: "stopped" });
    expect(ran).toEqual(["a"]);
    expect(await runPlanSteps(["a", "b"], async () => true, () => false)).toEqual({ done: 2, end: "ok" });
  });
  it("a yes heard over Alef's own read-back never answers it; a no or wa2ef still may", () => {
    for (const t of ["yes", "Yes.", "okay", "sure, go ahead", "step by step"]) expect(heardOverReadBack(t)).toBe(true);
    for (const t of ["no", "wa2ef", "stop", "what time is it"]) expect(heardOverReadBack(t)).toBe(false);
  });
  it("the longest allowed note is read back in full, never cut short", () => {
    const body = `${"word ".repeat(VOICE_REMEMBER_MAX_BODY / 5 - 1)}end`;
    expect(body.length).toBeLessThanOrEqual(VOICE_REMEMBER_MAX_BODY);
    const a: VoiceAction = { type: "remember", title: "A title that is well over fifty characters long, really", body };
    const prompt = confirmationPrompt(a, null).prompt ?? "";
    expect(prompt).toContain(body);
    expect(prompt).toContain(a.title);
    expect(prompt).not.toContain("…");
  });
});
