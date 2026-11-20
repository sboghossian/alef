// Pure voice-loop logic — no DOM, no Web Audio, no SpeechRecognition — so it can be
// unit-tested with synthetic amplitude sequences and transcript strings instead of a
// real microphone (headless Chrome has no mic; see voice.ts for the impure wiring).
// VAD hangover + wake-word regex ported from aleph/public/app.js.

import { VAD_PRESETS, type VadPreset } from "../../../shared/features/voice";
import { VOICE_READ_ONLY_ACTIONS, VOICE_REMEMBER_MAX_BODY, VOICE_REMEMBER_MAX_TITLE, type VoiceAction, type VoicePlanStep } from "../../../shared/features/voice-brain";
import { displayIslandName } from "../../../shared/display";
import type { Island } from "../../../shared/types";

export const VAD_SILENCE_THRESHOLD = 0.012; // RMS below this counts as silence

export interface VadState {
  /** False once finalized; the caller starts a fresh state for the next utterance. */
  active: boolean;
  speechSeen: boolean;
  /** ms timestamp continuous silence began, or null while speech is ongoing/not yet seen. */
  silenceStartMs: number | null;
}

export function initialVadState(): VadState {
  return { active: true, speechSeen: false, silenceStartMs: null };
}

export interface VadStep {
  state: VadState;
  /** True exactly once, on the sample where the hangover window elapses. */
  finalize: boolean;
}

/** Feeds one amplitude sample (0..1 RMS) at time `atMs`. Pure: the caller supplies real
 *  time, so this has no timers of its own and is trivial to drive from a test. */
export function advanceVad(state: VadState, atMs: number, rms: number, preset: VadPreset): VadStep {
  if (!state.active) return { state, finalize: false };
  if (rms >= VAD_SILENCE_THRESHOLD) {
    return { state: { active: true, speechSeen: true, silenceStartMs: null }, finalize: false };
  }
  if (!state.speechSeen) return { state, finalize: false }; // silence before any speech: keep listening
  const silenceStartMs = state.silenceStartMs ?? atMs;
  const finalize = atMs - silenceStartMs >= VAD_PRESETS[preset];
  return { state: { active: !finalize, speechSeen: true, silenceStartMs }, finalize };
}

// ---------- wake word ("Hey Jev" / "Hey Alef", "Yo …", or the bare name) ----------

const WAKE_RE = /\b(?:(?:hey|yo)\s+)?(?:jev|alef|aleph)\b/i;

export interface WakeMatch {
  /** Whatever the speaker said after the trigger word, trimmed (may be ""). */
  rest: string;
}

/** Matches a wake word inside one recognized chunk (not the whole running transcript —
 *  callers pass only the NEW text since the last check, matching aleph's `chunk` logic). */
export function matchWakeWord(chunk: string): WakeMatch | null {
  const m = WAKE_RE.exec(chunk);
  if (!m) return null;
  return { rest: chunk.slice(m.index + m[0].length).trim() };
}

// ---------- utterance routing ----------

export type UtteranceRoute = { kind: "ask"; question: string } | { kind: "dispatch"; city: string | null; prompt: string };

const DISPATCH_VERBS = /^\s*(?:dispatch|build|tell)\b/i;
// "<city> to <prompt>", "in <city> <prompt>", "to <city> <prompt>" — whichever known
// city name is mentioned wins; unmatched falls back to city: null (the currently
// selected dispatch-bar city stays put) with the whole remainder as the prompt.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCity(rest: string, cityNames: readonly string[]): { city: string; prompt: string } | null {
  const m = /^(?:in\s+|to\s+)?([a-z0-9][a-z0-9 _-]*?)\s+to\s+(.+)$/i.exec(rest);
  if (m?.[1] && m[2]) {
    const candidate = m[1].trim().toLowerCase();
    const exact = cityNames.find((c) => c.toLowerCase() === candidate);
    const fuzzy = exact ?? cityNames.find((c) => candidate.includes(c.toLowerCase()) || c.toLowerCase().includes(candidate));
    if (fuzzy) return { city: fuzzy, prompt: m[2].trim() };
  }
  const mentioned = cityNames.find((c) => c.length > 0 && rest.toLowerCase().includes(c.toLowerCase()));
  if (!mentioned) return null;
  // Strip the city mention + a leading "in"/"to" so the dispatch prompt reads cleanly
  // ("build in agent-world the billboard" -> prompt "the billboard", not the whole utterance).
  const stripped = rest
    .replace(new RegExp(`\\b${escapeRegex(mentioned)}\\b`, "i"), "")
    .replace(/^\s*(?:in|to)\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { city: mentioned, prompt: stripped || rest };
}

