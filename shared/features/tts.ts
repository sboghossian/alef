// Types for the "tts" feature: POST /api/tts {text} -> streamed audio (ElevenLabs) or 503.
// The route itself returns raw audio bytes, not JSON, so there is no response type here.

export interface TtsRequest {
  text: string; // 1..2000 chars
}
