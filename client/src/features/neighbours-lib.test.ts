import { describe, expect, it } from "vitest";
import type { VillageMessage } from "../../../shared/features/village";
import type { WorldAgent, WorldEdge } from "../../../shared/types";
import {
  basename,
  coworkerPairCount,
  coworkers,
  crews,
  dropEdgesFrom,
  edgeMap,
  formatSpan,
  indexEdges,
  neighbourMessages,
  neighbourSections,
  sharedTouchPairCount,
  shortDate,
  shortDateTime,
  sameEdges,
  trips,
  validWindows,
  type ActiveWindow,
  type AgentHome,
  type SectionInput,
} from "./neighbours-lib";

// Shapes as /api/world serves them (2026-09-28): session uuids, `file:` / `repo:` object ids with
// absolute paths, `visited` edges session -> island id (server/trips-lib.ts), weights and ISO times.
const RECAP_A = "051664c3-f810-4a48-9ce8-d8c32c16658a";
const RECAP_B = "44ac7877-c6cf-4a8e-b2f5-de592f84f3ba";
const RECAP_C = "0148c55d-8fb0-4c96-b043-eb149836fa2d";
const LONER = "00f022f7-d41b-4977-adb1-4ea1df6220c3";
const ALEF_1 = "d9a3621c-8b1e-4c52-9f5e-3a7d1e0b2c44";
const ALEF_2 = "312782e5-6a0f-4e2b-8d1c-9b4f5e6a7c88";

const HOME = "/Users/alexboghossian";
const DIGEST = `file:${HOME}/.claude/skills/daily-recap/lib/digest.json`;
const NARRATIVE = "file:/tmp/daily-recap-narrative.json";
const MEMORY = `file:${HOME}/.claude/projects/-Users-alexboghossian/memory/MEMORY.md`;
const YALLA = `file:${HOME}/.config/yalla-brief.yaml`;
const AW_REPO = `repo:${HOME}/Documents/Code/agent-world`;
const AW_FILE = `file:${HOME}/Documents/Code/agent-world/server/director.ts`;

const touched = (from: string, to: string, at: string, weight = 1): WorldEdge => ({ from, to, kind: "touched", weight, at });
const visited = (from: string, to: string, at: string, weight: number): WorldEdge => ({ from, to, kind: "visited", weight, at });
const uses = (from: string, to: string, at: string): WorldEdge => ({ from, to, kind: "uses", weight: 1, at });

const EDGES: WorldEdge[] = [
  touched(RECAP_A, DIGEST, "2026-09-24T05:02:10.000Z"),
  touched(RECAP_A, NARRATIVE, "2026-09-24T05:03:00.000Z"),
  touched(RECAP_A, MEMORY, "2026-09-24T05:01:00.000Z"),
  touched(RECAP_B, DIGEST, "2026-09-26T05:02:10.000Z", 2),
  touched(RECAP_B, NARRATIVE, "2026-09-26T05:03:00.000Z"),
  touched(RECAP_C, DIGEST, "2026-09-25T05:02:10.000Z"),
  touched(LONER, YALLA, "2026-09-20T09:00:00.000Z"),
  uses(RECAP_A, "skill:daily-recap", "2026-09-24T05:00:00.000Z"),
  uses(RECAP_B, "skill:daily-recap", "2026-09-26T05:00:00.000Z"),
  // Two agent-world sessions: same repo root (cwd), one shared file, overlapping hours.
  touched(ALEF_1, AW_REPO, "2026-09-28T04:10:00.000Z"),
  touched(ALEF_2, AW_REPO, "2026-09-28T04:30:00.000Z"),
  touched(ALEF_1, AW_FILE, "2026-09-28T04:05:00.000Z"),
  touched(ALEF_2, AW_FILE, "2026-09-28T04:20:00.000Z"),
  visited(ALEF_1, "acme-ai-next", "2026-09-26T12:00:00.000Z", 3),
  visited(ALEF_1, "alex-claude", "2026-09-27T12:00:00.000Z", 1),
];

