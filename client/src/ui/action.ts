// Every user action says what happened. runAction wraps one request: it disables its button while
// the request runs (a double click can't fire twice), writes progress to an optional status line,
// then toasts the outcome: the caller's success sentence, or the server's reason for a failure,
// translated when that reason is cryptic (describeError). It never throws.
// The status line and the button may be getters, read again when the request settles: a view that
// re-renders mid-request (the details panel does on every live update) then gets the outcome in the
// node on screen, not in the one its re-render detached.

import { log } from "../log";
import type { Toast, ToastAction } from "./toast";
import type { ToastKind } from "./toast-lib";

export interface ActionResultLike {
  ok: boolean;
  error?: string | null;
}

const REASON_MAX = 240;

/** A failure reason a person can act on. Known cryptic ones get a translation; anything else is
 *  its first line without the "Error: " prefix, capped. */
export function describeError(error: unknown): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : error == null ? "" : String(error);
  if (raw.includes("-1743") || raw.includes("Not authorized to send Apple events")) {
    return "macOS blocked Alef from controlling that app: allow it in System Settings › Privacy & Security › Automation.";
  }
  if (raw.includes("spawn code ENOENT")) return "VS Code's code command isn't on the PATH.";
  if (raw.includes("world server unreachable")) return "Alef's server didn't answer (it may be restarting). Try again in a few seconds.";
  if (raw.trim() === "timed out") return "No answer in time. It may still be running: check the Logs tab.";
  const line = (raw.split(/\r?\n/, 1)[0] ?? "").trim().replace(/^Error:\s*/, "");
  if (!line) return "unknown error";
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

export interface RunActionOptions<T extends ActionResultLike> {
  /** Names the action in the failure toast: "<label> failed: <reason>". */
  label: string;
  run: () => Promise<T>;
  /** What happened, for the success toast (and the status line); null = no toast. */
  success: (r: T) => string | null;
  /** Replaces the default failure text when it returns a string. */
  failure?: (r: T) => string | null;
  /** The success toast's kind (default "info"): "error" keeps it up while something still needs you. */
  successKind?: (r: T) => ToastKind;
  /** A button on the success toast (e.g. "Trust <folder> & relaunch"). */
  action?: (r: T) => ToastAction | undefined;
  toast: Toast;
  /** Status-line text while the request runs (default "<label>…"). */
  pending?: string;
  status?: ElementRef<HTMLElement>;
  button?: ElementRef<HTMLButtonElement>;
  /** Told the outcome line (as written to the status line), e.g. so a re-render can draw it again. */
  onOutcome?: (text: string, error: boolean) => void;
}

/** An element, or a getter for the one on screen now (null = nowhere to show it). */
export type ElementRef<E extends HTMLElement> = E | null | undefined | (() => E | null);

function deref<E extends HTMLElement>(ref: ElementRef<E>): E | null {
  try {
    return typeof ref === "function" ? ref() : ref ?? null;
  } catch (err) {
    log.error("action", "finding the button or status line failed", err);
    return null;
  }
}

export async function runAction<T extends ActionResultLike>(o: RunActionOptions<T>): Promise<T> {
  const firstButton = deref(o.button);
  const firstStatus = deref(o.status);
  const wasDisabled = firstButton?.disabled ?? false;
  if (firstButton) {
    firstButton.disabled = true;
    firstButton.setAttribute("aria-busy", "true");
  }
  if (firstStatus) {
    firstStatus.textContent = o.pending ?? `${o.label}…`;
    firstStatus.classList?.remove("error");
  }
  let r: T;
  try {
    r = await o.run();
  } catch (err) {
    log.error("action", `${o.label} threw`, err);
    r = { ok: false, error: err instanceof Error ? err.message : String(err) } as T;
  }
  // Only a button still marked busy is ours to release: a re-rendered one that isn't (say, disabled
  // because the agent went live meanwhile) keeps the state its renderer gave it.
  const button = deref(o.button);
  if (button?.getAttribute("aria-busy") === "true") {
    button.disabled = wasDisabled;
    button.removeAttribute("aria-busy");
  }
  const status = deref(o.status);
  try {
    if (r.ok) {
      const text = o.success(r);
      if (status) status.textContent = text ?? "";
      if (text) o.onOutcome?.(text, false);
      if (text) {
        const kind = o.successKind?.(r);
        const action = o.action?.(r);
        if (action) o.toast(text, kind ?? "info", action);
        else if (kind === "error") o.toast(text, kind);
        else o.toast(text);
      }
    } else {
      const text = o.failure?.(r) ?? `${o.label} failed: ${describeError(r.error)}`;
      log.warn("action", text);
      if (status) {
        status.textContent = text;
        status.classList?.add("error");
      }
      o.onOutcome?.(text, true);
      o.toast(text, "error");
    }
  } catch (err) {
    log.error("action", `${o.label}: reporting the outcome failed`, err);
  }
  return r;
}
