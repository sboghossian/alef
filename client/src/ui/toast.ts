// Short-lived messages at the top of the screen (features use it via ctx.toast). Up to three stack,
// newest on top, so a second result never wipes the first. Info stays 4 s, an error 10 s or more
// (ui/toast-lib.ts); hovering or focusing one pauses its timer, and a click (or its ✕) dismisses it.

import { toastLifetimeMs, type ToastKind } from "./toast-lib";

/** One button on a toast (e.g. "Trust agent-world & relaunch"): clicking it runs `run` and puts the toast away. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export type Toast = (text: string, kind?: ToastKind, action?: ToastAction) => void;

export const TOAST_MAX = 3;
export const TOAST_TEXT_MAX = 400;

/** The shown text: trimmed and capped (a raw error can be hundreds of KB). */
export function toastText(text: string): string {
  const t = String(text).trim();
  return t.length > TOAST_TEXT_MAX ? `${t.slice(0, TOAST_TEXT_MAX - 1)}…` : t;
}

export function mountToast(): Toast {
  const box = document.createElement("div");
  box.id = "toast";
  box.hidden = true;
  document.body.appendChild(box);

  const remove = (el: HTMLElement): void => {
    el.remove();
    if (!box.firstElementChild) box.hidden = true;
  };

  return (text, kind = "info", action) => {
    const shown = toastText(text);
    if (!shown) return;
    // The same message again (a repeated failure) replaces its older copy instead of stacking.
    for (const old of box.querySelectorAll<HTMLElement>(".toast-item")) {
      if (old.dataset.kind === kind && old.dataset.text === shown) old.remove();
    }
    const el = document.createElement("div");
    el.className = `toast-item ${kind}`;
    el.dataset.kind = kind;
    el.dataset.text = shown;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    const msg = document.createElement("span");
    msg.className = "toast-text";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-x";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "✕";
    close.addEventListener("click", () => remove(el));
    if (action) {
      const act = document.createElement("button");
      act.type = "button";
      act.className = "toast-act";
      act.textContent = action.label;
      act.addEventListener("click", () => {
        remove(el);
        action.run();
      });
      el.append(msg, act, close);
    } else {
      el.append(msg, close);
    }
    // An error toast stays up for 10 s or more; a click anywhere on it puts it away sooner.
    el.addEventListener("click", () => remove(el));

    let left = toastLifetimeMs(shown, kind);
    let startedAt = 0;
    let timer: number | undefined;
    const start = (): void => {
      startedAt = Date.now();
      timer = window.setTimeout(() => remove(el), left);
    };
    const pause = (): void => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      left = Math.max(1000, left - (Date.now() - startedAt));
    };
    const resume = (): void => {
      if (timer === undefined && !el.matches(":hover") && !el.contains(document.activeElement)) start();
    };
    el.addEventListener("mouseenter", pause);
    el.addEventListener("mouseleave", resume);
    el.addEventListener("focusin", pause);
    el.addEventListener("focusout", () => window.setTimeout(resume, 0));

    box.prepend(el);
    box.hidden = false;
    // The live region exists first and its text arrives a beat later: screen readers announce a
    // change inside a status/alert far more reliably than a new node that already holds its text.
    window.setTimeout(() => {
      msg.textContent = shown;
    }, 30);
    // Over the cap, the oldest older info goes first: an error outlives the chatter that followed it.
    while (box.children.length > TOAST_MAX) {
      const infos = [...box.querySelectorAll<HTMLElement>(".toast-item.info")].filter((x) => x !== el);
      (infos[infos.length - 1] ?? box.lastElementChild)?.remove();
    }
    start();
  };
}