// Each session's first and last MESSAGE (a user or assistant line), as the server's neighbours
// feature serves them. Crews window on these, never on WorldAgent.startedAt / lastActive.
const SESSIONS = [
  { id: RECAP_A, islandId: "alex-claude", first: "2026-09-24T05:00:00.000Z", last: "2026-09-24T05:10:00.000Z" },
  { id: RECAP_B, islandId: "alex-claude", first: "2026-09-26T05:00:00.000Z", last: "2026-09-26T05:10:00.000Z" },
  { id: RECAP_C, islandId: "alex-claude", first: "2026-09-25T05:00:00.000Z", last: "2026-09-25T05:10:00.000Z" },
  { id: LONER, islandId: "yalla-brief", first: "2026-09-20T08:50:00.000Z", last: "2026-09-20T09:30:00.000Z" },
  { id: ALEF_1, islandId: "agent-world", first: "2026-09-28T03:38:00.000Z", last: "2026-09-28T04:40:00.000Z" },
  { id: ALEF_2, islandId: "agent-world", first: "2026-09-28T03:52:00.000Z", last: "2026-09-28T05:00:00.000Z" },
];
const AGENTS: ReadonlyMap<string, AgentHome> = new Map(SESSIONS.map((a) => [a.id, { id: a.id, islandId: a.islandId }] as const));
const WINDOWS: ReadonlyMap<string, ActiveWindow> = new Map(SESSIONS.map((a) => [a.id, { first: a.first, last: a.last }] as const));

const ISLANDS: Record<string, string> = { "acme-ai-next": "acme-ai-next", "alex-claude": "alex_claude", "agent-world": "agent-world", "yalla-brief": "yalla-brief" };

function input(edges: readonly WorldEdge[] = EDGES, messages: readonly VillageMessage[] = []): SectionInput {
  return {
    index: indexEdges(edges),
    agents: AGENTS,
    windows: WINDOWS,
    messages,
    titleOf: (id) => (AGENTS.has(id) ? `session ${id.slice(0, 4)}` : null),
    islandName: (id) => ISLANDS[id] ?? null,
  };
}

const msg = (over: Partial<VillageMessage>): VillageMessage => ({
  id: "m1",
  at: "2026-09-28T04:15:00.000Z",
  direction: "sent",
  fromSessionId: ALEF_1,
  fromRaw: "builder",
  toSessionId: ALEF_2,
  toRaw: "reviewer",
  preview: "diff is ready for review",
  ...over,
});

describe("coworkers (shared files)", () => {
  it("ranks sessions by shared-file count, then newest, and names the shared files", () => {
    const list = coworkers(RECAP_A, indexEdges(EDGES));
    expect(list.map((c) => c.agentId)).toEqual([RECAP_B, RECAP_C]);
    expect(list[0]).toEqual({
      agentId: RECAP_B,
      files: [NARRATIVE.slice(5), DIGEST.slice(5)],
      at: "2026-09-26T05:03:00.000Z",
    });
    expect(list[1]?.files).toEqual([DIGEST.slice(5)]);
  });

  it("a shared repo root alone is not a shared file", () => {
    const idx = indexEdges([touched(ALEF_1, AW_REPO, "2026-09-28T04:10:00.000Z"), touched(ALEF_2, AW_REPO, "2026-09-28T04:30:00.000Z")]);
    expect(coworkers(ALEF_1, idx)).toEqual([]);
    expect(coworkerPairCount(idx)).toEqual({ pairs: 0, sessions: 0 });
    expect(sharedTouchPairCount(idx)).toEqual({ pairs: 1, sessions: 2 });
  });

  it("the store's re-pushed duplicates don't double count", () => {
    const doubled = [...EDGES, ...EDGES.map((e) => ({ ...e }))];
    expect(coworkers(RECAP_A, indexEdges(doubled))).toEqual(coworkers(RECAP_A, indexEdges(EDGES)));
    expect(coworkerPairCount(indexEdges(doubled))).toEqual(coworkerPairCount(indexEdges(EDGES)));
  });

  it("leaves out sessions the store no longer knows", () => {
    expect(coworkers(RECAP_A, indexEdges(EDGES), (id) => id !== RECAP_B).map((c) => c.agentId)).toEqual([RECAP_C]);
  });

  it("counts pairs over files only, and over files or repo roots (the vision plan's figure)", () => {
    const idx = indexEdges(EDGES);
    // Files: A-B, A-C, B-C (digest), ALEF_1-ALEF_2 (director.ts).
    expect(coworkerPairCount(idx)).toEqual({ pairs: 4, sessions: 5 });
    expect(sharedTouchPairCount(idx)).toEqual({ pairs: 4, sessions: 5 });
    const moreRepo = [...EDGES, touched(LONER, AW_REPO, "2026-09-20T09:00:00.000Z")];
    expect(sharedTouchPairCount(indexEdges(moreRepo))).toEqual({ pairs: 6, sessions: 6 });
    expect(coworkerPairCount(indexEdges(moreRepo))).toEqual({ pairs: 4, sessions: 5 });
  });
});

