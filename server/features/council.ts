// POST /api/council — the decision council: one batched Jev round over 4 personas
// (server/features/council-personas.ts + council-jev.ts), aggregated in code, then one
// headless Claude synthesis call (council-synth.ts). One council in flight at a time
// (429 otherwise, matching server/features/ask-jev.ts). GET /api/council/history
// serves the last 20 runs (council-store.ts) so the panel can show history on open.
//
// `createCouncilFeature` takes its Claude-synth executor as a parameter (defaulting to
// the real one) instead of a new ServerConfig field, so tests can inject a fake synth
// runner without touching server/index.ts (a hub file this plugin must not edit) —
// the registered `councilFeature` below is just `createCouncilFeature()`.
//
// Every verdict goes out on the live feed as one gov:council item (governance-lib.ts writes the
// words), appended here once the run is stored in history: the server is the one source, so the
// Feed, the Logs tab and a page that wasn't open all see the same single item.

import { randomUUID } from "node:crypto";
import type { CouncilResult, CouncilRunResponse, CouncilHistoryResponse } from "../../shared/features/council.js";
import { validateCouncilRequest } from "../../shared/features/council.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { aggregateCouncil, runCouncilJevRound } from "./council-jev.js";
import { loadCouncilHistory, pushCouncilHistory } from "./council-store.js";
import { appendToFeed } from "./feed.js";
import { councilVerdictItem, type FeedDraft } from "./governance-lib.js";
import { realSynthRunner, runCouncilSynth, SYNTH_TIMEOUT_MS, type SynthRunner } from "./council-synth.js";
import type { ServerFeature } from "./registry.js";

export interface CouncilDeps {
  synth: SynthRunner;
  synthTimeoutMs: number;
  now(): Date;
  idGen(): string;
  /** Where the verdict's governance item goes; defaults to the live Feed (feed.ts appendToFeed). */
  feed(item: FeedDraft): void;
}

const fail = (error: string): CouncilRunResponse => ({ ok: false, error });

let inFlight = false;

export function createCouncilFeature(deps: Partial<CouncilDeps> = {}): ServerFeature {
  const { synth = realSynthRunner, synthTimeoutMs = SYNTH_TIMEOUT_MS, now = () => new Date(), idGen = randomUUID, feed = appendToFeed } = deps;

  return {
    id: "council",
    routes: [
      {
        method: "POST",
        path: "/api/council",
        async handler(req, res, ctx) {
          if (inFlight) {
            respondJson(res, 429, fail("another council is already in flight"));
            return;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respondJson(res, 400, fail("invalid JSON body"));
            return;
          }
          const parsed = validateCouncilRequest(isRecord(body) ? body : {});
          if (!parsed.ok) {
            respondJson(res, 400, fail(parsed.error));
            return;
          }

          inFlight = true;
          try {
            const { personas, source } = await runCouncilJevRound(parsed.value, {
              apiKey: ctx.config.typesafeApiKey,
              fetchImpl: ctx.config.typesafeFetchImpl,
            });
            const aggregate = aggregateCouncil(personas);
            const verdict = await runCouncilSynth({ decision: parsed.value.decision, options: parsed.value.options, context: parsed.value.context, personas }, synth, synthTimeoutMs);

            const result: CouncilResult = {
              id: idGen(),
              at: now().toISOString(),
              decision: parsed.value.decision,
              options: parsed.value.options,
              context: parsed.value.context,
              personas,
              aggregate,
              verdict,
              source,
            };
            pushCouncilHistory(ctx.db, result);
            feed(councilVerdictItem(result));
            respondJson(res, 200, { ok: true, result } satisfies CouncilRunResponse);
          } catch (err) {
            respondJson(res, 500, fail(String(err)));
          } finally {
            inFlight = false;
          }
        },
      },
      {
        method: "GET",
        path: "/api/council/history",
        handler(_req, res, ctx) {
          respondJson(res, 200, { ok: true, history: loadCouncilHistory(ctx.db) } satisfies CouncilHistoryResponse);
        },
      },
    ],
  };
}

export const councilFeature: ServerFeature = createCouncilFeature();
