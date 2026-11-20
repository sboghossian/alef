// Alef's conversational brain, client side: sends one utterance to POST /api/voice/turn, reads the
// NDJSON stream (sentences with Piper audio, at most one action, done), hands each sentence to the
// voice feature's speech queue as it arrives, and runs the proposed action:
//   - read-only (open a view, fly to an agent, dive into an agent's Room): at once;
//   - anything that starts, stops or sends (dispatch, approve/deny, Mac actions): read back as a
//     question and run ONLY after a spoken "yes" or a click on "Yes, do it", within 30 s.
// The yes/no matching and the state machine are pure and tested (voice-logic.ts); this file is
// the impure glue (fetch, DOM card, real API calls). Not a ClientFeature: voice.ts and the Voice
// view import it.

import "./voice-brain.css";
import type { VoiceAction, VoicePlanStep, VoiceRememberResult, VoiceTurnEvent } from "../../../shared/features/voice-brain";
import { log } from "../log";
import { decideApproval, pendingApprovals } from "./approvals";
import type { ClientContext } from "./registry";
import { armConfirm, confirmationPrompt, needsConfirmation, PENDING_TTL_MS, planCursor, runPlanSteps, stepPendingConfirm, stepPhrase, type ConfirmInput, type PendingConfirm } from "./voice-logic";
import { agentTitle } from "../../../shared/display";
import { launchNeedsYou, launchSuccessText, trustRelaunchAction } from "../ui/launch-result";

/** How the brain talks: the voice feature's queue (Piper audio when there is a URL, else TTS). */
export interface SpeechOut {
  say(text: string, audioUrl: string | null): void;
}

export interface AlefTurnHooks {
  /** Each spoken sentence as it arrives (the Voice view grows one Alef bubble from these). */
  onSentence?(text: string): void;
  /** The turn is over (also after an error or an abort). */
  onDone?(ok: boolean): void;
}

interface Proposal {
  action: VoiceAction;
  /** approve/deny are bound to the approval that was read back, never to whichever is oldest later. */
  approvalId: string | null;
  /** One step of a plan run step by step: its index in `steps` (the rest wait for their own yes). */
  plan?: { steps: VoicePlanStep[]; index: number };
}

const clientId = `c${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
let controller: AbortController | null = null;
let pending: PendingConfirm<Proposal> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let card: HTMLElement | null = null;
/** Bumped by every barge-in / Esc / "wa2ef": a running plan stops before its next step. */
let planGen = 0;

/** Stops the turn in flight (barge-in / Esc), and any plan between steps unless `keepPlan` (the
 *  Voice view closing: a plan's own open_view step does that). The server kills its claude when
 *  we hang up. */
export function abortAlefTurn(keepPlan = false): void {
  controller?.abort();
  controller = null;
  if (!keepPlan) planGen++;
}

export function alefThinking(): boolean {
  return controller !== null;
}

// ---------------------------------------------------------------- actions

/** Runs one action. False: it failed (and said so), so a plan stops there. */
async function runAction(p: Proposal, ctx: ClientContext, out: SpeechOut): Promise<boolean> {
  const a = p.action;
  switch (a.type) {
    case "open_view":
      ctx.showView(a.view);
      return true;
    case "fly_to_agent":
      if (ctx.activeView() !== "orbit") ctx.showView("orbit");
      ctx.flyTo(a.agentId);
      return true;
    case "open_room":
      ctx.diveToRoom(a.agentId);
      return true;
    case "dispatch_session": {
      const r = await ctx.api.dispatch({ islandId: a.islandId, prompt: a.prompt });
      if (r.ok) out.say(`Dispatched to ${a.city}.`, null);
      else out.say(`The dispatch failed: ${r.error ?? "unknown error"}.`, null);
      ctx.toast(r.ok ? launchSuccessText(r, `Dispatched to ${a.city}`) : `Dispatch failed: ${r.error ?? "unknown error"}`, r.ok && !launchNeedsYou(r) ? "info" : "error", trustRelaunchAction(ctx.api, ctx.toast, r));
      return r.ok;
    }
    case "approve":
    case "deny": {
      const still = p.approvalId ? pendingApprovals().find((x) => x.id === p.approvalId) : undefined;
      if (!still || !p.approvalId) {
        out.say("That approval is no longer waiting, so I've done nothing.", null);
        return false;
      }
      await decideApproval(ctx, p.approvalId, a.type === "approve" ? "allow" : "deny");
      out.say(a.type === "approve" ? "Approved." : "Denied.", null);
      return true;
    }
    case "mac_action": {
      const r =
        a.kind === "app"
          ? await ctx.api.postJson<{ ok: boolean; error?: string }>("/api/mac/app", { action: a.action, name: a.app }, (error) => ({ ok: false, error }))
          : await ctx.api.postJson<{ ok: boolean; error?: string }>("/api/mac/system", a.value === undefined ? { action: a.action } : { action: a.action, value: a.value }, (error) => ({ ok: false, error }));
      out.say(r.ok ? "Done." : `That didn't work: ${r.error ?? "unknown error"}.`, null);
      return r.ok;
    }
    case "remember": {
      const r = await ctx.api.postJson<VoiceRememberResult>("/api/voice/remember", { title: a.title, body: a.body }, (error) => ({ ok: false, error }));
      out.say(r.ok ? "Staged in your notes for review, sir. Nothing went into memory itself." : r.error, null);
      return r.ok;
    }
    case "plan":
      return runPlanAll(a.steps, ctx, out);
  }
}