/** "ask/who/find/where…" -> Ask Jev. "dispatch/build/tell <city> to…" -> fill the
 *  dispatch bar (never sent — the user still presses Enter). Anything else -> Ask Jev. */
export function routeUtterance(text: string, cityNames: readonly string[] = []): UtteranceRoute {
  const t = text.trim();
  if (!t) return { kind: "ask", question: "" };
  if (DISPATCH_VERBS.test(t)) {
    const rest = t.replace(DISPATCH_VERBS, "").trim();
    const found = findCity(rest, cityNames);
    return { kind: "dispatch", city: found?.city ?? null, prompt: found?.prompt ?? rest };
  }
  return { kind: "ask", question: t };
}

// ---------- local whisper transcripts ----------

const LEADING_WAKE_RE = /^\s*(?:(?:hey|hi|yo|ok|okay)[\s,]+)?(?:jev|alef|aleph|alif)\b[\s,.!?:;-]*/i;

/** Whisper hears the whole utterance, wake word included ("Hey, Aleph, how many…"): drop a
 *  LEADING wake word so routing sees only the request. A name mid-sentence is kept. */
export function stripWakeWord(text: string): string {
  return text.replace(LEADING_WAKE_RE, "").trim();
}

// ---------- the spoken "yes" for Alef's proposed actions ----------