describe("crews (same island, overlapping hours, a shared repo or file)", () => {
  it("finds the overlap window and cites the repo and the shared files", () => {
    const list = crews(ALEF_1, AGENTS, WINDOWS, indexEdges(EDGES));
    expect(list).toEqual([
      {
        agentId: ALEF_2,
        repos: [AW_REPO.slice(5)],
        sharedFiles: 1,
        overlapStart: "2026-09-28T03:52:00.000Z",
        overlapEnd: "2026-09-28T04:40:00.000Z",
        overlapMs: 48 * 60_000,
      },
    ]);
  });

  it("sessions whose windows don't overlap are not a crew, even with shared files", () => {
    // RECAP_A and RECAP_B share 2 files on one island but ran two days apart.
    expect(crews(RECAP_A, AGENTS, WINDOWS, indexEdges(EDGES))).toEqual([]);
  });

  it("another island is not a crew, even at the same hours with the same file", () => {
    const agents = new Map(AGENTS);
    agents.set(ALEF_2, { id: ALEF_2, islandId: "acme-ai-next" });
    expect(crews(ALEF_1, agents, WINDOWS, indexEdges(EDGES))).toEqual([]);
  });

  it("same island and same hours but nothing shared is not a crew", () => {
    const idx = indexEdges(EDGES.filter((e) => e.from !== ALEF_2));
    expect(crews(ALEF_1, AGENTS, WINDOWS, idx)).toEqual([]);
  });
});

// PR #49 review, measured on the live world (05:29Z): the store's agents carry the indexer's
// startedAt / lastActive, which any timestamped line (queue-operation, frame-link…) or the file's
// mtime moves. Rows below are those shapes: the served hours overlap, the messages don't (or less).
describe("crews window on first-to-last MESSAGE, never on the served [startedAt, lastActive]", () => {
  const OLD = "d8ef046a-a4b8-4248-a5a5-58d8cd8f8c52";
  const NEW = "33704cb8-0000-4000-8000-000000000001";
  type Served = Pick<WorldAgent, "id" | "islandId" | "startedAt" | "lastActive">;
  const served = (id: string, startedAt: string, lastActive: string): Served => ({ id, islandId: "alex-claude", startedAt, lastActive });
  const REPO = `repo:${HOME}`;
  const edges = [touched(OLD, REPO, "2026-09-26T09:48:36.268Z"), touched(NEW, REPO, "2026-09-26T12:00:00.000Z")];
  const sectionInput = (agents: ReadonlyMap<string, Served>, windows: ReadonlyMap<string, ActiveWindow>): SectionInput => ({
    index: indexEdges(edges),
    agents,
    windows,
    messages: [],
    titleOf: (id) => (agents.has(id) ? id.slice(0, 8) : null),
    islandName: () => null,
  });
  const byId = <T extends { id: string }>(...xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x] as const));

  it("d8ef046a | 33704cb8: a dequeue + frame-link a day after the last message is no crew", () => {
    // Served: OLD 09-25 10:00 → 09-26 09:48:36 (a dequeue and a frame-link line); NEW from 09-26 09:46.
    const agents = byId(served(OLD, "2026-09-25T10:00:00.000Z", "2026-09-26T09:48:36.268Z"), served(NEW, "2026-09-26T09:46:00.000Z", "2026-09-26T12:00:00.000Z"));
    const windows = new Map([
      [OLD, { first: "2026-09-25T10:00:00.000Z", last: "2026-09-25T18:36:10.000Z" }],
      [NEW, { first: "2026-09-26T09:46:00.000Z", last: "2026-09-26T12:00:00.000Z" }],
    ]);
    expect(neighbourSections(OLD, sectionInput(agents, windows)).find((s) => s.id === "crew")).toBeUndefined();
    expect(neighbourSections(NEW, sectionInput(agents, windows)).find((s) => s.id === "crew")).toBeUndefined();
  });

  it("the overlap length and the hover's window are the messages' (13726523 | 2e241cfe: 21h 49m served, 10h 35m by messages)", () => {
    const agents = byId(served(OLD, "2026-09-26T00:00:00.000Z", "2026-09-27T00:00:00.000Z"), served(NEW, "2026-09-26T02:11:00.000Z", "2026-09-27T06:00:00.000Z"));
    const windows = new Map([
      [OLD, { first: "2026-09-26T00:00:00.000Z", last: "2026-09-26T12:46:00.000Z" }],
      [NEW, { first: "2026-09-26T02:11:00.000Z", last: "2026-09-26T20:00:00.000Z" }],
    ]);
    const row = neighbourSections(OLD, sectionInput(agents, windows)).find((s) => s.id === "crew")?.rows[0];
    expect(row?.tag).toBe("10h 35m");
    expect(row?.hover).toBe(`Both sessions were active (first to last message) from ${shortDateTime("2026-09-26T02:11:00.000Z")} to ${shortDateTime("2026-09-26T12:46:00.000Z")}.\nSame repo: ${HOME}`);
  });

  it("a session with no known message window is never crew, whatever its served hours", () => {
    const agents = byId(served(OLD, "2026-09-26T00:00:00.000Z", "2026-09-27T00:00:00.000Z"), served(NEW, "2026-09-26T02:00:00.000Z", "2026-09-26T20:00:00.000Z"));
    const windows = new Map([[OLD, { first: "2026-09-26T00:00:00.000Z", last: "2026-09-26T23:00:00.000Z" }]]);
    expect(neighbourSections(OLD, sectionInput(agents, windows)).find((s) => s.id === "crew")).toBeUndefined();
    expect(crews(OLD, agents, windows, indexEdges(edges))).toEqual([]);
    expect(crews(OLD, agents, new Map(), indexEdges(edges))).toEqual([]);
  });

  it("served windows are untrusted: malformed rows are dropped, so those sessions get no crew", () => {
    const good = { id: OLD, first: "2026-09-25T10:00:00.000Z", last: "2026-09-25T18:36:10.000Z" };
    expect(validWindows([good, { id: NEW, first: "2026-09-26T09:46:00.000Z" }, { id: 7, first: good.first, last: good.last }, { id: NEW, first: "soon", last: good.last }, null, "x"])).toEqual([good]);
    expect(validWindows(undefined)).toEqual([]);
    expect(validWindows({ [OLD]: good })).toEqual([]);
  });
});

