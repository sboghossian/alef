// Types shared by the client "voice" feature and the moon's voice-state visuals
// (client/src/scene/moon.ts). No server contract: TTS audio itself is plain bytes
// (see shared/features/tts.ts), and speech recognition never leaves the browser.

export type MoonVoiceState = "idle" | "listening" | "thinking" | "speaking";

export const VAD_PRESETS = { snappy: 800, normal: 1500, patient: 2500 } as const;
export type VadPreset = keyof typeof VAD_PRESETS;
