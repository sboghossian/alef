// POST /api/open-editor/:agentId — opens the agent's cwd in VS Code (`code <cwd>`)
// through the injectable openEditor executor.

import type { ReactivateResult } from "../../shared/types.js";
import { respondJson } from "../http.js";
import { isValidUuid } from "../reactivate.js";
import type { ServerFeature } from "./registry.js";

export const openEditorFeature: ServerFeature = {
  id: "open-editor",
  routes: [
    {
      method: "POST",
      path: "/api/open-editor/:agentId",
      async handler(_req, res, ctx, params) {
        const agentId = params.agentId ?? "";
        const reply = (status: number, error?: string): void =>
          respondJson(res, status, (error === undefined ? { ok: true, agentId } : { ok: false, agentId, error }) satisfies ReactivateResult);
        if (!isValidUuid(agentId)) return reply(400, "invalid agent id");
        const session = ctx.db.getSession(agentId);
        if (!session) return reply(404, "unknown agent id");
        try {
          await ctx.executors.openEditor(session.cwd);
          reply(200);
        } catch (err) {
          reply(500, String(err));
        }
      },
    },
  ],
};
