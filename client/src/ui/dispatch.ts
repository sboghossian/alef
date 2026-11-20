import type { DispatchResult, Island } from "../../../shared/types";
import { dispatch, postJson } from "../api";
import { log } from "../log";
import { runAction } from "./action";
import { expandSurface } from "./kit";
import { launchNeedsYou, launchSuccessText, trustRelaunchAction } from "./launch-result";
import type { Toast } from "./toast";

// Minimal Web Speech API surface (not in lib.dom for webkit-prefixed Chrome/Safari).
// Exported so other voice-driven UI (client/src/features/voice.ts: continuous
// wake-word listening) shares this shim instead of redeclaring it.
export interface SpeechAlternative {
  transcript: string;
}
export interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternative | undefined;
}
export interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechResult | undefined };
}
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
export type SpeechCtor = new () => SpeechRecognitionLike;

export function speechCtor(win: unknown): SpeechCtor | null {
  const w = win as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface DispatchBar {
  /** Preselect a city (e.g. the selected one). */
  setCity(islandId: string): void;
  prefill(text: string, islandId?: string): void;
  focus(): void;
}

/** Drag payload used by the Routines tab and the Automations modal (round 11, package D):
 *  a routine/automation row is draggable, and dropping it on the prompt box fills the box with
 *  its real workflow prompt and selects its city. The MIME type is our own so a stray OS file/
 *  text drop never accidentally fills the box. */
export const WORKFLOW_DRAG_MIME = "application/x-alef-workflow";

export interface WorkflowDrop {
  /** The ready-to-send prompt text (a real skill command or a plain "Run X: …" line). */
  prompt: string;
  /** City to preselect, when one is known; left as-is otherwise. */
  cityId?: string | null;
  /** Told when THIS prompt is dispatched (a Fix queue row records the session it started). Dropped
   *  by the next fill, or once the box is emptied, so it never fires for some other prompt. */
  onDispatched?: (res: DispatchResult) => void;
}

/** The latest fill's onDispatched, until it fires or the box moves on to something else. */
let pendingDispatched: ((res: DispatchResult) => void) | null = null;

/** Fills the prompt box exactly like a drag-drop would — used by the drop handler below and by
 *  the "→ prompt" button every draggable row also gets, for keyboard/non-drag users. Nothing is
 *  sent: the user still presses Dispatch. Safe to call even if the bar hasn't mounted yet (a
 *  no-op) since both callers query the DOM directly, matching voice.ts's fillDispatchBar. */
export function fillDispatchBox(drop: WorkflowDrop): void {
  const text = document.getElementById("dispatch-text");
  const city = document.getElementById("dispatch-city");
  if (!(text instanceof HTMLTextAreaElement)) return;
  expandSurface("dispatch");
  pendingDispatched = drop.onDispatched ?? null;
  text.value = drop.prompt;
  text.dispatchEvent(new Event("input", { bubbles: true })); // dispatch.ts's own autosize listener
  if (drop.cityId && city instanceof HTMLSelectElement && [...city.options].some((o) => o.value === drop.cityId)) {
    city.value = drop.cityId;
  }
  text.focus();
}

function parseWorkflowDrop(raw: string): WorkflowDrop | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.prompt !== "string" || !o.prompt.trim()) return null;
    return { prompt: o.prompt, cityId: typeof o.cityId === "string" ? o.cityId : null };
  } catch {
    return null;
  }
}

export interface DispatchDeps {
  islands: Island[];
  /** Default city: the most recently active non-harness island. */
  defaultCity: string;
  onDispatched(res: DispatchResult): void;
  /** Also toast the outcome (the status line under the bar is easy to miss). */
  toast?: Toast;
}

/** What a dispatch really did, from the server's answer: a world tmux session (or a plain Terminal
 *  when tmux is missing), and whether claude is waiting on its trust dialog. */
export function dispatchedText(cityName: string, r: DispatchResult): string {
  return launchSuccessText(r, `Dispatched to ${cityName}`);
}

