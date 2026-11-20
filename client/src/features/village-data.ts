// Client-side store for the "village" feature (server/features/village.ts): real inter-session
// SendMessage traffic, plus a read-only peek at the resident's state for the village diorama's
// special room (client/src/views/village-3d.ts). shared/features/resident.ts is another
// builder's feature — this file only READS its snapshot key defensively; it never imports from
// or writes to the resident feature's own client/server modules.

import { RESIDENT_SNAPSHOT_KEY, type ResidentState } from "../../../shared/features/resident";
import { VILLAGE_MESSAGES_KEY, type VillageMessage } from "../../../shared/features/village";
import type { ClientFeature } from "./registry";

type Fn = () => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isVillageMessage(v: unknown): v is VillageMessage {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    (v.direction === "sent" || v.direction === "received") &&
    (v.fromSessionId === null || typeof v.fromSessionId === "string") &&
    typeof v.fromRaw === "string" &&
    (v.toSessionId === null || typeof v.toSessionId === "string") &&
    typeof v.toRaw === "string" &&
    typeof v.preview === "string"
  );
}

/** Loose but defensive validation of resident.ts's own shape (we don't own that feature, so we
 *  never trust world.extras blindly — an absent or malformed value just means no resident room). */
function isResidentState(v: unknown): v is ResidentState {
  return (
    isRecord(v) &&
    typeof v.name === "string" &&
    typeof v.enabled === "boolean" &&
    typeof v.day === "number" &&
    Array.isArray(v.skills) &&
    v.skills.every((s) => typeof s === "string") &&
    Array.isArray(v.journalTail) &&
    v.journalTail.every((s) => typeof s === "string")
  );
}

const MAX_MESSAGES = 200;

class VillageData {
  messages: VillageMessage[] = [];
  resident: ResidentState | null = null;
  private readonly changeFns = new Set<Fn>();

  setMessages(list: readonly unknown[]): void {
    this.messages = list.filter(isVillageMessage).slice(0, MAX_MESSAGES);
    this.notify();
  }

  addMessages(list: readonly unknown[]): void {
    const fresh = list.filter(isVillageMessage);
    if (!fresh.length) return;
    const byId = new Map(this.messages.map((m) => [m.id, m] as const));
    for (const m of fresh) byId.set(m.id, m);
    this.messages = [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_MESSAGES);
    this.notify();
  }

  setResident(v: unknown): void {
    this.resident = isResidentState(v) ? v : null;
    this.notify();
  }

  onChange(fn: Fn): void {
    this.changeFns.add(fn);
  }

  private notify(): void {
    for (const fn of this.changeFns) fn();
  }
}

export const villageData = new VillageData();

export const villageFeature: ClientFeature = {
  id: "village",
  onSnapshot(world) {
    const extras = world.extras;
    if (!extras) return;
    const raw = extras[VILLAGE_MESSAGES_KEY];
    if (Array.isArray(raw)) villageData.setMessages(raw);
    villageData.setResident(extras[RESIDENT_SNAPSHOT_KEY]);
  },
  onMessage(msg) {
    const payload = msg.payload;
    if (isRecord(payload) && payload.kind === "messages" && Array.isArray(payload.messages)) villageData.addMessages(payload.messages);
  },
};
