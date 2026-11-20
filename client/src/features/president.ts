// "Jev proposes" (round 10, item 3+4): fetches/receives the president's proposal board and the
// approved district-merge mapping, exposes the actions (Launch / Dismiss / Merge / Retire / Undo)
// the Inbox's section and the Settings row call, and keeps that Settings row's count live.
// Launch/Merge/Dismiss/Retire/Undo are POSTs that only ever run from a user's click here — nothing
// in this file calls them on its own. A launch sends no body fields: the server re-derives the
// folder and the task from its own stored candidate (a commencement one included).
//
// The board/merges are cached at module scope (same small cross-module-accessor pattern as
// sky-state.ts / completeness.ts's `currentMedianFps`) rather than pushed straight into Inbox's
// DOM: `onPresidentUpdate` delivers whatever is cached immediately on subscribe, so it doesn't
// matter which of this feature or `inbox.ts` happens to mount first in client/src/features/index.ts.

import { isDistrictMergeRecordArray, parsePresidentBoard, type DistrictMergeRecord, type PresidentActionResult, type PresidentBoard } from "../../../shared/features/president";
import { isRecord } from "./fleet-overlay";
import { launchToast } from "./loops-lib";
import { dismissToast, presidentLaunchKey, retireToast } from "./president-lib";
import { runLaunchOnce, trustRelaunchAction } from "../ui/launch-result";
import type { ClientContext, ClientFeature } from "./registry";
import "./president.css";

const EMPTY_BOARD: PresidentBoard = { generatedAt: new Date(0).toISOString(), proposals: [], source: "rules" };
const UNDO_ROW_ID = "hud-f-president-undo";

let cachedBoard: PresidentBoard = EMPTY_BOARD;
let cachedMerges: readonly DistrictMergeRecord[] = [];
const listeners: Array<() => void> = [];

export function currentPresidentBoard(): PresidentBoard {
  return cachedBoard;
}
export function currentDistrictMerges(): readonly DistrictMergeRecord[] {
  return cachedMerges;
}

/** Subscribes to every future board/merge update, and delivers the current cache once right
 *  away (there may already be one, from an onSnapshot/onMessage that fired before this call). */
export function onPresidentUpdate(fn: () => void): void {
  listeners.push(fn);
  fn();
}

function notify(): void {
  for (const fn of listeners) fn();
}

function paintUndoRow(): void {
  const row = document.getElementById(UNDO_ROW_ID);
  if (!row) return;
  const n = cachedMerges.length;
  row.dataset.label = n > 0 ? `Merged districts (${n}) · Undo` : "Merged districts (0)";
}

function fail(error: string): PresidentActionResult {
  return { ok: false, error };
}

/** Launch through runAction, one at a time per proposal (a double-click used to start two). `button`
 *  finds the row's Launch button as it is on screen now: the Inbox re-renders while it runs. */
export async function launchProposal(ctx: ClientContext, id: string, button?: () => HTMLButtonElement | null): Promise<void> {
  await runLaunchOnce<PresidentActionResult>(presidentLaunchKey(id), {
    label: "Launch",
    run: () => ctx.api.postJson<PresidentActionResult>(`/api/president/proposals/${encodeURIComponent(id)}/launch`, {}, fail),
    success: (r) => launchToast(r).text,
    successKind: (r) => launchToast(r).kind,
    failure: (r) => launchToast(r).text,
    action: (r) => trustRelaunchAction(ctx.api, ctx.toast, r),
    toast: ctx.toast,
    button,
  });
}

export async function dismissProposal(ctx: ClientContext, id: string): Promise<void> {
  const result = await ctx.api.postJson<PresidentActionResult>(`/api/president/proposals/${encodeURIComponent(id)}/dismiss`, {}, fail);
  const toast = dismissToast(result);
  ctx.toast(toast.text, toast.kind);
}

/** Retire (commencement): the careers feature's own display-only retire, run server-side for the
 *  worker the stored proposal names. The Inbox confirms before calling this. */
export async function retireProposal(ctx: ClientContext, id: string): Promise<void> {
  const result = await ctx.api.postJson<PresidentActionResult>(`/api/president/proposals/${encodeURIComponent(id)}/retire`, { confirm: true }, fail);
  const toast = retireToast(result);
  ctx.toast(toast.text, toast.kind);
}

export async function approveMerge(ctx: ClientContext, id: string): Promise<void> {
  const result = await ctx.api.postJson<PresidentActionResult>(`/api/president/proposals/${encodeURIComponent(id)}/merge`, {}, fail);
  ctx.toast(result.ok ? "Merged — those districts render as one city on the next reload." : (result.error ?? "Couldn't approve that merge"), result.ok ? "info" : "error");
}

async function undoMerge(ctx: ClientContext, id: string): Promise<void> {
  const result = await ctx.api.postJson<PresidentActionResult>(`/api/district-merges/${encodeURIComponent(id)}/undo`, {}, fail);
  ctx.toast(result.ok ? "Undone — that merge is back to separate districts." : (result.error ?? "Couldn't undo that merge"), result.ok ? "info" : "error");
}

export const presidentFeature: ClientFeature = {
  id: "president",
  onSnapshot(world) {
    const board = parsePresidentBoard(world.extras?.["president.board"]);
    if (board) cachedBoard = board;
    const merges = world.extras?.["president.merges"];
    if (isDistrictMergeRecordArray(merges)) cachedMerges = merges;
    notify();
    paintUndoRow();
  },
  onMessage(msg) {
    const payload = msg.payload;
    if (!isRecord(payload)) return;
    const board = payload.kind === "board" ? parsePresidentBoard(payload.board) : null;
    if (board) {
      cachedBoard = board;
      notify();
    } else if (payload.kind === "merges" && isDistrictMergeRecordArray(payload.merges)) {
      cachedMerges = payload.merges;
      notify();
      paintUndoRow();
    }
  },
  hudButtons: [
    {
      id: "undo",
      label: "↺",
      title: "Districts Jev proposed merging that you approved — click to undo the most recently approved one",
      text: "Merged districts (0)",
      placement: "menu",
      onClick: (ctx: ClientContext) => {
        const mostRecent = [...cachedMerges].sort((a, b) => Date.parse(b.approvedAt) - Date.parse(a.approvedAt))[0];
        if (!mostRecent) {
          ctx.toast("No districts have been merged yet.");
          return;
        }
        void undoMerge(ctx, mostRecent.id);
      },
    },
  ],
};
