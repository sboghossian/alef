// The "village" feature: indexes real inter-session SendMessage traffic for the #/room/all 3D
// village diorama's Town square (client/src/views/village-3d.ts draws the bridges + feed from
// this). Pure parsing lives in village-lib.ts; this file is just the onIndexPass wiring + the
// in-memory ring buffer. See docs/FEATURES.md for the ServerFeature contract.

import { VILLAGE_MESSAGE_CAP, VILLAGE_MESSAGE_MAX_AGE_MS, VILLAGE_MESSAGES_KEY, type VillageFeatureMessage, type VillageMessage } from "../../shared/features/village.js";
import { parseLine } from "../jsonl-events.js";
import type { ServerFeature } from "./registry.js";
import { buildMessage, incomingMessagesOnLine, pruneMessages, sendMessagesOnLine, type NameCandidate } from "./village-lib.js";

let messages: VillageMessage[] = [];

/** The messages snapshotExtras serves as "village.messages" (newest first), for the Town square's
 *  server-side workspace (server/features/workspace.ts). */
export function recentVillageMessages(): readonly VillageMessage[] {
  return pruneMessages(messages, Date.now(), VILLAGE_MESSAGE_MAX_AGE_MS, VILLAGE_MESSAGE_CAP);
}

export const villageFeature: ServerFeature = {
  id: "village",

  onIndexPass(ctx, newLinesBySession) {
    if (newLinesBySession.size === 0) return;
    const candidates: NameCandidate[] = ctx.worldViews().agents.map((a) => ({ id: a.id, title: a.title, cwd: a.cwd }));
    const fresh: VillageMessage[] = [];

    for (const [sessionId, lines] of newLinesBySession) {
      for (const raw of lines) {
        const mightSend = raw.includes('"name":"SendMessage"');
        const mightReceive = raw.includes("cross-session-message") || raw.includes("agent-message");
        if (!mightSend && !mightReceive) continue;

        if (mightSend) {
          const parsed = parseLine(raw);
          const at = parsed?.timestamp;
          if (at) for (const s of sendMessagesOnLine(parsed)) fresh.push(buildMessage("sent", at, sessionId, s, candidates));
        }
        if (mightReceive) {
          const recvs = incomingMessagesOnLine(raw);
          if (recvs.length) {
            const parsed = parseLine(raw);
            const at = parsed?.timestamp;
            if (at) for (const r of recvs) fresh.push(buildMessage("received", at, sessionId, r, candidates));
          }
        }
      }
    }

    if (fresh.length) {
      messages = pruneMessages([...fresh, ...messages], Date.now(), VILLAGE_MESSAGE_MAX_AGE_MS, VILLAGE_MESSAGE_CAP);
      ctx.emit({ kind: "messages", messages: fresh } satisfies VillageFeatureMessage);
    }
  },

  snapshotExtras() {
    messages = pruneMessages(messages, Date.now(), VILLAGE_MESSAGE_MAX_AGE_MS, VILLAGE_MESSAGE_CAP);
    return { [VILLAGE_MESSAGES_KEY]: messages };
  },
};