/** Bottom-centre comic prompt bar: city picker, voice, Enter to dispatch. Collapses to a pill (kit `collapsible`, main.ts), closed by default on phones. */
export function mountDispatchBar(deps: DispatchDeps): DispatchBar {
  const root = document.getElementById("dispatch");
  const form = document.getElementById("dispatch-form");
  const text = document.getElementById("dispatch-text");
  const city = document.getElementById("dispatch-city");
  const voice = document.getElementById("dispatch-voice");
  const status = document.getElementById("dispatch-status");
  const send = document.getElementById("dispatch-send");
  if (
    !root ||
    !(form instanceof HTMLFormElement) ||
    !(text instanceof HTMLTextAreaElement) ||
    !(city instanceof HTMLSelectElement) ||
    !(voice instanceof HTMLButtonElement) ||
    !status ||
    !(send instanceof HTMLButtonElement)
  ) {
    throw new Error("dispatch bar DOM missing from index.html");
  }
  // Re-bind after narrowing so the hoisted functions below keep the precise element types.
  const rootEl: HTMLElement = root;
  const textEl: HTMLTextAreaElement = text;
  const cityEl: HTMLSelectElement = city;
  const sendEl: HTMLButtonElement = send;
  const statusEl: HTMLElement = status;

  const cities = deps.islands
    .filter((i) => i.id !== "harness")
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  city.innerHTML = cities
    .map((i) => `<option value="${i.id.replace(/"/g, "&quot;")}">${(i.name === "/" ? "root" : i.name).replace(/</g, "&lt;")}</option>`)
    .join("");
  city.value = deps.defaultCity;

  const setStatus = (msg: string, kind: "error" | "ok" | "" = ""): void => {
    status.textContent = msg;
    status.className = kind;
  };

  let busy = false;
  async function submit(): Promise<void> {
    if (busy) return;
    busy = true;
    const cityName = cityEl.options[cityEl.selectedIndex]?.text ?? cityEl.value;
    const toast: Toast = deps.toast ?? (() => {});
    const res = await runAction({
      label: "Dispatch",
      pending: "Starting it in tmux…",
      run: () => dispatch({ islandId: cityEl.value, prompt: textEl.value }),
      success: (r) => dispatchedText(cityName, r),
      successKind: (r) => (launchNeedsYou(r) ? "error" : "info"),
      action: (r) => trustRelaunchAction({ postJson }, toast, r),
      toast,
      status: statusEl,
      button: sendEl,
    });
    busy = false;
    statusEl.className = res.ok ? "ok" : "error";
    if (res.ok) {
      textEl.value = "";
      autosize();
      deps.onDispatched(res);
      const hook = pendingDispatched;
      pendingDispatched = null;
      hook?.(res);
    }
  }

  // Grow from one line up to ~5 as you type.
  const autosize = (): void => {
    textEl.style.height = "auto";
    textEl.style.height = `${Math.min(textEl.scrollHeight, 110)}px`;
  };
  text.addEventListener("input", () => {
    autosize();
    if (!textEl.value.trim()) pendingDispatched = null; // emptied: whatever was drafted is gone
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void submit();
  });

  // ---- drop target: a dragged routine/automation row fills the box (round 11, package D) ----
  rootEl.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer?.types.includes(WORKFLOW_DRAG_MIME)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    rootEl.classList.add("dispatch-dropping");
  });
  rootEl.addEventListener("dragleave", (ev) => {
    if (ev.target === rootEl) rootEl.classList.remove("dispatch-dropping");
  });
  rootEl.addEventListener("drop", (ev) => {
    const raw = ev.dataTransfer?.getData(WORKFLOW_DRAG_MIME);
    if (!raw) return;
    ev.preventDefault();
    rootEl.classList.remove("dispatch-dropping");
    const drop = parseWorkflowDrop(raw);
    if (drop) fillDispatchBox(drop);
  });
  text.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void submit();
    }
  });

  // ---- voice (Web Speech API); hidden when unsupported ----
  const Ctor = speechCtor(window);
  if (!Ctor) {
    voice.hidden = true;
  } else {
    let rec: SpeechRecognitionLike | null = null;
    let base = "";
    voice.addEventListener("click", () => {
      if (rec) {
        rec.stop();
        return;
      }
      try {
        rec = new Ctor();
      } catch (err) {
        log.warn("dispatch", "speech recognition unavailable", err);
        voice.hidden = true;
        return;
      }
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      base = text.value ? `${text.value.trimEnd()} ` : "";
      voice.classList.add("listening");
      setStatus("Listening…");
      rec.onresult = (ev) => {
        let said = "";
        for (let i = 0; i < ev.results.length; i++) said += ev.results[i]?.[0]?.transcript ?? "";
        text.value = base + said;
        autosize();
      };
      rec.onerror = (ev) => setStatus(`Voice: ${ev.error}`, "error");
      rec.onend = () => {
        voice.classList.remove("listening");
        if (status.textContent === "Listening…") setStatus("");
        rec = null;
      };
      rec.start();
    });
  }

  return {
    setCity(islandId) {
      if (cities.some((c) => c.id === islandId)) city.value = islandId;
    },
    prefill(value, islandId) {
      expandSurface("dispatch");
      text.value = value;
      autosize();
      if (islandId && cities.some((c) => c.id === islandId)) city.value = islandId;
      text.focus();
    },
    focus() {
      expandSurface("dispatch");
      text.focus();
    },
  };
}