describe("trips", () => {
  it("are the visited edges, newest first, with their touches", () => {
    expect(trips(ALEF_1, indexEdges(EDGES))).toEqual([
      { islandId: "alex-claude", at: "2026-09-27T12:00:00.000Z", touches: 1 },
      { islandId: "acme-ai-next", at: "2026-09-26T12:00:00.000Z", touches: 3 },
    ]);
    expect(trips(RECAP_A, indexEdges(EDGES))).toEqual([]);
  });

  it("a later copy of a visit replaces the earlier one (the server recomputes the weight)", () => {
    const later = [...EDGES, visited(ALEF_1, "acme-ai-next", "2026-09-28T04:00:00.000Z", 5)];
    expect(trips(ALEF_1, indexEdges(later))[0]).toEqual({ islandId: "acme-ai-next", at: "2026-09-28T04:00:00.000Z", touches: 5 });
  });

  it("a visit to the session's own current island is not shown as a trip", () => {
    const edges = [...EDGES, visited(ALEF_1, "agent-world", "2026-09-28T04:00:00.000Z", 2)];
    const tripRows = neighbourSections(ALEF_1, input(edges)).find((s) => s.id === "trips")?.rows ?? [];
    expect(tripRows.map((r) => r.text.split(" · ")[0])).toEqual(["alex_claude", "acme-ai-next"]);
  });

  it("an old invented agent -> agent visit (pre-#47) is not shown as a trip", () => {
    const edges = [...EDGES, visited(RECAP_A, RECAP_B, "2026-09-27T01:00:00.000Z", 1)];
    const sections = neighbourSections(RECAP_A, input(edges));
    expect(sections.find((s) => s.id === "trips")).toBeUndefined();
  });
});

