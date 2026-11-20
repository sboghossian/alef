// Pure extraction + merge for the "artifacts" feature. One transcript line in, artifact events
// out; events folded into one item per artifact. Transcript text is untrusted: fields are read and
// links matched, nothing is ever run.
//
// Where artifacts show up in a Claude Code transcript:
//  - an Artifact tool_use (publish: no `action`, or "publish"; asset uploads skipped) and the user
//    line carrying its tool_result. That line's `toolUseResult` holds {url, path, title, artifact_id};
//    without it, the url comes from the result text and the path/title from the tool_use input.
//  - a `frame-link` record {frameUrl, title, path} Claude Code writes next to each publish result.
//    It never counts as a second publish, it only fills title/path/publisher.
//  - a gallery listing (Artifact list): toolUseResult.artifacts[] {title, url, updatedAt}: titles only.
//  - any other line naming a claude.ai artifact link: a mention by that session.

import { isRealArtifactId, type ArtifactItem } from "../../shared/features/artifacts.js";
import { isRecord } from "../http.js";
import { artifactUrlsIn } from "./shelf-lib.js";

export interface PendingPublish {
  path: string | null;
  title: string | null;
  at: string | null;
}

export type ArtifactEvent =
  | { kind: "publish"; url: string; title: string | null; path: string | null; at: string | null; sessionId: string; uuid: string | null; hint: boolean }
  | { kind: "mention"; url: string; at: string | null; sessionId: string; title?: string | null }
  | { kind: "listed"; url: string; title: string | null; at: string | null };

const MAX_PENDING = 50;
const MAX_SESSIONS = 20;
const MENTION_TITLE_RANK = 0.5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** The artifact id: the last path segment of its link. */
export function artifactIdOf(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? url;
}

/** Real artifact links only: a placeholder (`abc-123`) or a truncated id never becomes an item.
 *  A trailing slash is dropped so the same artifact is one url. */
function realArtifactUrlsIn(text: string): string[] {
  return artifactUrlsIn(text)
    .map((u) => u.replace(/\/+$/, ""))
    .filter((u) => isRealArtifactId(artifactIdOf(u)));
}

function firstArtifactUrl(v: unknown): string | null {
  return typeof v === "string" ? (realArtifactUrlsIn(v)[0] ?? null) : null;
}

