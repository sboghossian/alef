// How long a toast stays up (ui/toast.ts). An info line is a glance: 4 s. An error is often
// something to act on in another window (answer Claude's trust question in Terminal, allow
// osascript), so it stays long enough to read: 10 s at least, longer for long text, 30 s at most.
// Hovering pauses either; a click dismisses it.

export type ToastKind = "info" | "error";

export const INFO_TOAST_MS = 4000;
export const ERROR_TOAST_MIN_MS = 10_000;
const ERROR_TOAST_MAX_MS = 30_000;
/** ~14 characters a second: a slow read of a line you then have to act on. */
const ERROR_TOAST_MS_PER_CHAR = 70;

export function toastLifetimeMs(text: string, kind: ToastKind): number {
  if (kind !== "error") return INFO_TOAST_MS;
  return Math.min(ERROR_TOAST_MAX_MS, Math.max(ERROR_TOAST_MIN_MS, text.length * ERROR_TOAST_MS_PER_CHAR));
}