describe("messages", () => {
  it("keeps only messages with both ends resolved, and pairs a received copy with its sent row", () => {
    const list = neighbourMessages(ALEF_1, [
      msg({}),
      msg({ id: "m2", direction: "received", at: "2026-09-28T04:15:02.000Z" }),
      msg({ id: "m3", toSessionId: null, toRaw: "team-lead" }),
      msg({ id: "m4", fromSessionId: ALEF_2, toSessionId: ALEF_2 }),
      msg({ id: "m5", fromSessionId: ALEF_2, toSessionId: ALEF_1, preview: "LGTM", at: "2026-09-28T04:30:00.000Z", direction: "received" }),
    ]);
    expect(list).toEqual([
      { id: "m5", direction: "from", counterpartId: ALEF_2, at: "2026-09-28T04:30:00.000Z", preview: "LGTM" },
      { id: "m1", direction: "to", counterpartId: ALEF_2, at: "2026-09-28T04:15:00.000Z", preview: "diff is ready for review" },
    ]);
  });

  it("two real messages with the same text stay two rows, observed once or twice each", () => {
    const list = neighbourMessages(ALEF_1, [
      msg({ id: "s1", preview: "status?", at: "2026-09-28T01:00:00.000Z" }),
      msg({ id: "s2", preview: "status?", at: "2026-09-28T04:00:00.000Z" }),
      msg({ id: "r1", preview: "status?", direction: "received", at: "2026-09-28T01:00:03.000Z" }),
      msg({ id: "r2", preview: "status?", direction: "received", at: "2026-09-28T04:00:03.000Z" }),
    ]);
    expect(list.map((m) => m.id)).toEqual(["s2", "s1"]);
  });

  it("a received copy logged slightly before its sent row (clock skew) still pairs; one with no sent row is kept", () => {
    const list = neighbourMessages(ALEF_2, [
      msg({ id: "r1", direction: "received", at: "2026-09-28T04:14:30.000Z" }),
      msg({ id: "s1", at: "2026-09-28T04:15:00.000Z" }),
      msg({ id: "r9", direction: "received", preview: "only the receiver was indexed", at: "2026-09-28T02:00:00.000Z" }),
    ]);
    expect(list.map((m) => [m.id, m.direction])).toEqual([
      ["s1", "from"],
      ["r9", "from"],
    ]);
  });

  it("?redact=1 hides the text after pairing, so the count stays real", () => {
    const messages = [msg({ id: "a", preview: "one", at: "2026-09-28T01:00:00.000Z" }), msg({ id: "b", preview: "two", at: "2026-09-28T02:00:00.000Z" })];
    const section = neighbourSections(ALEF_1, { ...input(EDGES, messages), redactPreviews: true }).find((x) => x.id === "messages");
    expect(section?.rows.map((r) => r.text)).toEqual(["to session 3127: …", "to session 3127: …"]);
  });
});

describe("neighbourSections (the agent panel)", () => {
  it("a session with no co-workers, crew, trips or messages shows nothing at all", () => {
    expect(neighbourSections(LONER, input())).toEqual([]);
    expect(neighbourSections("not-in-the-world", input())).toEqual([]);
  });

  it("every row cites its evidence, and nothing is called a friend", () => {
    const sections = neighbourSections(ALEF_1, input(EDGES, [msg({})]));
    expect(sections.map((s) => s.id)).toEqual(["coworkers", "crew", "trips", "messages"]);
    const [cw, crew, tr, m] = sections;
    expect(cw?.heading).toBe("Worked alongside (shared files)");
    expect(cw?.rows[0]).toMatchObject({ tag: "1 shared file" });
    expect(cw?.rows[0]?.text).toMatch(/^session 3127 · director\.ts · last \d\d-\d\d$/);
    expect(cw?.rows[0]?.hover).toContain(AW_FILE.slice(5));
    expect(crew?.rows[0]?.text).toMatch(/^session 3127 · same repo agent-world \+ 1 shared file · \d\d-\d\d( → \d\d-\d\d)?$/);
    expect(crew?.rows[0]?.tag).toBe("48m");
    expect(tr?.heading).toBe("Trips (read or edited files in another district)");
    expect(tr?.rows.map((r) => r.tag)).toEqual(["×1", "×3"]);
    expect(tr?.rows[1]?.text).toMatch(/^acme-ai-next · last \d\d-\d\d$/);
    expect(m?.rows[0]?.text).toBe("to session 3127: diff is ready for review");
    for (const s of sections) {
      expect(s.heading.toLowerCase()).not.toContain("friend");
      for (const r of s.rows) {
        expect(r.tag).not.toBe("");
        expect(`${r.text} ${r.tag} ${r.hover}`.toLowerCase()).not.toContain("friend");
      }
    }
  });

  it("shows the top 5 and says how many there are", () => {
    const many = Array.from({ length: 7 }, (_, i) => `aaaaaaa${i}-0000-4000-8000-000000000000`);
    const agents = new Map(AGENTS);
    for (const id of many) agents.set(id, { id, islandId: "alex-claude" });
    const edges = [...EDGES, ...many.map((id) => touched(id, DIGEST, "2026-09-01T00:01:00.000Z"))];
    const sections = neighbourSections(RECAP_A, { ...input(edges), agents, titleOf: (id) => (agents.has(id) ? id.slice(0, 8) : null) });
    expect(sections[0]?.heading).toBe("Worked alongside (shared files) · top 5 of 9");
    expect(sections[0]?.rows).toHaveLength(5);
  });

  it("names 3 shared files and counts the rest", () => {
    const extra = ["a.md", "b.md", "c.md", "d.md"].map((n) => `file:${HOME}/notes/${n}`);
    const edges = [...extra.map((f) => touched(RECAP_A, f, "2026-09-24T05:05:00.000Z")), ...extra.map((f) => touched(RECAP_C, f, "2026-09-25T05:05:00.000Z"))];
    const row = neighbourSections(RECAP_A, input([...EDGES, ...edges]))[0]?.rows[0];
    expect(row?.tag).toBe("5 shared files");
    expect(row?.text).toMatch(/ \+2 more · last /);
  });
});

