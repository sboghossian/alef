// 🎙️ Voice view: "talk to Alef". A big comic moon-face orb, live transcript bubbles, push-to-talk
// (hold Space), a tap mic, the "Hey Alef" wake word and barge-in (speak, or Esc, stops Alef).
// Every intent routes to a capability that already exists (inbox, daily report, Ask Jev +
// notes, focus, views, Claude FM, the prompt box, the approval queue). The routing and the
// spoken approval confirmation are pure (voice-intents.ts); the mic / VAD / TTS are reused
// from features/voice.ts. A typed box goes through the same routing (headless has no mic).

import "./voice.css";
import { agentTitle, displayIslandName } from "../../../shared/display";
import type { AskJevResult, WorldAgent } from "../../../shared/types";
import type { ReplayResponse } from "../../../shared/features/replay";
import type { VadPreset } from "../../../shared/features/voice";
import { recall } from "../api";
import { decideApproval, onApprovalsChange, pendingApprovals } from "../features/approvals";
import { openAutomations } from "../features/automations";
import {
  askAlefAloud,
  cityIdByDisplayName,
  fillDispatchBar,
  getSpeakingVoice,
  isListening,
  isTranscribing,
  offerToPendingConfirm,
  onVoiceState,
  setSpeakingVoice,
  setUtteranceHandler,
  setVadPreset,
  setWakeWord,
  speak,
  startListening,
  stopListening,
  stopSpeaking,
  ttsEngineName,
  ttsReady,
  vadPreset,
  voiceFrame,
  voiceLevel,
  wakeWordEnabled,
} from "../features/voice";
import { log } from "../log";
import { relativeTime } from "../ui/fuzzy";
import { prefersReducedMotion } from "../ui/kit";
import type { AlefView, FilterSpec, FilterState, ViewContext } from "../shell/views";
import { mountOrb, type OrbHandle, type OrbState } from "./voice-orb";
import {
  helpAnswer,
  IDLE,
  inboxAnswer,
  parseIntent,
  resolveAgent,
  stepConfirm,
  SUGGESTIONS,
  todayAnswer,
  unknownAnswer,
  type ConfirmState,
  type VisibleApproval,
  type VoiceIntent,
} from "./voice-intents";

