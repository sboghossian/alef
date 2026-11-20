// POST /api/tts — text-to-speech. Default engine: Piper, fully local (server/features/piper.ts,
// British male voice en_GB-northern_english_male-medium), answered as audio/wav. ElevenLabs (streamed) is used only
// when Piper isn't installed and ELEVENLABS_API_KEY is set, or when ALEF_TTS_ENGINE=elevenlabs.
// 503 when neither is available (the client then falls back to the browser's speechSynthesis).
// The ElevenLabs key is read once per request from the environment and never logged or echoed back.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { TtsRequest } from "../../shared/features/tts.js";
import { isRecord, readJsonBody } from "../http.js";
import { piperEnabled, piperEngine, voiceTmpDir } from "./piper.js";
import type { ServerFeature } from "./registry.js";
import { speakable } from "./voice-lib.js";

const ELEVENLABS_MODEL = "eleven_flash_v2_5";
// ElevenLabs premade voice "Rachel" — used only when ELEVENLABS_VOICE_ID is unset.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const MAX_TEXT_CHARS = 2000;

export type TtsFetch = typeof fetch;
export type TtsEngineName = "piper" | "elevenlabs";

export interface SynthesizeOptions {
  apiKey?: string;
  voiceId?: string;
  fetchImpl?: TtsFetch;
}

export function elevenLabsAvailable(apiKey: string | undefined = process.env.ELEVENLABS_API_KEY): boolean {
  return typeof apiKey === "string" && apiKey.length > 0;
}

/** Which engine /api/tts uses right now, or null (→ the browser voice). */
export function ttsEngine(): TtsEngineName | null {
  const piper = piperEnabled();
  const eleven = elevenLabsAvailable();
  if (process.env.ALEF_TTS_ENGINE === "elevenlabs" && eleven) return "elevenlabs";
  if (piper) return "piper";
  return eleven ? "elevenlabs" : null;
}

/** Calls ElevenLabs' streaming endpoint. Returns the raw Response so the route can
 *  pipe its body straight through; never logs `apiKey`. */
export async function synthesizeSpeech(text: string, options: SynthesizeOptions = {}): Promise<Response> {
  const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
  const voiceId = options.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  return fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/mpeg", "xi-api-key": apiKey },
    body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
  });
}

/** Piper → wav bytes via a temp file under data/voice-tmp (always deleted). */
export async function synthesizePiperWav(text: string, tmpDir: string): Promise<Buffer> {
  await mkdir(tmpDir, { recursive: true });
  const out = join(tmpDir, `tts-${randomUUID()}.wav`);
  try {
    await piperEngine.synthesize(text, out);
    return await readFile(out);
  } finally {
    await rm(out, { force: true });
  }
}

export const ttsFeature: ServerFeature = {
  id: "tts",
  routes: [
    {
      method: "POST",
      path: "/api/tts",
      async handler(req, res, ctx) {
        const engine = ttsEngine();
        if (!engine) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no speech engine: Piper isn't installed and ELEVENLABS_API_KEY is not set" }));
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        const text = isRecord(body) && typeof body.text === "string" ? (body.text as TtsRequest["text"]) : null;
        if (text === null || text.length < 1 || text.length > MAX_TEXT_CHARS) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `text must be 1..${MAX_TEXT_CHARS} characters` }));
          return;
        }
        if (engine === "piper") {
          const say = speakable(text);
          try {
            const wav = await synthesizePiperWav(say || text, voiceTmpDir(ctx.config.dbPath));
            res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "cache-control": "no-store" });
            res.end(wav);
          } catch (err) {
            ctx.log.error("tts", "piper synthesis failed", String(err));
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "speech synthesis failed" }));
          }
          return;
        }
        try {
          const upstream = await synthesizeSpeech(text);
          if (!upstream.ok || !upstream.body) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `elevenlabs responded ${upstream.status}` }));
            return;
          }
          res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "audio/mpeg" });
          Readable.fromWeb(upstream.body as never).pipe(res);
        } catch (err) {
          ctx.log.error("tts", "synthesis failed", String(err));
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "speech synthesis failed" }));
        }
      },
    },
  ],
  snapshotExtras() {
    const engine = ttsEngine();
    return { "tts.available": engine !== null, "tts.engine": engine };
  },
};
