// Wire types for the "shelf" feature: what an agent session produced or referenced.
//
//   GET /api/shelf/:agentId               → ShelfResponse
//   GET /api/shelf/preview?path=&agentId= → the raw file (HTML / Markdown / text / image), ≤5MB
//       `path` is absolute. Allowed only inside: the agent's repo root (when agentId is given),
//       the vault, or a known automation output dir — realpath-checked, secrets refused.
//       Always served with Content-Security-Policy:
//       "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" (scripts never run)
//       + X-Content-Type-Options: nosniff. Text types have secrets redacted.

export const SHELF_PREVIEW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
export const SHELF_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export interface ShelfUrl {
  url: string; // http(s) only, secrets redacted, ≤500 chars
  host: string;
  count: number;
  firstAt: string | null;
}

export interface ShelfArtifact {
  url: string; // claude.ai artifact link
  firstAt: string | null;
}

export type ShelfFileType = "html" | "markdown" | "image" | "code" | "data" | "text" | "other";

export interface ShelfFile {
  path: string; // absolute
  type: ShelfFileType;
  op: "write" | "edit"; // last operation
  count: number;
  lastAt: string | null;
  previewable: boolean; // html / markdown / image / text inside an allowed root
  exists: boolean;
}

export interface ShelfResponse {
  ok: true;
  agentId: string;
  urls: ShelfUrl[];
  artifacts: ShelfArtifact[];
  files: ShelfFile[]; // everything written via Write/Edit/MultiEdit/NotebookEdit
  media: ShelfFile[]; // subset: images + HTML
  learnings: ShelfFile[]; // memory files / lessons the session wrote
}

export interface ShelfError {
  ok: false;
  error: string;
}
