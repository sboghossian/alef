// Types for the "voice-brain" feature: talking to Alef, fully local.
//   POST /api/voice/transcribe   VoiceTranscribeRequest (webm/ogg/mp4/wav, ≤10 MB, ≤60 s) → VoiceTranscribeResult
//   POST /api/voice/turn         VoiceTurnRequest → NDJSON stream of VoiceTurnEvent (one JSON per line)
//   GET  /api/voice/audio/:id    one synthesized sentence (audio/wav), kept ~2 min
// Hearing = whisper.cpp, brain = the owner's own `claude` CLI (Haiku; "think harder" → Sonnet),
// voice = Piper. The server NEVER runs a mutating action: it only proposes one; the client reads
// it back and runs it after a spoken "yes" or a click (client/src/features/voice-logic.ts).

export const VOICE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_AUDIO_SECONDS = 60;
export const VOICE_MAX_TURN_CHARS = 1000;
/** A pending "Shall I…?" expires after this long without a yes. */
export const VOICE_CONFIRM_TTL_MS = 30_000;

/** JSON, because the hub's CSRF guard only admits application/json POSTs. */
export interface VoiceTranscribeRequest {
  audioBase64: string;
}

export type VoiceTranscribeResult = { ok: true; text: string; ms: number; model: string } | { ok: false; error: string };

export interface VoiceTurnRequest {
  /** Random per page load; keys the server's short rolling conversation. */
  clientId: string;
  text: string;
}

export const VOICE_VIEW_IDS = ["orbit", "district", "room", "courier", "canvas", "board", "voice", "code", "brain", "health"] as const;
export type VoiceViewId = (typeof VOICE_VIEW_IDS)[number];

export const VOICE_MAC_APP_ACTIONS = ["open", "focus", "hide", "quit"] as const;
export const VOICE_MAC_SYSTEM_ACTIONS = ["play-pause", "next", "prev", "mute", "volume", "screenshot", "lock"] as const;

/** One validated, resolved action. Read-only kinds run at once; the rest need a yes. */
export type VoiceSimpleAction =
  | { type: "open_view"; view: VoiceViewId }
  | { type: "fly_to_agent"; agentId: string; title: string }
  | { type: "open_room"; agentId: string; title: string }
  | { type: "dispatch_session"; islandId: string; city: string; prompt: string }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "mac_action"; kind: "app"; action: (typeof VOICE_MAC_APP_ACTIONS)[number]; app: string }
  | { type: "mac_action"; kind: "system"; action: (typeof VOICE_MAC_SYSTEM_ACTIONS)[number]; value?: number };

/** A plan step: any simple action but approve/deny (each is bound to the one approval read back). */
export type VoicePlanStep = Exclude<VoiceSimpleAction, { type: "approve" } | { type: "deny" }>;
export const VOICE_PLAN_MAX_STEPS = 4;
export const VOICE_REMEMBER_MAX_TITLE = 80;
/** The whole body is read back before the 30 s yes window closes, so it stays short. */
export const VOICE_REMEMBER_MAX_BODY = 240;

/** Every action Alef may propose. "plan": 2-4 steps read back together, then run all after one
 *  yes, or step by step with a yes each. "remember": a note staged after a yes (never memory). */
export type VoiceAction = VoiceSimpleAction | { type: "plan"; steps: VoicePlanStep[] } | { type: "remember"; title: string; body: string };

/** POST /api/voice/remember (sent by the client only after his yes): appends to the staging note. */
export interface VoiceRememberRequest {
  title: string;
  body: string;
}
export type VoiceRememberResult = { ok: true; file: string } | { ok: false; error: string };

export type VoiceActionType = VoiceAction["type"];
export const VOICE_READ_ONLY_ACTIONS: readonly VoiceActionType[] = ["open_view", "fly_to_agent", "open_room"];

export interface VoiceTurnTimings {
  /** turn start → first text token (deep mode: its final answer). */
  firstTokenMs: number | null;
  /** turn start → first sentence's audio ready on the server. */
  firstAudioMs: number | null;
  totalMs: number;
  /** turn start → first sentence sent (audio or not). */
  firstSentenceMs?: number | null;
  /** The always-on retrieval before the model call (null when retrieval is off). */
  retrievalMs?: number | null;
}

/** "fast": one stripped-down call with retrieved snippets. "deep": a read-only lookup with
 *  Read/Grep/Glob (he asked for one). "fast+deep": the fast brain answered LOOKUP, so Alef looked. */
export type VoiceBrainMode = "fast" | "deep" | "fast+deep";

export type VoiceTurnEvent =
  | { type: "sentence"; index: number; text: string; audioUrl: string | null }
  /** A validated action. A refused/unresolvable one arrives as a spoken sentence instead. */
  | { type: "action"; action: VoiceAction }
  | { type: "done"; ok: boolean; model: string; text: string; timings: VoiceTurnTimings; mode?: VoiceBrainMode; costUsd?: number | null; error?: string };
