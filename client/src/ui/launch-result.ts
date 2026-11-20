// What a launch or resume did, said the same way everywhere (the dispatch bar, Health's Launch,
// Reactivate, Resume here, ▶ Launch, Jev proposes): where claude runs now (a world tmux session
// Stop/Talk/Screen reach, or a plain Terminal when tmux is missing), and what still needs you
// (claude's trust or Chrome dialog, a Terminal that didn't open). A launch waiting on the trust
// dialog gets a "Trust <folder> & relaunch" button on its toast; the Inbox's stranded row has the
// same one. Pure text helpers plus one runAction wrapper.

import type { TalkActionResult } from "../../../shared/features/talk";
import type { LaunchDetails } from "../../../shared/types";
import { runAction, type ElementRef, type RunActionOptions } from "./action";
import type { Toast, ToastAction } from "./toast";

export interface LaunchResultLike extends LaunchDetails {
  ok: boolean;
  error?: string | null;
  cwd?: string;
}

/** The last path segment of a folder, for a sentence. */
export function folderName(cwd: string | undefined | null): string {
  return cwd?.split("/").filter(Boolean).pop() ?? "this folder";
}

function sentence(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const cap = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

/** One line for a successful launch/resume. `lead` names what happened ("Dispatched to agent-world",
 *  "Resumed fix login"); the rest comes from the server's answer, never assumed. `relaunchable`: a
 *  new launch (not a resume) can be trusted and relaunched from its toast or the Inbox. */
export function launchSuccessText(r: LaunchResultLike, lead: string, relaunchable = true): string {
  const parts: string[] = [];
  if (r.reused) parts.push(`Already started${r.tmuxName ? ` as ${r.tmuxName}` : ""}, so nothing new was launched.`);
  else if (r.attached) parts.push(`Already in tmux ${r.tmuxName ?? ""}: Terminal attached, nothing new started.`);
  else if (r.mode === "terminal") parts.push(`${lead} in a plain Terminal window.`);
  else if (r.mode === "tmux") parts.push(`${lead} in tmux ${r.tmuxName ?? "(a world session)"}: Stop, Talk and the Screen reach it.`);
  else parts.push(`${lead}.`); // an answer that doesn't say where it runs: claim nothing
  if (r.waitingOn === "trust") {
    parts.push(
      relaunchable
        ? `Claude is waiting on its trust dialog for ${folderName(r.cwd)}: nothing runs until you trust the folder (button here or in the Inbox) or answer it in Terminal.`
        : `Claude is waiting on its trust dialog for ${folderName(r.cwd)}: answer it in Terminal (Yes, I trust this folder); nothing runs until then.`,
    );
  } else if (r.waitingOn === "chrome") parts.push("Claude is waiting on its Chrome dialog: answer it in Terminal.");
  if (r.warning) parts.push(sentence(r.warning));
  return parts.join(" ");
}

/** True when the person still has to do something, so the toast should stay up (an error toast). */
export function launchNeedsYou(r: LaunchResultLike): boolean {
  return r.ok && (r.waitingOn !== undefined || (r.warning !== undefined && r.mode !== "terminal"));
}

export interface TrustRelaunchApi {
  postJson<T>(url: string, body: unknown, fallback: (error: string) => T, timeoutMs?: number): Promise<T>;
}

/** The trust-relaunch round trip takes a grant, a Close and a relaunch with its dialog watch. */
const TRUST_RELAUNCH_TIMEOUT_MS = 45_000;

/** "Trust <folder> & relaunch" for a launch stuck on claude's trust dialog: the server grants trust
 *  (one key of ~/.claude.json), Closes the stuck session under Close's own checks, and starts the
 *  same prompt again. Through runAction, so its button is busy while it runs. */
export function trustAndRelaunch(api: TrustRelaunchApi, toast: Toast, tmuxName: string, cwd: string, button?: ElementRef<HTMLButtonElement>): Promise<TalkActionResult> {
  const folder = folderName(cwd);
  return runAction({
    label: `Trust ${folder} & relaunch`,
    pending: `Trusting ${folder}…`,
    run: () => api.postJson<TalkActionResult>(`/api/talk/stranded/${encodeURIComponent(tmuxName)}/trust-relaunch`, undefined, (error) => ({ ok: false, error }), TRUST_RELAUNCH_TIMEOUT_MS),
    success: (r) => `Trusted ${folder} and closed ${r.relaunchedFrom ?? tmuxName}. ${launchSuccessText(r, "Relaunched its prompt")}`,
    failure: (r) => r.error ?? `Trust ${folder} & relaunch failed.`,
    toast,
    button,
  });
}

/** The toast button a launch waiting on the trust dialog gets, or undefined. */
export function trustRelaunchAction(api: TrustRelaunchApi, toast: Toast, r: LaunchResultLike): ToastAction | undefined {
  if (!r.ok || r.waitingOn !== "trust" || !r.tmuxName || !r.cwd) return undefined;
  const tmuxName = r.tmuxName;
  const cwd = r.cwd;
  return { label: `Trust ${folderName(cwd)} & relaunch`, run: () => void trustAndRelaunch(api, toast, tmuxName, cwd) };
}

const launching = new Set<string>();

/** True while a launch keyed `key` (e.g. "loops:<id>", "president:<id>") is in flight, so a pane
 *  that re-renders mid-request can draw its button busy again. */
export function launchInFlight(key: string): boolean {
  return launching.has(key);
}

/** One launch per key at a time, through runAction (its button is busy while it runs). A second
 *  click on the same launch, even on a re-rendered button, only says it is still starting; the
 *  server's own repeat guard (launch-once.ts) catches anything that slips past. Null when not sent. */
export async function runLaunchOnce<T extends LaunchResultLike>(key: string, o: RunActionOptions<T>): Promise<T | null> {
  if (launching.has(key)) {
    o.toast("Still starting that one…");
    return null;
  }
  launching.add(key);
  try {
    return await runAction(o);
  } finally {
    launching.delete(key);
  }
}