const YES_RE = /^(?:yes|yeah|yep|yup|sure|ok|okay|confirm(?:ed)?|affirmative|do it|go ahead|go for it|please do|yes please|absolutely|correct|proceed|make it so|very well)(?:[\s,]+(?:please|sir|thanks|thank you|do it|go ahead|alef|aleph|jev))*$/i;
const NO_RE = /^(?:no|nope|nah|cancel|stop|wa(?:2|')?e+f|arr[eê]te|don'?t|do not|never ?mind|negative|abort|not now|leave it|no thanks|no thank you)(?:[\s,]+(?:please|sir|thanks|thank you|alef|aleph|jev|don'?t|cancel|it))*$/i;

/** "Wa2ef" (Lebanese "stop"; whisper writes it wa'ef / waef), "arrête", "stop", "hush"…: a whole
 *  utterance that only asks Alef to stop talking or stop what he is doing. */
export const STOP_WORD_RE = /^(?:stop|stop it|stop talking|shh+|hush|quiet|be quiet|shut up|enough|halt|wa(?:2|')?e+f|wa2if|arr[eê]te(?:z)?|tais[- ]toi)$/i;
export function isStopWord(text: string): boolean {
  return STOP_WORD_RE.test(stripWakeWord(text).toLowerCase().replace(/[.!?…"“”,]+/g, " ").replace(/\s+/g, " ").trim());
}

const STEP_RE = /^(?:(?:yes|ok|okay)\s+)?(?:step by step|one (?:at a time|by one|step at a time)|each step|ask me each (?:time|step))(?:\s+please)?$/i;

/** "Step by step" (or "one at a time"…) as a whole answer to a plan's read-back. */
export function isStepAnswer(text: string): boolean {
  return STEP_RE.test(stripWakeWord(text).toLowerCase().replace(/[.!?…"“”,-]+/g, " ").replace(/\s+/g, " ").trim());
}

/** "yes" / "no" / null for a whole utterance. Only a short, unambiguous answer counts: a
 *  sentence that merely contains "yes" ("yes but first…") is NOT a yes. */
export function matchYesNo(text: string): "yes" | "no" | null {
  const t = stripWakeWord(text).toLowerCase().replace(/[.!?…"“”]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (YES_RE.test(t)) return "yes";
  if (NO_RE.test(t)) return "no";
  return null;
}

export const PENDING_TTL_MS = 30_000;

/** An action Alef proposed that changes something and is waiting for the user's yes. */
export interface PendingConfirm<A> {
  action: A;
  prompt: string;
  expiresAt: number;
  /** A plan's read-back: "step by step" is an answer too (each step then gets its own yes). */
  allowStep?: boolean;
}

export type ConfirmInput = { kind: "utterance"; text: string } | { kind: "click"; choice: "yes" | "no" | "step" } | { kind: "tick" };

export interface ConfirmStep<A> {
  pending: PendingConfirm<A> | null;
  /** run: execute `action` now · cancelled: said/clicked no · expired: 30 s passed ·
   *  step: run a plan one step at a time, each with its own yes ·
   *  pass: not an answer (the pending one is dropped and the utterance routes normally) · none. */
  effect: "run" | "step" | "cancelled" | "expired" | "pass" | "none";
  action: A | null;
}

/** The confirmation state machine. Pure: the caller passes `nowMs`. A pending action runs
 *  ONLY on a spoken yes or a Yes click before it expires; anything else never runs it. */
export function stepPendingConfirm<A>(pending: PendingConfirm<A> | null, input: ConfirmInput, nowMs: number): ConfirmStep<A> {
  if (!pending) return { pending: null, effect: input.kind === "utterance" ? "pass" : "none", action: null };
  if (nowMs >= pending.expiresAt) {
    // A late "yes" must never run it — and must not wander off to the brain as a bare "yes" either.
    const late = input.kind === "utterance" && matchYesNo(input.text) === null && !isStepAnswer(input.text);
    return { pending: null, effect: late ? "pass" : "expired", action: null };
  }
  if (input.kind === "tick") return { pending, effect: "none", action: null };
  const step = input.kind === "click" ? input.choice === "step" : isStepAnswer(input.text);
  if (step) return pending.allowStep ? { pending: null, effect: "step", action: pending.action } : { pending: null, effect: "pass", action: null };
  const answer = input.kind === "click" ? input.choice : matchYesNo(input.text);
  if (answer === "yes") return { pending: null, effect: "run", action: pending.action };
  if (answer === "no") return { pending: null, effect: "cancelled", action: null };
  return { pending: null, effect: "pass", action: null };
}

/** Arms a confirmation that expires `ttlMs` after `nowMs`. */
export function armConfirm<A>(action: A, prompt: string, nowMs: number, ttlMs = PENDING_TTL_MS, allowStep = false): PendingConfirm<A> {
  return allowStep ? { action, prompt, expiresAt: nowMs + ttlMs, allowStep } : { action, prompt, expiresAt: nowMs + ttlMs };
}

// ---------- Alef's actions: which need a yes, and how the question is read back ----------

/** open_view / fly_to_agent / open_room run at once; everything else needs a yes (a plan does
 *  unless every step is read-only). */
export function needsConfirmation(a: VoiceAction): boolean {
  if (a.type === "plan") return a.steps.some(needsConfirmation);
  return !VOICE_READ_ONLY_ACTIONS.includes(a.type);
}

/** Where a step-by-step plan stands from step `from`: the read-only steps to run at once, then the
 *  next step that needs its own yes (null: the plan is done). */
export function planCursor(steps: readonly VoicePlanStep[], from: number): { runNow: VoicePlanStep[]; next: { step: VoicePlanStep; index: number } | null } {
  const runNow: VoicePlanStep[] = [];
  for (let i = from; i < steps.length; i++) {
    const step = steps[i];
    if (!step) break;
    if (needsConfirmation(step)) return { runNow, next: { step, index: i } };
    runNow.push(step);
  }
  return { runNow, next: null };
}

/** A step as a short clause for the plan's read-back ("dispatch "fix it" to Vault"). */
export function stepPhrase(a: VoicePlanStep): string {
  switch (a.type) {
    case "open_view":
      return `open the ${a.view} view`;
    case "fly_to_agent":
      return `fly to ${quoteShort(a.title, 40)}`;
    case "open_room":
      return `open ${quoteShort(a.title, 40)}'s room`;
    case "dispatch_session":
      return `dispatch "${quoteShort(a.prompt, 60)}" to ${a.city}`;
    case "mac_action":
      if (a.kind === "app") return `${a.action} ${quoteShort(a.app, 40)}`;
      if (a.action === "volume") return `set the volume to ${a.value ?? 0} percent`;
      return MAC_SYSTEM_PHRASE[a.action] ?? a.action;
  }
}

/** Runs plan steps in order. It stops before a step once `stopped()` is true (barge-in, Esc,
 *  "wa2ef") and after the first step that failed, so a later step never runs on a failed one. */
export async function runPlanSteps<S>(steps: readonly S[], run: (s: S) => Promise<boolean>, stopped: () => boolean): Promise<{ done: number; end: "ok" | "stopped" | "failed" }> {
  for (const [i, s] of steps.entries()) {
    if (stopped()) return { done: i, end: "stopped" };
    if (!(await run(s))) return { done: i, end: "failed" };
  }
  return { done: steps.length, end: "ok" };
}

/** A wake-word chunk heard while Alef is still talking may be his own read-back coming back
 *  through the mic ('…dispatch "tell Alef yes"…'): a yes / "step by step" there never answers a
 *  pending "Shall I…?". (A "no" or "wa2ef" still may: stopping is always safe.) */
export function heardOverReadBack(rest: string): boolean {
  return matchYesNo(rest) === "yes" || isStepAnswer(rest);
}

const ORDINAL = ["one", "two", "three", "four"];

export interface ApprovalInfo {
  toolName: string;
  agentTitle: string | null;
  summary: string;
}

function quoteShort(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const MAC_SYSTEM_PHRASE: Record<string, string> = {
  "play-pause": "play or pause the music",
  next: "skip to the next track",
  prev: "go back a track",
  mute: "toggle mute",
  screenshot: "take a screenshot",
  lock: "lock the screen",
};

/** The spoken read-back for a mutating action, or a reason it can't be offered (null prompt). */
export function confirmationPrompt(a: VoiceAction, approval: ApprovalInfo | null): { prompt: string | null; refusal: string | null } {
  switch (a.type) {
    case "dispatch_session":
      return { prompt: `Shall I dispatch "${quoteShort(a.prompt)}" to ${a.city}, sir?`, refusal: null };
    case "approve":
    case "deny": {
      if (!approval) return { prompt: null, refusal: "There's nothing waiting for approval, sir." };
      const verb = a.type === "approve" ? "approve" : "deny";
      const who = approval.agentTitle ? ` for "${quoteShort(approval.agentTitle, 50)}"` : "";
      const what = approval.summary ? `: ${quoteShort(approval.summary, 70)}` : "";
      return { prompt: `Shall I ${verb} ${approval.toolName}${who}${what}?`, refusal: null };
    }
    case "mac_action":
      if (a.kind === "app") return { prompt: `Shall I ${a.action} ${quoteShort(a.app, 40)}, sir?`, refusal: null };
      if (a.action === "volume") return { prompt: `Shall I set the volume to ${a.value ?? 0} percent?`, refusal: null };
      return { prompt: `Shall I ${MAC_SYSTEM_PHRASE[a.action] ?? a.action}, sir?`, refusal: null };
    case "remember":
      // Read back in full (never truncated): what is staged is exactly what he heard.
      return { prompt: `Shall I stage this note, "${quoteShort(a.title, VOICE_REMEMBER_MAX_TITLE)}": ${quoteShort(a.body, VOICE_REMEMBER_MAX_BODY).replace(/[.!?]+$/, "")}?`, refusal: null };
    case "plan": {
      const list = a.steps.map((s, i) => `${ORDINAL[i] ?? String(i + 1)}, ${stepPhrase(s)}`).join("; ");
      return { prompt: `I'd do ${a.steps.length} things: ${list}. Say yes for all of them, "step by step", or no.`, refusal: null };
    }
    default:
      return { prompt: null, refusal: null }; // read-only: no question needed
  }
}

/** Spoken name → island id for voice dispatch. Both the displayed name ("Home", "Vault") and the
 *  raw folder name ("alexboghossian", "alex_claude") resolve, so old habits keep working. */
export function voiceCityKeys(islands: Iterable<Pick<Island, "id" | "name" | "path">>): Map<string, string> {
  const map = new Map<string, string>();
  for (const island of islands) {
    if (island.id === "harness") continue;
    map.set(displayIslandName(island), island.id);
    if (!map.has(island.name)) map.set(island.name, island.id);
  }
  return map;
}
