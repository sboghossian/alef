// Reactivate / Open in VS Code, from the palette, the details panel and the Room's dock. One request
// per agent and kind at a time, shared by all three (the map is module state), and every click gets
// an answer: a live agent is refused, a click while one is running says it is still running, and the
// outcome is always toasted. openPending and openOutcome let a view that re-renders (the details
// panel does on every live update) draw its button busy, and its status line, again.

import { agentTitle } from "../../../shared/display";
import type { ReactivateResult, WorldAgent } from "../../../shared/types";
import { runAction, type ElementRef } from "./action";
import { launchNeedsYou, launchSuccessText } from "./launch-result";
import type { Toast } from "./toast";

export type OpenKind = "reactivate" | "editor";

export interface OpenDeps {
  agent(id: string): WorldAgent | undefined;
  reactivate(id: string): Promise<ReactivateResult>;
  openEditor(id: string): Promise<ReactivateResult>;
  toast: Toast;
}

/** Getters are read again when the request settles (see runAction). */
export interface OpenUi {
  status?: ElementRef<HTMLElement>;
  button?: ElementRef<HTMLButtonElement>;
}

export const ALREADY_RUNNING = "Already running. Reactivating would start a second copy.";

/** How long a finished request's outcome line survives re-renders (the toast says it too). */
export const OUTCOME_MS = 30_000;

const inFlight = new Map<string, string>();
const outcomes = new Map<string, { text: string; error: boolean; at: number }>(); // agent id → last outcome
const key = (kind: OpenKind, id: string): string => `${kind}:${id}`;

/** The pending text of a request still running for this agent, or null. */
export function openPending(kind: OpenKind, id: string): string | null {
  return inFlight.get(key(kind, id)) ?? null;
}

/** The outcome line of this agent's last finished request, for OUTCOME_MS, or null. */
export function openOutcome(id: string, now = Date.now()): { text: string; error: boolean } | null {
  const o = outcomes.get(id);
  if (!o || now - o.at > OUTCOME_MS) return null;
  return { text: o.text, error: o.error };
}

/** Null when nothing was sent (a live agent, or one already opening); else the server's answer.
 *  `note` is a sentence added to the success line (the Room's no-tmux Activate adds the trust hint). */
export async function openAgentIn(deps: OpenDeps, kind: OpenKind, id: string, ui: OpenUi = {}, note?: string): Promise<ReactivateResult | null> {
  const agent = deps.agent(id);
  const title = agent ? agentTitle(agent) : id.slice(0, 8);
  const app = kind === "reactivate" ? "Terminal" : "VS Code";
  if (kind === "reactivate" && agent?.status === "live") {
    deps.toast(ALREADY_RUNNING);
    const status = typeof ui.status === "function" ? ui.status() : ui.status;
    if (status) status.textContent = "Already running.";
    return null;
  }
  const k = key(kind, id);
  if (inFlight.has(k)) {
    deps.toast(`Still opening ${app} for ${title}…`);
    return null;
  }
  const pending = `Opening ${app}…`;
  inFlight.set(k, pending);
  const folder = agent?.cwd.split("/").filter(Boolean).pop() ?? "the project";
  try {
    return await runAction({
      label: kind === "reactivate" ? "Reactivate" : "Open in VS Code",
      pending,
      run: () => (kind === "reactivate" ? deps.reactivate(id) : deps.openEditor(id)),
      success: (r) => {
        const done = kind === "reactivate" ? launchSuccessText(r, `Resumed ${title}`, false) : `Opened ${folder} in VS Code.`;
        return note && r.mode !== "tmux" ? `${done} ${note}` : done;
      },
      successKind: (r) => (kind === "reactivate" && launchNeedsYou(r) ? "error" : "info"),
      toast: deps.toast,
      status: ui.status,
      button: ui.button,
      onOutcome: (text, error) => void outcomes.set(id, { text, error, at: Date.now() }),
    });
  } finally {
    inFlight.delete(k);
  }
}