const LINK_TEXT_GENERIC = /^(?:link|links|here|this|that|it|artifact|the artifact|open|open it|view|see|url|page|the link|this link|this artifact|click here)$/i;
const MD_LINK_RE = /\[([^\][\\\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g;

/** Artifact url → the link text of a markdown link `[Title](artifact url)` in `text`. Empty,
 *  generic ("link", "here") and URL-as-text labels are ignored; the first usable one per url wins. */
export function mentionTitlesIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(MD_LINK_RE)) {
    const label = str(m[1]?.replace(/\s+/g, " "));
    const url = realArtifactUrlsIn(m[2] ?? "")[0];
    if (!label || !url || out.has(url)) continue;
    if (/^https?:\/\//i.test(label) || /claude\.ai\//i.test(label) || LINK_TEXT_GENERIC.test(label.replace(/[.!:]+$/, ""))) continue;
    out.set(url, label);
  }
  return out;
}

/** Mention events for every real artifact link in `raw`, titled by a markdown link text when there is one. */
function mentionsIn(raw: string, at: string | null, sessionId: string): ArtifactEvent[] {
  const titles = mentionTitlesIn(raw);
  return realArtifactUrlsIn(raw).map((url) => ({ kind: "mention", url, at, sessionId, ...(titles.has(url) ? { title: titles.get(url) } : {}) }));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** Events in one raw transcript line. `pending` holds this file's Artifact publish calls whose
 *  result is not read yet (it lives in the file's cursor, so a call and its result may sit in two
 *  passes). Lines with no artifact link and no Artifact call cost one substring check. */
export function foldLine(raw: string, sessionId: string, pending: Map<string, PendingPublish>): ArtifactEvent[] {
  const hasLink = raw.includes("claude.ai/");
  if (!hasLink && !raw.includes('"Artifact"')) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return hasLink ? mentionsIn(raw, null, sessionId) : [];
  }
  if (!isRecord(obj)) return [];
  const at = str(obj.timestamp, 40);
  if (obj.type === "frame-link") {
    const url = firstArtifactUrl(obj.frameUrl);
    return url ? [{ kind: "publish", url, title: str(obj.title), path: str(obj.path, 2048), at, sessionId, uuid: null, hint: true }] : [];
  }
  const out: ArtifactEvent[] = [];
  const tur = isRecord(obj.toolUseResult) ? obj.toolUseResult : null;
  if (tur && Array.isArray(tur.artifacts)) {
    for (const a of tur.artifacts) {
      if (!isRecord(a)) continue;
      const url = firstArtifactUrl(a.url);
      if (url) out.push({ kind: "listed", url, title: str(a.title), at: str(a.updatedAt, 40) });
    }
    return out; // a gallery listing is not this session working with each artifact
  }
  const message = isRecord(obj.message) ? obj.message : null;
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  let published = false;
  for (const b of blocks) {
    if (!isRecord(b)) continue;
    if (b.type === "tool_use" && b.name === "Artifact" && typeof b.id === "string") {
      const input = isRecord(b.input) ? b.input : {};
      const action = input.action ?? "publish";
      if (action !== "publish" || input.asset === true) continue;
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value ?? "");
      pending.set(b.id, { path: str(input.file_path, 2048), title: str(input.title), at });
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const call = pending.get(b.tool_use_id);
      if (!call) continue;
      pending.delete(b.tool_use_id);
      if (b.is_error === true) continue;
      const text = resultText(b.content);
      const url = firstArtifactUrl(tur?.url) ?? (/^\s*Published\b/.test(text) ? firstArtifactUrl(text) : null);
      if (!url) continue;
      const uuid = str(tur?.artifact_id, 64);
      published = true;
      out.push({
        kind: "publish",
        url,
        title: str(tur?.title) ?? call.title,
        path: str(tur?.path, 2048) ?? call.path,
        at: at ?? call.at,
        sessionId,
        uuid: uuid && UUID_RE.test(uuid) ? uuid.toLowerCase() : null,
        hint: false,
      });
    }
  }
  if (!published && hasLink) out.push(...mentionsIn(raw, at, sessionId));
  return out;
}

/** One artifact as persisted (world.db meta, artifacts-store.ts). */
export interface StoredArtifact {
  id: string;
  url: string;
  title: string | null;
  /** 2: from a publish, 1: from a gallery listing, 0.5: from a markdown link in a mention. */
  titleRank: number;
  titleAt: string | null;
  sourcePath: string | null;
  sourceAt: string | null;
  publishCount: number;
  firstAt: string | null;
  lastPublishAt: string | null;
  seenAt: string | null;
  /** session id → latest time (publishers / mentioners). */
  publishers: Record<string, string>;
  mentioners: Record<string, string>;
  /** The saved copy's source stat when it was taken; null = none. */
  snap: { mtimeMs: number; size: number } | null;
}

export interface ArtifactsState {
  items: Record<string, StoredArtifact>;
  /** claude.ai's artifact uuid → the item id (a /code/artifact/<uuid> link is the same item). */
  aliases: Record<string, string>;
}

export const emptyState = (): ArtifactsState => ({ items: {}, aliases: {} });

const minIso = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);
const maxIso = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);
const later = (at: string | null, than: string | null): boolean => than === null || (at !== null && at >= than);

function note(map: Record<string, string>, sessionId: string, at: string | null): void {
  map[sessionId] = maxIso(map[sessionId] ?? null, at) ?? map[sessionId] ?? "";
  const keys = Object.keys(map);
  if (keys.length <= MAX_SESSIONS) return;
  const oldest = keys.sort((a, b) => (map[a] ?? "").localeCompare(map[b] ?? ""))[0];
  if (oldest !== undefined) delete map[oldest];
}

function blank(id: string, url: string): StoredArtifact {
  return { id, url, title: null, titleRank: 0, titleAt: null, sourcePath: null, sourceAt: null, publishCount: 0, firstAt: null, lastPublishAt: null, seenAt: null, publishers: {}, mentioners: {}, snap: null };
}

