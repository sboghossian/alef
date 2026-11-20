// Wire types for the "topics" feature (round 11 B): the planet's folder cities are grouped into
// ~10 topic continents taken from the owner's session-groups taxonomy
// (~/.claude/session-groups/taxonomy.json, read-only). Every session gets exactly one group:
//   1. its existing assignment (~/.claude/session-groups/assignments.json), else
//   2. a rule (the taxonomy's own title patterns, headless `claude -p` runs → AUTO, folder names,
//      unambiguous hint keywords), else
//   3. Jev (one batched TypeSafe Choice call per pass, cached in data/topics.json), else
//   4. the fallback group.
// A folder city (island) joins the continent its sessions mostly belong to. Catch-all folders
// (the home directory, "/") hold sessions of every topic, so they are split instead: their
// sessions are housed in a small neighbourhood inside each topic's continent.
//
//   GET /api/topics                   -> TopicsMap
//   WS  "topics" feature message      -> TopicsMessage (a recompute changed the map)
//   WorldSnapshot.extras["topics.map"] -> TopicsMap (read once, at boot, by the client layout)

export type TopicSource = "assigned" | "rule" | "jev" | "fallback";

export interface TopicGroup {
  key: string; // e.g. "WEB"
  name: string; // e.g. "ACME · Website"
  hint: string;
  color: string; // "#rrggbb", fixed per key
  sessions: number; // sessions classified into this group
  cities: number; // folder cities whose continent this is
}

export interface TopicSession {
  group: string;
  source: TopicSource;
}

export interface TopicsMap {
  generatedAt: string;
  /** Only groups that hold at least one session or city, most sessions first (ties: taxonomy order). */
  groups: TopicGroup[];
  /** Session id → its group. */
  sessions: Record<string, TopicSession>;
  /** Island id → continent (group key). Every island in the world has one. */
  islands: Record<string, string>;
  /** Islands whose sessions are split across continents (home dir, "/"). */
  catchAll: string[];
  /** Sessions still waiting for Jev (they sit in the fallback group meanwhile). */
  pendingJev: number;
  jev: "online" | "fallback" | "disabled";
}

export type TopicsMessage = { kind: "map"; map: TopicsMap };

const HEX = /^#[0-9a-f]{6}$/i;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** Structural check for the snapshot extra / API body (the client trusts nothing it parses). */
export function isTopicsMap(v: unknown): v is TopicsMap {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (!Array.isArray(m.groups) || typeof m.sessions !== "object" || m.sessions === null) return false;
  if (typeof m.islands !== "object" || m.islands === null || !Array.isArray(m.catchAll)) return false;
  const groupsOk = m.groups.every((g: unknown) => {
    if (typeof g !== "object" || g === null) return false;
    const o = g as Record<string, unknown>;
    return isStr(o.key) && isStr(o.name) && isStr(o.color) && HEX.test(o.color) && typeof o.sessions === "number" && typeof o.cities === "number";
  });
  if (!groupsOk) return false;
  if (!Object.values(m.islands as Record<string, unknown>).every(isStr)) return false;
  return Object.values(m.sessions as Record<string, unknown>).every((s) => typeof s === "object" && s !== null && isStr((s as Record<string, unknown>).group));
}