/** After one yes to the whole read-back: every step in order, stopping at a barge-in or a failure. */
async function runPlanAll(steps: readonly VoicePlanStep[], ctx: ClientContext, out: SpeechOut): Promise<boolean> {
  const gen = planGen;
  const r = await runPlanSteps(steps, (s) => runAction({ action: s, approvalId: null }, ctx, out), () => gen !== planGen);
  if (r.end !== "ok") out.say(`${r.end === "stopped" ? "Stopped" : "I've stopped the plan there"}. ${r.done} of ${steps.length} steps were done.`, null);
  return r.end === "ok";
}

/** Step by step: read-only steps run at once; the next one that changes something asks for its yes.
 *  `gen` is the plan generation from BEFORE the step just confirmed ran, so a "wa2ef" said while
 *  it ran still stops the rest. */
async function planStep(steps: VoicePlanStep[], from: number, gen: number, ctx: ClientContext, out: SpeechOut): Promise<void> {
  const c = planCursor(steps, from);
  const r = await runPlanSteps(c.runNow, (s) => runAction({ action: s, approvalId: null }, ctx, out), () => gen !== planGen);
  if (r.end === "ok" && !c.next) {
    out.say("That's the whole plan done, sir.", null);
    return;
  }
  if (r.end !== "ok" || gen !== planGen || !c.next) {
    out.say(`I've stopped the plan before step ${from + r.done + 1}.`, null);
    return;
  }
  const prompt = `Step ${c.next.index + 1} of ${steps.length}: shall I ${stepPhrase(c.next.step)}?`;
  arm({ action: c.next.step, approvalId: null, plan: { steps, index: c.next.index } }, prompt, false, ctx, out);
}

// ---------------------------------------------------------------- the "Shall I…?" card

function clearPending(): void {
  pending = null;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  card?.remove();
  card = null;
}

function showCard(prompt: string, allowStep: boolean, ctx: ClientContext, out: SpeechOut): void {
  card?.remove();
  const c = document.createElement("div");
  c.className = "alef-confirm";
  c.setAttribute("role", "alertdialog");
  c.setAttribute("aria-label", "Alef asks for your OK");
  const kicker = document.createElement("div");
  kicker.className = "alef-confirm-kicker";
  kicker.textContent = "🎙️ Alef asks";
  const text = document.createElement("p");
  text.className = "alef-confirm-text";
  text.textContent = prompt;
  const how = document.createElement("div");
  how.className = "alef-confirm-how";
  how.textContent = allowStep ? 'Say "yes" for all, "step by step", or "no". Expires in 30 s.' : 'Say "yes" or click. Expires in 30 s.';
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "comic-btn small";
  yes.textContent = "Yes, do it";
  yes.title = "Run it now";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "comic-btn secondary small";
  no.textContent = "No";
  no.title = "Cancel: nothing runs";
  const row = document.createElement("div");
  row.className = "alef-confirm-row";
  row.append(yes);
  if (allowStep) {
    const step = document.createElement("button");
    step.type = "button";
    step.className = "comic-btn secondary small";
    step.textContent = "Step by step";
    step.title = "Ask me before each step";
    step.addEventListener("click", () => answer({ kind: "click", choice: "step" }, ctx, out));
    row.append(step);
  }
  row.append(no);
  c.append(kicker, text, how, row);
  yes.addEventListener("click", () => answer({ kind: "click", choice: "yes" }, ctx, out));
  no.addEventListener("click", () => answer({ kind: "click", choice: "no" }, ctx, out));
  document.body.append(c);
  card = c;
}

