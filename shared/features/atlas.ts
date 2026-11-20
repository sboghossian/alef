// Wire types for the "atlas" feature (🗺️ Atlas view): every capability Alex has (skills,
// agents, routines, CLIs) as leaves on a radial map, grouped into 8 capability departments (five
// read from his L2 memory bundles, three that no bundle covers), each with an autonomy rung and
// the evidence for it (server/features/atlas-lib.ts; Jev fallback: atlas-jev-lib.ts).
//
//   GET  /api/atlas           -> AtlasResponse (read-only, cached ~60 s)
//   POST /api/atlas/open/:id  -> AtlasOpenResult: opens a leaf's own file (the path the scan
//                                found, never one sent by the client, re-checked at click time
//                                inside its kind's root) with the open-editor executor
//
// PRIVACY: names, counts, reasons and file paths only. Never bundle, memory or skill body text;
// `description` is frontmatter (or cli.json `purpose`), capped. Render every string with textContent.

export const ATLAS_KINDS = ["skill", "agent", "routine", "cli"] as const;
export type AtlasKind = (typeof ATLAS_KINDS)[number];

/** manual → assisted → autonomous: the ladder, lowest rung first. */
export const ATLAS_AUTONOMY = ["manual", "assisted", "autonomous"] as const;
export type AtlasAutonomy = (typeof ATLAS_AUTONOMY)[number];

/** Ring order. The first five read an L2 bundle each; "unfiled" is always last. */
export const ATLAS_DEPT_IDS = ["acme-website", "acme-gtm", "infra", "rituals", "side-projects", "build-ship", "research-studio", "brain-vault", "unfiled"] as const;
export type AtlasDeptId = (typeof ATLAS_DEPT_IDS)[number];

/** How a leaf got its department, first that answers wins: Alex's override table, a bundle
 *  mention (or its two exceptions: a ritual job, or an Infra mention yielding to a pack or name
 *  keyword of a new department), its source pack, the keyword table, Jev; else unfiled. */
export const ATLAS_VIA = ["override", "mention", "ritual", "yield", "pack", "keyword", "jev", "unfiled"] as const;
export type AtlasVia = (typeof ATLAS_VIA)[number];

/** A Jev pick below this confidence is shown ("Jev unsure (0.42)") but the leaf stays Unfiled. */
export const ATLAS_JEV_MIN_CONFIDENCE = 0.6;

export interface AtlasDept {
  id: AtlasDeptId;
  name: string;
  emoji: string;
  /** Bundle files found for it under memory/_L2 (0 for Unfiled, or when the files are missing). */
  bundles: number;
  leaves: number;
}

export interface AtlasLeaf {
  /** "<kind>:<name>", unique. */
  id: string;
  kind: AtlasKind;
  name: string;
  description: string;
  dept: AtlasDeptId;
  /** Why it sits in that department: "override", "mentioned 3× in ACME GTM", "pack gstack",
   *  "keyword ingest (mentioned 1× in Infra + Claude)", "keyword qa", "Jev 0.84"; for Unfiled
   *  "Jev unsure (0.42)", "Jev unavailable", "Jev pending" or "unfiled". */
  reason: string;
  via: AtlasVia;
  /** Null = unknown: launchd's load state couldn't be read, so it is not called autonomous. */
  autonomy: AtlasAutonomy | null;
  /** What the rung rests on: "launchd com.stephane.x · daily 08:00", "fired 4× in 30 days", … */
  evidence: string;
  /** Lifetime uses: skill fires, subagent spawns, Tower runs. 0 = none recorded; null = its source
   *  (the Tower, the subagent scan) hasn't finished reading yet, so unknown, never 0. */
  uses: number | null;
  /** Routines count the Tower's last 10 runs, so theirs caps at 10. */
  uses30d: number;
  lastUsedAt: string | null;
  path: string | null;
  /** The open route would open `path` right now (inside its kind's root, a real file, no secret name). */
  canOpen: boolean;
}

export interface AtlasResponse {
  ok: true;
  at: string;
  /** The 🧠 centre: memory files (not MEMORY.md; null = unreadable) and L2 bundles read. */
  hub: { memoryFiles: number | null; bundles: number };
  departments: AtlasDept[];
  leaves: AtlasLeaf[];
  /** False while the skills history backfill is still reading: "never fired" may be wrong. */
  skillsHistoryReady: boolean;
  /** Sources not read yet ("Tower runs", "subagent runs", "launchd load state", "skill history",
   *  "Jev answers"): their leaves say "not read yet" / "Jev pending" and the server re-scans every
   *  few seconds until this is empty. */
  pending: string[];
}

export type AtlasOpenResult = { ok: true } | { ok: false; error: string };