function absorb(into: StoredArtifact, from: StoredArtifact): void {
  into.publishCount += from.publishCount;
  into.firstAt = minIso(into.firstAt, from.firstAt);
  into.lastPublishAt = maxIso(into.lastPublishAt, from.lastPublishAt);
  into.seenAt = maxIso(into.seenAt, from.seenAt);
  if (from.titleRank > into.titleRank || (from.titleRank === into.titleRank && later(from.titleAt, into.titleAt) && from.title)) {
    into.title = from.title;
    into.titleRank = from.titleRank;
    into.titleAt = from.titleAt;
  }
  for (const [s, at] of Object.entries(from.publishers)) note(into.publishers, s, at);
  for (const [s, at] of Object.entries(from.mentioners)) note(into.mentioners, s, at);
}

/** Folds events into `state` (mutates it). Returns true when anything changed. */
export function applyEvents(state: ArtifactsState, events: readonly ArtifactEvent[]): boolean {
  for (const e of events) {
    const rawId = artifactIdOf(e.url);
    const id = state.aliases[rawId.toLowerCase()] ?? rawId;
    if (e.kind === "publish" && e.uuid && e.uuid !== id.toLowerCase() && state.aliases[e.uuid] !== id) {
      state.aliases[e.uuid] = id;
      const dup = Object.values(state.items).find((i) => i.id.toLowerCase() === e.uuid);
      if (dup) {
        absorb((state.items[id] ??= blank(id, e.url)), dup);
        delete state.items[dup.id];
      }
    }
    const item = (state.items[id] ??= blank(id, e.url));
    item.firstAt = minIso(item.firstAt, e.at);
    item.seenAt = maxIso(item.seenAt, e.at);
    if (e.kind === "publish") {
      if (!e.hint) item.publishCount += 1;
      item.lastPublishAt = maxIso(item.lastPublishAt, e.at);
      note(item.publishers, e.sessionId, e.at);
      if (!e.url.includes("/code/")) item.url = e.url; // the short link beats the /code/<uuid> one
      if (e.title && (item.titleRank < 2 || later(e.at, item.titleAt))) Object.assign(item, { title: e.title, titleRank: 2, titleAt: e.at });
      if (e.path && later(e.at, item.sourceAt)) Object.assign(item, { sourcePath: e.path, sourceAt: e.at });
    } else if (e.kind === "mention") {
      note(item.mentioners, e.sessionId, e.at);
      if (e.title && item.titleRank < 1 && (item.titleRank < MENTION_TITLE_RANK || later(e.at, item.titleAt))) Object.assign(item, { title: e.title, titleRank: MENTION_TITLE_RANK, titleAt: e.at });
    } else if (e.title && item.titleRank < 2 && (item.titleRank < 1 || later(e.at, item.titleAt))) {
      Object.assign(item, { title: e.title, titleRank: 1, titleAt: e.at });
    }
  }
  return events.length > 0;
}

const newestFirst = (m: Record<string, string>): string[] => Object.keys(m).sort((a, b) => (m[b] ?? "").localeCompare(m[a] ?? "") || a.localeCompare(b));

/** Whether a persisted item is a real artifact. Junk indexed before the id rule was tight (test
 *  placeholders, truncated ids) stays in world.db but is never served. */
export const isServable = (s: Pick<StoredArtifact, "id">): boolean => isRealArtifactId(s.id);

/** The wire item. `islandOf` maps a session id to its home island (null when not indexed). */
export function toItem(s: StoredArtifact, islandOf: (sessionId: string) => string | null, hasPreview: boolean): ArtifactItem {
  const published = Object.keys(s.publishers).length > 0;
  const sessions = newestFirst(published ? s.publishers : s.mentioners);
  return {
    id: s.id,
    url: s.url,
    title: s.title,
    origin: published ? "published" : "referenced",
    islandId: published && sessions[0] ? islandOf(sessions[0]) : null,
    sessions,
    firstAt: s.firstAt,
    lastAt: published ? (s.lastPublishAt ?? s.seenAt) : s.seenAt,
    publishCount: published ? Math.max(1, s.publishCount) : 0,
    hasPreview,
  };
}
