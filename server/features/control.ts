// "control": stop or nudge a running agent from the world. Interrupt sends Claude's own
// interrupt key (Escape) — or C-c with ?hard=1 — into the agent's world tmux session via
// `tmux send-keys` (argv only). It never kills a process. Agents that are not tmux-bound
// (a plain Terminal session) get 409 "open its Terminal to stop it".
// The note endpoint reuses talk's delivery path, prompt-safety included.

import {
  CONTROL_NOT_TMUX_ERROR,
  type ControlResult,
} from "../../shared/features/control.js";
import { TALK_INSTALL_HINT, TALK_MAX_CHARS } from "../../shared/features/talk.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import type { ServerFeature } from "./registry.js";
import { boundTmuxSession, cleanTalkText, deliverTalkText, loadTalkBindings, realTalkExec, type TalkExec } from "./talk.js";

export function createControlFeature(exec: TalkExec = realTalkExec): ServerFeature {
  return {
    id: "control",
    routes: [
      {
        method: "POST",
        path: "/api/agents/:agentId/interrupt",
        async handler(req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return respondJson(res, 400, { ok: false, error: "invalid agent id" } satisfies ControlResult);
          const hard = new URL(req.url ?? "/", "http://localhost").searchParams.get("hard") === "1";
          const target = await boundTmuxSession(exec, await exec.findTmux(), loadTalkBindings(ctx.db), agentId);
          if (!target.ok) {
            // No live world tmux session (or no tmux at all): we have no safe way in.
            const error = target.error === TALK_INSTALL_HINT ? target.error : CONTROL_NOT_TMUX_ERROR;
            return respondJson(res, 409, { ok: false, error } satisfies ControlResult);
          }
          const key = hard ? "C-c" : "Escape";
          try {
            await exec.run(target.tmuxPath, ["send-keys", "-t", target.tmuxName, key]);
            ctx.log.info("control", `interrupt (${key}) → ${target.tmuxName}`);
            respondJson(res, 200, { ok: true, tmuxName: target.tmuxName, sent: key } satisfies ControlResult);
          } catch (err) {
            respondJson(res, 500, { ok: false, error: String(err) } satisfies ControlResult);
          }
        },
      },
      {
        method: "POST",
        path: "/api/agents/:agentId/note",
        async handler(req, res, ctx, params) {
          const agentId = params.agentId ?? "";
          if (!isValidUuid(agentId)) return respondJson(res, 400, { ok: false, error: "invalid agent id" } satisfies ControlResult);
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies ControlResult);
          }
          const raw = isRecord(body) && typeof body.text === "string" ? body.text : "";
          const text = cleanTalkText(raw);
          if (text.trim().length < 1 || raw.length > TALK_MAX_CHARS) {
            return respondJson(res, 400, { ok: false, error: `text must be 1..${TALK_MAX_CHARS} characters` } satisfies ControlResult);
          }
          const out = await deliverTalkText(exec, await exec.findTmux(), loadTalkBindings(ctx.db), agentId, text);
          if (out.status === 200) ctx.log.info("control", `note (${text.length} chars) → ${out.body.tmuxName ?? "?"}`);
          respondJson(res, out.status, { ...out.body, ...(out.body.ok ? { sent: "note" as const } : {}) } satisfies ControlResult);
        },
      },
    ],
  };
}

export const controlFeature = createControlFeature();