describe("edge map upkeep", () => {
  it("keeps one edge per (from, to, kind), tells a changed push from a repeat, and drops removed sessions", () => {
    const map = edgeMap([...EDGES, ...EDGES.map((e) => ({ ...e }))]);
    expect(map.size).toBe(EDGES.length);
    expect(sameEdges(map, edgeMap(EDGES.map((e) => ({ ...e }))))).toBe(true);
    expect(sameEdges(map, edgeMap([...EDGES.slice(1), touched(RECAP_A, DIGEST, "2026-09-27T05:00:00.000Z", 2)]))).toBe(false);
    // An edge the server stopped serving is gone from the next push, and so from the map.
    expect(sameEdges(map, edgeMap(EDGES.slice(1)))).toBe(false);
    expect(dropEdgesFrom(map, [RECAP_A])).toBe(true);
    expect([...map.values()].some((e) => e.from === RECAP_A)).toBe(false);
    expect(dropEdgesFrom(map, [RECAP_A])).toBe(false);
  });
});

describe("folders are not files", () => {
  it("a Glob/Grep path on a repo root, an island folder or a trailing-slash path never makes co-workers", () => {
    const repoRootAsFile = `file:${HOME}/Documents/Code/agent-world`;
    const islandFolder = `file:${HOME}/Documents/Code/alex_claude`;
    const slashPath = `file:${HOME}/notes/`;
    const edges = [...EDGES, ...[repoRootAsFile, islandFolder, slashPath].flatMap((f) => [touched(RECAP_A, f, "2026-09-24T05:04:00.000Z"), touched(LONER, f, "2026-09-20T09:01:00.000Z")])];
    const idx = indexEdges(edges, [`${HOME}/Documents/Code/alex_claude`]);
    expect(coworkers(LONER, idx)).toEqual([]);
    expect(coworkers(RECAP_A, idx).map((c) => c.agentId)).toEqual([RECAP_B, RECAP_C]);
  });
});

describe("formatting", () => {
  it("formats spans, dates and basenames", () => {
    expect(formatSpan(30_000)).toBe("under 1m");
    expect(formatSpan(45 * 60_000)).toBe("45m");
    expect(formatSpan(130 * 60_000)).toBe("2h 10m");
    expect(formatSpan(3 * 3_600_000)).toBe("3h");
    expect(formatSpan((3 * 24 + 4) * 3_600_000)).toBe("3d 4h");
    // Noon UTC is the same calendar day in every timezone from UTC-11 to UTC+11.
    expect(shortDate("2026-09-26T12:00:00.000Z")).toBe("09-26");
    expect(shortDate("not a date")).toBe("?");
    expect(basename("/Users/x/.claude/skills/daily-recap/lib/digest.json")).toBe("digest.json");
    expect(basename("/Users/x/Documents/Code/agent-world/")).toBe("agent-world");
    expect(basename("/")).toBe("/");
  });
});
