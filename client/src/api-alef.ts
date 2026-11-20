// Typed client helpers for the Round 7 (Alef) backend: term, control, code, brain, shelf,
// automations, feed. Every call resolves (never throws), like api.ts.

import type { ProjectIndexResponse } from "../../shared/features/project-page";
import type { AutomationRunResult, AutomationsResponse } from "../../shared/features/automations";
import type { BrainBacklinksResponse, BrainGraphResponse, BrainNoteResponse, BrainSearchResponse } from "../../shared/features/brain";
import type { CodeDiffResponse, CodeFileResponse, CodeStatusResponse, CodeTouchedResponse, CodeTreeResponse } from "../../shared/features/code";
import type { ControlResult } from "../../shared/features/control";
import type { FeedResponse } from "../../shared/features/feed";
import type { ShelfResponse } from "../../shared/features/shelf";
import type { VaultSearchResponse } from "../../shared/features/vault";
import { getJson, postJson } from "./api";

const enc = encodeURIComponent;

// ── control ────────────────────────────────────────────────────────────────
export function interruptAgent(agentId: string, hard = false): Promise<ControlResult> {
  return postJson<ControlResult>(`/api/agents/${enc(agentId)}/interrupt${hard ? "?hard=1" : ""}`, {}, (error) => ({ ok: false, error }));
}

export function noteAgent(agentId: string, text: string): Promise<ControlResult> {
  return postJson<ControlResult>(`/api/agents/${enc(agentId)}/note`, { text }, (error) => ({ ok: false, error }));
}

// ── code (read-only) ───────────────────────────────────────────────────────
export const codeTree = (agentId: string, path = ""): Promise<CodeTreeResponse | null> =>
  getJson<CodeTreeResponse>(`/api/code/${enc(agentId)}/tree?path=${enc(path)}`);
export const codeFile = (agentId: string, path: string): Promise<CodeFileResponse | null> =>
  getJson<CodeFileResponse>(`/api/code/${enc(agentId)}/file?path=${enc(path)}`);
export const codeTouched = (agentId: string): Promise<CodeTouchedResponse | null> => getJson<CodeTouchedResponse>(`/api/code/${enc(agentId)}/touched`);
export const codeDiff = (agentId: string, path: string): Promise<CodeDiffResponse | null> =>
  getJson<CodeDiffResponse>(`/api/code/${enc(agentId)}/diff?path=${enc(path)}`);
export const codeStatus = (agentId: string): Promise<CodeStatusResponse | null> => getJson<CodeStatusResponse>(`/api/code/${enc(agentId)}/status`);

// ── brain (read-only vault) ────────────────────────────────────────────────
export const projectIndex = (): Promise<ProjectIndexResponse | null> => getJson<ProjectIndexResponse>("/api/project-page", 8_000);
export const vaultSearch = (q: string): Promise<VaultSearchResponse | null> => getJson<VaultSearchResponse>(`/api/vault/search?q=${enc(q)}`, 5_000);
export const brainGraph = (limit = 1500): Promise<BrainGraphResponse | null> => getJson<BrainGraphResponse>(`/api/brain/graph?limit=${limit}`);
export const brainNote = (path: string): Promise<BrainNoteResponse | null> => getJson<BrainNoteResponse>(`/api/brain/note?path=${enc(path)}`);
export const brainBacklinks = (path: string): Promise<BrainBacklinksResponse | null> =>
  getJson<BrainBacklinksResponse>(`/api/brain/backlinks?path=${enc(path)}`);
export const brainSearch = (q: string, limit = 20): Promise<BrainSearchResponse | null> =>
  getJson<BrainSearchResponse>(`/api/brain/search?q=${enc(q)}&limit=${limit}`);

// ── shelf ──────────────────────────────────────────────────────────────────
export const shelf = (agentId: string): Promise<ShelfResponse | null> => getJson<ShelfResponse>(`/api/shelf/${enc(agentId)}`);

/** URL for an <iframe sandbox> / <img>: the server adds a strict CSP (no scripts). */
export function shelfPreviewUrl(absPath: string, agentId?: string): string {
  return `/api/shelf/preview?path=${enc(absPath)}${agentId ? `&agentId=${enc(agentId)}` : ""}`;
}

// ── automations ────────────────────────────────────────────────────────────
export const automations = (): Promise<AutomationsResponse | null> => getJson<AutomationsResponse>("/api/automations");

/** Only call after the user confirmed in the UI. A "dispatch" result carries a command for the prompt box. */
export function runAutomation(id: string): Promise<AutomationRunResult> {
  return postJson<AutomationRunResult>(`/api/automations/${enc(id)}/run`, { confirm: true }, (error) => ({ ok: false, error }));
}

// ── feed ───────────────────────────────────────────────────────────────────
export const feedSince = (since = 0, limit = 200): Promise<FeedResponse | null> => getJson<FeedResponse>(`/api/feed?since=${since}&limit=${limit}`);

// ── term ───────────────────────────────────────────────────────────────────
/** WebSocket URL for a live terminal; messages are TermClientMessage / TermServerMessage (shared/features/term). */
export function termSocketUrl(agentId: string, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/term/${enc(agentId)}?cols=${cols}&rows=${rows}`;
}
