// Wire types for the "chat" feature (round 10 §1): the Room's screen opens a chat panel driven by
// the owner's own `claude` CLI in headless stream-json mode (Max plan login, no API key). One
// `claude -p` process per turn: `--resume <sessionId>` + `--model`, so the model can change
// per message. Events stream to the client over the WS feature channel.
//
//   GET  /api/chat/list                 → { ok: true, chats: ChatView[] }
//   POST /api/chat/open                 ChatOpenRequest → ChatOpenResult
//   GET  /api/chat/:chatId              → ChatOpenResult (the chat + its recent events)
//   POST /api/chat/:chatId/turn         ChatTurnRequest → ChatActionResult
//   POST /api/chat/:chatId/stop         → ChatActionResult (SIGINT, then SIGTERM, the turn's child only)
//
// WS (feature "chat"): ChatMessage.

export type ChatModel = "opus" | "sonnet" | "haiku";
export type ChatMode = "normal" | "plan" | "acceptEdits";

export const CHAT_MODELS: readonly ChatModel[] = ["opus", "sonnet", "haiku"];
export const CHAT_MODES: readonly ChatMode[] = ["normal", "plan", "acceptEdits"];

export const CHAT_MAX_TEXT = 20_000;
export const CHAT_MAX_ATTACHMENTS = 4;
/** Per attachment, decoded bytes. */
export const CHAT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface ChatAttachmentUpload {
  name: string;
  /** The browser's type; the server re-checks it (magic bytes for images, UTF-8 for text). */
  mime: string;
  dataBase64: string;
}

export interface ChatOpenRequest {
  /** Continue this session (an agent id = its session uuid)… */
  agentId?: string;
  /** …or start a new chat in this city. */
  islandId?: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ChatView {
  id: string;
  /** Session the next turn resumes; null until a new chat's first turn has run. */
  sessionId: string | null;
  /** The agent this chat was opened on (null = new chat in a city). */
  originAgentId: string | null;
  islandId: string;
  cwd: string;
  title: string;
  createdAt: string; // ISO
  running: boolean;
  turns: number;
  /** Summed per-turn `usage` from each result event (per-turn only, as Claude reports it). */
  usage: ChatUsage;
  /** Latest result's total_cost_usd: the WHOLE session's running total (earlier spend included on resume). */
  sessionCostUsd: number | null;
  /** True when the origin agent was live elsewhere and the chat continued it on a fork. */
  forked: boolean;
}

export interface ChatOpenResult {
  ok: boolean;
  chat?: ChatView;
  events?: ChatEvent[];
  /** True when the session is open in a terminal / VS Code right now (the client warns before sending). */
  liveElsewhere?: boolean;
  error?: string;
}

export interface ChatTurnRequest {
  text: string;
  attachments?: ChatAttachmentUpload[];
  model: ChatModel;
  mode: ChatMode;
  /** The user accepted "continuing here creates a fork". Required when the session is live elsewhere. */
  forkAcknowledged?: boolean;
}

export interface ChatActionResult {
  ok: boolean;
  error?: string;
}

export interface ChatToolChip {
  id: string;
  name: string;
  /** Short, sanitized one-liner (command, path, pattern…). Render as text. */
  summary: string;
}

/** One normalized stream event. Everything is plain text: the client renders with textContent. */
export type ChatEvent =
  | { kind: "user"; text: string; attachments: string[]; model: ChatModel; mode: ChatMode }
  | { kind: "init"; sessionId: string; model: string }
  | { kind: "text-delta"; text: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool"; tool: ChatToolChip }
  | { kind: "tool-result"; toolUseId: string; isError: boolean; preview: string }
  | { kind: "denied"; toolName: string; reason: string }
  | { kind: "retry"; attempt: number; error: string }
  | { kind: "result"; ok: boolean; subtype: string; text: string; costUsd: number | null; usage: ChatUsage; durationMs: number | null; denials: string[] }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string };

export type ChatMessage =
  | { kind: "event"; chatId: string; event: ChatEvent }
  | { kind: "chat"; chat: ChatView };

/** Router contract (owned by the router package). 404 = no advice yet. */
export interface RouterRouteResult {
  ok: boolean;
  model: ChatModel | null;
  why: string;
  notes: { path: string; title: string; why: string }[];
  ms: number;
  error?: string;
}