function answer(input: ConfirmInput, ctx: ClientContext, out: SpeechOut): boolean {
  const now = Date.now();
  const step = stepPendingConfirm(pending, input, now);
  const wasLive = pending !== null && now < pending.expiresAt;
  const wasPlanStep = pending?.action.plan?.index ?? null;
  if (step.effect === "none") return false;
  clearPending();
  switch (step.effect) {
    case "run":
      if (step.action) {
        const p = step.action;
        const gen = planGen;
        log.info("voice-brain", `confirmed ${p.action.type}${p.plan ? ` (plan step ${p.plan.index + 1})` : ""}`);
        void runAction(p, ctx, out)
          .then((ok) => {
            if (!p.plan) return;
            if (ok && gen === planGen) return planStep(p.plan.steps, p.plan.index + 1, gen, ctx, out);
            if (p.plan.index + 1 < p.plan.steps.length) out.say(`I've stopped the plan before step ${p.plan.index + 2}.`, null);
          })
          .catch((err: unknown) => {
            log.warn("voice-brain", "action failed", err);
            out.say("Something went wrong doing that, so I've stopped.", null);
          });
      }
      return true;
    case "step":
      if (step.action?.action.type === "plan")
        void planStep(step.action.action.steps, 0, planGen, ctx, out).catch((err: unknown) => {
          log.warn("voice-brain", "plan step failed", err);
          out.say("Something went wrong doing that, so I've stopped.", null);
        });
      return true;
    case "cancelled":
      out.say(wasPlanStep !== null ? `Very good. I've stopped the plan before step ${wasPlanStep + 1}.` : "Very good. Nothing was done.", null);
      return true;
    case "expired":
      out.say("That request expired, so nothing was done.", null);
      return true;
    case "pass":
      if (wasLive) ctx.toast("Cancelled Alef's pending request: you said something else.");
      return false;
    default:
      return false;
  }
}

/** Offer a spoken utterance to the pending "Shall I…?". True = it was the answer (don't route it). */
export function answerPendingConfirm(text: string, ctx: ClientContext, out: SpeechOut): boolean {
  if (!pending) return false;
  return answer({ kind: "utterance", text }, ctx, out);
}

export function hasPendingConfirm(): boolean {
  return pending !== null && Date.now() < pending.expiresAt;
}

function propose(action: VoiceAction, ctx: ClientContext, out: SpeechOut): void {
  if (!needsConfirmation(action)) {
    void runAction({ action, approvalId: null }, ctx, out);
    return;
  }
  let approvalId: string | null = null;
  let info = null;
  if (action.type === "approve" || action.type === "deny") {
    const first = pendingApprovals()[0];
    if (first) {
      approvalId = first.id;
      const agent = ctx.store.agents.get(first.agentId);
      info = { toolName: first.toolName, agentTitle: agent ? agentTitle(agent) : null, summary: first.preview.title || first.preview.body.split("\n")[0] || "" };
    }
  }
  const q = confirmationPrompt(action, info);
  if (!q.prompt) {
    out.say(q.refusal ?? "I can't offer that right now.", null);
    return;
  }
  arm({ action, approvalId }, q.prompt, action.type === "plan", ctx, out);
}

/** Puts one "Shall I…?" up (card + spoken), replacing any earlier one. */
function arm(p: Proposal, prompt: string, allowStep: boolean, ctx: ClientContext, out: SpeechOut): void {
  clearPending();
  pending = armConfirm(p, prompt, Date.now(), PENDING_TTL_MS, allowStep);
  // Expiry only takes the card down: the stale proposal stays so that a late spoken "yes" is
  // answered "that expired" by the state machine instead of wandering off to the brain.
  expiryTimer = setTimeout(() => {
    card?.remove();
    card = null;
  }, PENDING_TTL_MS);
  showCard(prompt, allowStep, ctx, out);
  out.say(prompt, null);
}

// ---------------------------------------------------------------- one turn

/** Sends one utterance to Alef and speaks the reply as it streams. */
export async function askAlef(text: string, ctx: ClientContext, out: SpeechOut, hooks: AlefTurnHooks = {}): Promise<void> {
  abortAlefTurn();
  const ac = new AbortController();
  controller = ac;
  let ok = false;
  try {
    const res = await fetch("/api/voice/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, text }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`voice turn: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: VoiceTurnEvent;
        try {
          ev = JSON.parse(line) as VoiceTurnEvent;
        } catch {
          continue;
        }
        if (ev.type === "sentence") {
          hooks.onSentence?.(ev.text);
          out.say(ev.text, ev.audioUrl);
        } else if (ev.type === "action") propose(ev.action, ctx, out);
        else if (ev.type === "done") {
          ok = ev.ok;
          log.info("voice-brain", `turn ${ev.model}: first token ${ev.timings.firstTokenMs ?? "-"} ms, first audio ${ev.timings.firstAudioMs ?? "-"} ms, total ${ev.timings.totalMs} ms`);
        }
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      log.warn("voice-brain", "turn failed", err);
      const msg = "I can't reach my brain on the server just now.";
      hooks.onSentence?.(msg);
      out.say(msg, null);
    }
  } finally {
    if (controller === ac) controller = null;
    hooks.onDone?.(ok);
  }
}
