// POST /api/ask-jev — "who worked on X?" answered by Jev (TypeSafe) over the agents
// in the world, with a keyword fallback. One ask in flight at a time.

import type { AskJevRequest, AskJevResult } from "../../shared/types.js";
import { runAskJev } from "../ask-jev.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import type { ServerFeature } from "./registry.js";

const fail = (error: string): AskJevResult => ({ ok: false, matches: [], confidence: 0, source: "keyword", error });

let inFlight = false;

export const askJevFeature: ServerFeature = {
  id: "ask-jev",
  routes: [
    {
      method: "POST",
      path: "/api/ask-jev",
      async handler(req, res, ctx) {
        const { agents } = ctx.worldViews();
        if (inFlight) {
          respondJson(res, 429, fail("another ask is already in flight"));
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          respondJson(res, 400, fail("invalid JSON body"));
          return;
        }
        const question = isRecord(body) && typeof body.question === "string" ? body.question : null;
        if (question === null || question.length < 1 || question.length > 500) {
          respondJson(res, 400, fail("question must be 1..500 characters"));
          return;
        }
        inFlight = true;
        try {
          const result = await runAskJev(ctx.db, agents, { question } satisfies AskJevRequest, {
            apiKey: ctx.config.typesafeApiKey,
            fetchImpl: ctx.config.typesafeFetchImpl,
          });
          respondJson(res, 200, result);
        } catch (err) {
          respondJson(res, 500, fail(String(err)));
        } finally {
          inFlight = false;
        }
      },
    },
  ],
};