// ---------------------------------------------------------------- tiny DOM helper

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function localDate(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------- module state (one view instance)

let ctxRef: ViewContext | null = null;
let rootEl: HTMLElement | null = null;
let orb: OrbHandle | null = null;
let raf = 0;
let thinking = false;
let confirmState: ConfirmState = IDLE;
let debugState: OrbState | null = null;
let focusOn = false;
let cleanups: Array<() => void> = [];
let liveBubble: HTMLElement | null = null;
let pttHeld = false;
let pttRelease: ReturnType<typeof setTimeout> | null = null;

const STATUS_TEXT: Record<OrbState, string> = {
  idle: "Hold Space or tap the mic to talk",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking · Esc or talk to interrupt",
};

function currentOrbState(): OrbState {
  if (debugState) return debugState;
  if (isListening()) return "listening";
  if (thinking || isTranscribing()) return "thinking";
  return orb?.state() === "speaking" ? "speaking" : "idle";
}

function setStatus(): void {
  const s = currentOrbState();
  orb?.setState(s);
  const status = rootEl?.querySelector<HTMLElement>(".vv-status");
  if (status) {
    status.textContent = STATUS_TEXT[s];
    status.dataset.state = s;
  }
  rootEl?.querySelector(".vv-mic")?.classList.toggle("on", s === "listening");
  rootEl?.querySelector(".vv-stage")?.setAttribute("data-state", s);
}

// ---------------------------------------------------------------- transcript

function transcriptList(): HTMLElement | null {
  return rootEl?.querySelector<HTMLElement>(".vv-bubbles") ?? null;
}

function bubble(who: "you" | "alef", text: string): HTMLElement {
  const b = el("div", `vv-bubble vv-${who}`);
  b.append(el("span", "vv-who", who === "you" ? "You" : "Alef"), el("p", "vv-text", text));
  const list = transcriptList();
  list?.append(b);
  while (list && list.children.length > 40) list.firstElementChild?.remove();
  b.scrollIntoView({ block: "end", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  return b;
}

function onInterim(text: string): void {
  if (!text) return;
  if (!liveBubble || !liveBubble.isConnected) liveBubble = bubble("you", text);
  liveBubble.classList.add("vv-live");
  const p = liveBubble.querySelector(".vv-text");
  if (p) p.textContent = text;
}

/** Alef answers: a bubble (with optional extra content) + the voice. */
function answer(text: string, extra?: HTMLElement): void {
  const b = bubble("alef", text);
  if (extra) b.append(extra);
  const ctx = ctxRef;
  if (!ctx) return;
  thinking = false;
  orb?.setState("speaking");
  setStatus();
  void speak(text, ctx);
}

function rowButton(label: string, meta: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "vv-row");
  b.type = "button";
  b.append(el("span", "vv-row-title", label), el("span", "vv-row-meta", meta));
  b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------- the approval on screen

function visibleApproval(): VisibleApproval | null {
  if (focusOn) return null; // the card is hidden in focus mode, so nothing is "on screen"
  const a = pendingApprovals()[0];
  if (!a) return null;
  return { id: a.id, toolName: a.toolName, summary: a.preview.title || a.preview.body.split("\n")[0] || "" };
}

function renderApproval(): void {
  const host = rootEl?.querySelector<HTMLElement>(".vv-approval");
  if (!host) return;
  const a = pendingApprovals()[0];
  host.replaceChildren();
  host.hidden = !a;
  if (!a) return;
  const agent = ctxRef?.store.agents.get(a.agentId);
  host.append(
    el("div", "vv-ap-kicker", "✋ Waiting for your OK"),
    el("div", "vv-ap-tool", `${a.toolName}${agent ? ` · ${agentTitle(agent)}` : ""}`),
    el("pre", "vv-ap-body", (a.preview.title ? `${a.preview.title}\n` : "") + a.preview.body.split("\n").slice(0, 4).join("\n")),
    el("div", "vv-ap-how", confirmState.kind === "armed" ? `Say "confirm" to ${confirmState.behavior === "allow" ? "approve" : "deny"}, or "cancel".` : 'Say "approve" or "deny", then "confirm".'),
  );
  const more = pendingApprovals().length - 1;
  if (more > 0) host.append(el("div", "vv-ap-more", `+${more} more in the Feed`));
}

// ---------------------------------------------------------------- intents → real capabilities

function toggleClaudeFm(): boolean {
  const chip = document.getElementById("hud-f-claude-fm-chip");
  if (chip instanceof HTMLElement) {
    chip.click();
    return true;
  }
  // Same key the Claude FM feature listens for ("m"), dispatched on window.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
  return true;
}

function claudeFmPlaying(): boolean | null {
  const fm = (window as unknown as { __claudeFm?: { isPlaying(): boolean } }).__claudeFm;
  return fm ? fm.isPlaying() : null;
}

async function handleIntent(intent: VoiceIntent, ctx: ViewContext): Promise<void> {
  switch (intent.kind) {
    case "inbox": {
      const waiting = [...ctx.store.agents.values()]
        .filter((a) => a.awaitingInput === true)
        .sort((a, b) => Date.parse(a.lastActive) - Date.parse(b.lastActive));
      const list = el("div", "vv-rows");
      for (const a of waiting.slice(0, 6)) {
        list.append(rowButton(agentTitle(a), `${cityName(ctx, a.islandId)} · waiting ${relativeTime(a.lastActive).replace(" ago", "")}`, () => ctx.showView("room", a.id)));
      }
      answer(inboxAnswer(waiting.map((a) => ({ title: agentTitle(a), city: cityName(ctx, a.islandId) }))), waiting.length ? list : undefined);
      return;
    }
    case "today": {
      setThinking(true);
      const res = await ctx.api.getJson<ReplayResponse>(`/api/replay?date=${localDate()}`, 30_000);
      if (!res || !res.ok) {
        answer("I couldn't load today's report from the world server.");
        return;
      }
      answer(todayAnswer(res.report));
      return;
    }
    case "find": {
      setThinking(true);
      const [jev, notes] = await Promise.all([ctx.api.askJev({ question: intent.query }), recall(intent.query)]);
      const rows = el("div", "vv-rows");
      const matches = jev.ok ? jev.matches.slice(0, 3) : [];
      for (const m of matches) {
        const a = ctx.store.agents.get(m.agentId);
        rows.append(rowButton(a ? agentTitle(a) : m.agentId, `${a ? cityName(ctx, a.islandId) : "not in this world"} · ${Math.round(m.probability * 100)}%`, () => ctx.showView("room", m.agentId)));
      }
      const hits = notes.ok ? notes.hits.slice(0, 2) : [];
      for (const h of hits) rows.append(rowButton(`📝 ${h.title}`, h.path, () => ctx.showView("brain")));
      answer(findAnswer(ctx, jev, hits.map((h) => h.title)), rows.children.length ? rows : undefined);
      return;
    }
    case "focus": {
      const agents = [...ctx.store.agents.values()];
      const a = resolveAgent(intent.agentQuery, agents);
      if (!a) {
        answer(`I can't find an agent called "${intent.agentQuery}".`);
        return;
      }
      answer(`Focusing on ${agentTitle(a)}.`);
      ctx.showView("orbit");
      ctx.selection.set({ kind: "agent", id: a.id });
      ctx.flyTo(a.id);
      ctx.focus.set(true);
      return;
    }
    case "open-view":
      if (intent.viewId === "voice") {
        answer("You're already here.");
        return;
      }
      answer(`Opening ${intent.viewId}.`);
      ctx.showView(intent.viewId);
      return;
    case "automations":
      answer("Here are your automations.");
      openAutomations();
      return;
    case "dispatch": {
      if (ctx.focus.isOn()) ctx.focus.set(false);
      const cities = cityIdByDisplayName(ctx);
      fillDispatchBar(intent.prompt, intent.city, cities, ctx);
      answer(`I filled the prompt box${intent.city ? ` for ${intent.city}` : ""}. Check it and press Enter to send.`);
      return;
    }
    case "music": {
      const was = claudeFmPlaying();
      toggleClaudeFm();
      answer(was === true ? "Pausing Claude FM." : "Playing Claude FM.");
      return;
    }
    case "stop":
      stopSpeaking(ctx);
      return;
    case "help":
      answer(helpAnswer());
      return;
    case "cancel":
      answer("Okay.");
      return;
    case "unknown":
      if (!intent.text) return;
      askBrain(intent.text, ctx);
      return;
    case "approve":
    case "deny":
    case "confirm":
      return; // handled by the confirmation machine before we get here
  }
}

function cityName(ctx: ViewContext, islandId: string): string {
  const i = ctx.store.islands.get(islandId);
  return i ? displayIslandName(i) : islandId;
}

function findAnswer(ctx: ViewContext, jev: AskJevResult, notes: string[]): string {
  const parts: string[] = [];
  const top = jev.ok ? jev.matches[0] : undefined;
  if (top) {
    const a: WorldAgent | undefined = ctx.store.agents.get(top.agentId);
    const sure = jev.source === "jev" ? `, ${Math.round(top.probability * 100)}% sure` : ", by keyword";
    parts.push(`Best match: ${a ? agentTitle(a) : top.agentId}${a ? ` in ${cityName(ctx, a.islandId)}` : ""}${sure}.`);
  } else if (!jev.ok) {
    parts.push(`Ask Jev couldn't answer${jev.error ? `: ${jev.error}` : ""}.`);
  } else parts.push("No session fits that.");
  if (notes[0]) parts.push(`From your notes: ${notes[0]}.`);
  return parts.join(" ");
}

/** Anything that isn't a quick local command: Alef's brain answers, spoken sentence by sentence
 *  (voice-brain.ts), growing one bubble. Its proposed actions run at once or after a yes. */
function askBrain(text: string, ctx: ViewContext): void {
  setThinking(true);
  let b: HTMLElement | null = null;
  void askAlefAloud(text, ctx, {
    onSentence(s) {
      if (!rootEl) return;
      if (!b || !b.isConnected) b = bubble("alef", s);
      else {
        const p = b.querySelector(".vv-text");
        if (p) p.textContent = `${p.textContent ?? ""} ${s}`.trim();
      }
      thinking = false;
      setStatus();
    },
    onDone(ok) {
      if (!rootEl) return;
      setThinking(false);
      if (!b && !ok) bubble("alef", unknownAnswer()).append(suggestionChips());
    },
  });
}

function setThinking(on: boolean): void {
  thinking = on;
  setStatus();
}

/** One utterance, spoken or typed. */
function route(text: string): void {
  const ctx = ctxRef;
  if (!ctx) return;
  const said = text.trim();
  if (!said) return;
  if (liveBubble?.isConnected) {
    liveBubble.classList.remove("vv-live");
    const p = liveBubble.querySelector(".vv-text");
    if (p) p.textContent = said;
  } else bubble("you", said);
  liveBubble = null;
  if (offerToPendingConfirm(said, ctx)) return; // "yes"/"no" to Alef's "Shall I…?" (spoken or typed)
  stopSpeaking(ctx); // a new utterance always interrupts Alef
  const intent = parseIntent(said, [...cityIdByDisplayName(ctx).keys()]);
  const step = stepConfirm(confirmState, intent, Date.now(), visibleApproval());
  confirmState = step.state;
  renderApproval();
  if (step.handled) {
    const eff = step.effect;
    if (eff.kind === "say") answer(eff.text);
    else if (eff.kind === "decide") {
      void decideApproval(ctx, eff.approvalId, eff.behavior).then(() => renderApproval());
      answer(eff.text);
    }
    return;
  }
  void handleIntent(intent, ctx).catch((err: unknown) => {
    log.warn("voice-view", "intent failed", err);
    answer("Something went wrong doing that.");
  });
}

function suggestionChips(): HTMLElement {
  const wrap = el("div", "vv-suggest");
  for (const s of SUGGESTIONS) {
    const b = el("button", "vv-chip", s);
    b.type = "button";
    b.addEventListener("click", () => route(s));
    wrap.append(b);
  }
  return wrap;
}

// ---------------------------------------------------------------- keys + loop

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKeyDown(ev: KeyboardEvent): void {
  const ctx = ctxRef;
  if (!ctx || ev.code !== "Space" || ev.repeat || isTyping(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  ev.preventDefault();
  pttHeld = true;
  if (pttRelease) clearTimeout(pttRelease);
  stopSpeaking(ctx);
  if (!isListening()) void startListening(ctx);
}

function onKeyUp(ev: KeyboardEvent): void {
  const ctx = ctxRef;
  if (!ctx || ev.code !== "Space" || !pttHeld) return;
  ev.preventDefault();
  pttHeld = false;
  // A short tail so the recognizer delivers the last words before we finalize.
  pttRelease = setTimeout(() => {
    if (isListening()) stopListening(ctx);
  }, 450);
}

function loop(): void {
  const ctx = ctxRef;
  if (!ctx || !orb) return;
  const now = performance.now();
  if (!debugState) {
    voiceFrame(ctx, now);
    orb.setLevel(voiceLevel(now));
  }
  orb.frame();
  raf = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- filters

function voiceOptions(): Array<{ value: string; label: string; hint?: string }> {
  const opts: Array<{ value: string; label: string; hint?: string }> = [
    { value: "auto", label: ttsReady() ? `Auto (${ttsEngineName() === "elevenlabs" ? "ElevenLabs" : "Piper, local"})` : "Auto (browser)", hint: "Piper on this Mac (British male voice), else ElevenLabs if a key is set, else the browser voice" },
    { value: "browser", label: "Browser default" },
  ];
  const voices = typeof window.speechSynthesis === "undefined" ? [] : window.speechSynthesis.getVoices();
  for (const v of voices.filter((x) => /^en/i.test(x.lang)).slice(0, 10)) {
    opts.push({ value: `browser:${v.name}`, label: v.name, hint: v.lang });
  }
  return opts;
}

// ---------------------------------------------------------------- the view

function build(root: HTMLElement): void {
  const stage = el("section", "vv-stage");
  stage.setAttribute("aria-label", "Talk to Alef");
  const canvas = el("canvas", "vv-orb");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Alef's face");
  const status = el("div", "vv-status");
  status.setAttribute("aria-live", "polite");
  const controls = el("div", "vv-controls");
  const mic = el("button", "comic-btn vv-mic", "🎤 Talk");
  mic.type = "button";
  mic.title = "Tap to start/stop, or hold Space";
  const hush = el("button", "comic-btn secondary vv-hush", "✋ Stop");
  hush.type = "button";
  hush.title = "Stop Alef talking (Esc)";
  controls.append(mic, hush);
  const wake = el("div", "vv-wake");
  stage.append(canvas, status, controls, wake);

  const transcript = el("section", "vv-transcript");
  transcript.setAttribute("aria-label", "Transcript");
  const head = el("header", "vv-thead");
  head.append(el("h3", undefined, "Transcript"));
  const bubbles = el("div", "vv-bubbles");
  bubbles.setAttribute("aria-live", "polite");
  transcript.append(head, bubbles);

  const approval = el("section", "vv-approval");
  approval.hidden = true;
  approval.setAttribute("aria-live", "assertive");

  const form = el("form", "vv-type");
  const input = el("input");
  input.type = "text";
  input.maxLength = 500;
  input.autocomplete = "off";
  input.placeholder = "Type to Alef… (same as speaking)";
  input.setAttribute("aria-label", "Type to Alef");
  const send = el("button", "comic-btn small", "Say it");
  send.type = "submit";
  form.append(input, send);
  const suggest = suggestionChips();
  suggest.classList.add("vv-suggest-bar");

  root.append(stage, approval, transcript, form, suggest);

  mic.addEventListener("click", () => {
    const ctx = ctxRef;
    if (!ctx) return;
    if (isListening()) stopListening(ctx);
    else {
      stopSpeaking(ctx);
      void startListening(ctx);
    }
  });
  hush.addEventListener("click", () => ctxRef && stopSpeaking(ctxRef));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = input.value;
    input.value = "";
    route(v);
  });
}

function renderWakeHint(): void {
  const w = rootEl?.querySelector<HTMLElement>(".vv-wake");
  if (w) w.textContent = wakeWordEnabled() ? 'Wake word on: say "Hey Alef"' : "Wake word off (turn it on in the left sidebar)";
}

export const voiceView: AlefView = {
  id: "voice",
  emoji: "🎙️",
  name: "Voice",
  hint: "Talk to Alef: hold Space, tap the mic, or say “Hey Alef”",
  keys: ["7"],
  usesPlanet: false,
  mount(root, ctx) {
    ctxRef = ctx;
    rootEl = root;
    confirmState = IDLE;
    thinking = false;
    focusOn = ctx.focus.isOn();
    root.classList.add("vv-root");
    build(root);
    const canvas = root.querySelector<HTMLCanvasElement>(".vv-orb");
    if (canvas) orb = mountOrb(canvas, prefersReducedMotion());

    const q = new URLSearchParams(window.location.search).get("voice");
    debugState = q === "idle" || q === "listening" || q === "thinking" || q === "speaking" ? q : null;
    if (debugState && orb) {
      orb.setState(debugState);
      orb.setLevel(debugState === "listening" || debugState === "speaking" ? 0.65 : 0);
    }

    setUtteranceHandler((text) => route(text), onInterim);
    cleanups.push(
      onVoiceState((s) => {
        if (s === "speaking") orb?.setState("speaking");
        else if (orb?.state() === "speaking" && s === "idle") orb.setState("idle");
        if (s === "idle" && liveBubble && !isListening()) {
          // the mic stopped without a final utterance
          if (liveBubble.classList.contains("vv-live") && !liveBubble.querySelector(".vv-text")?.textContent) liveBubble.remove();
        }
        setStatus();
      }),
      onApprovalsChange(() => renderApproval()),
    );
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    cleanups.push(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    });
    const onVoices = (): void => ctx.refreshFilters();
    window.speechSynthesis?.addEventListener?.("voiceschanged", onVoices);
    cleanups.push(() => window.speechSynthesis?.removeEventListener?.("voiceschanged", onVoices));

    renderApproval();
    renderWakeHint();
    setStatus();
    bubble("alef", 'Hi, I\'m Alef. Ask me "who\'s waiting on me?" or "what happened today?"');
    raf = requestAnimationFrame(loop);
  },
  unmount() {
    cancelAnimationFrame(raf);
    if (pttRelease) clearTimeout(pttRelease);
    const ctx = ctxRef;
    if (ctx) {
      if (isListening()) stopListening(ctx);
      stopSpeaking(ctx, true); // leaving the view (a plan's open_view step does this) keeps the plan going
    }
    setUtteranceHandler(null);
    for (const fn of cleanups) fn();
    cleanups = [];
    orb?.destroy();
    orb = null;
    rootEl?.classList.remove("vv-root", "vv-focus");
    rootEl = null;
    ctxRef = null;
    liveBubble = null;
    confirmState = IDLE;
  },
  filters(): FilterSpec[] {
    return [
      {
        id: "preset",
        label: "Pause before I answer",
        type: "segmented",
        options: [
          { value: "snappy", label: "Snappy", hint: "0.8 s of silence ends your turn" },
          { value: "normal", label: "Normal", hint: "1.5 s" },
          { value: "patient", label: "Patient", hint: "2.5 s" },
        ],
        default: [vadPreset()],
      },
      { id: "wake", label: "Wake word “Hey Alef”", type: "toggle", default: wakeWordEnabled() ? ["on"] : [] },
      { id: "speaker", label: "Speaking voice", type: "list", options: voiceOptions(), default: [getSpeakingVoice()], collapsed: true },
    ];
  },
  onFilter(state: FilterState) {
    const ctx = ctxRef;
    const p = state.preset?.[0];
    if (p === "snappy" || p === "normal" || p === "patient") setVadPreset(p satisfies VadPreset);
    if (ctx) setWakeWord((state.wake ?? []).includes("on"), ctx);
    const sp = state.speaker?.[0];
    setSpeakingVoice(sp ?? "auto");
    renderWakeHint();
  },
  onFocus(on) {
    focusOn = on;
    rootEl?.classList.toggle("vv-focus", on);
    if (on && confirmState.kind === "armed") confirmState = IDLE; // the card is hidden: disarm
    renderApproval();
  },
  onEscape() {
    const ctx = ctxRef;
    if (!ctx) return false;
    if (orb?.state() === "speaking" || currentOrbState() === "speaking") {
      stopSpeaking(ctx);
      setStatus();
      return true;
    }
    if (isListening()) {
      stopListening(ctx);
      return true;
    }
    if (confirmState.kind === "armed") {
      confirmState = IDLE;
      renderApproval();
      answer("Cancelled. Nothing was sent.");
      return true;
    }
    return false;
  },
};
