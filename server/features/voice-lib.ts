// Pure helpers for Alef's local voice: the ffmpeg / whisper-cli / Piper argv (never a shell
// string), whisper model resolution, transcript cleanup, audio sniffing, and the sentence
// splitter that lets Piper start speaking the first sentence while claude is still writing.
// Impure glue: server/features/voice-brain.ts (routes) and server/features/piper.ts (worker).
//
// Measured on this Mac (M-series, 2026-09-26): whisper-cli base.en ≈ 0.6 s and small.en ≈ 0.6–1.1 s
// on a 3 s utterance; base.en is the default (ALEF_WHISPER_MODEL overrides).

import { homedir } from "node:os";
import { join } from "node:path";

export const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";
export const WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";

// ── STT ───────────────────────────────────────────────────────────────────

/** Any browser recording → 16 kHz mono 16-bit wav, capped at `maxSeconds`. */
export function ffmpegArgs(input: string, output: string, maxSeconds: number): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-t", String(maxSeconds), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output];
}

/** whisper-cli on one wav: English, plain text on stdout (no timestamps, no progress). */
export function whisperArgs(model: string, wav: string, threads = 4): string[] {
  return ["-m", model, "-f", wav, "-l", "en", "-nt", "-np", "-t", String(Math.max(1, Math.floor(threads)))];
}

/** Candidate model paths, best first. `override` (ALEF_WHISPER_MODEL) always wins when set. */
export function whisperModelCandidates(override: string | undefined, home = homedir()): string[] {
  const names = ["ggml-base.en.bin", "ggml-small.en.bin"];
  const dirs = ["/opt/homebrew/share/whisper-cpp", join(home, ".cache", "whisper-cpp")];
  const out: string[] = [];
  if (override && override.trim()) out.push(override.trim());
  for (const n of names) for (const d of dirs) out.push(join(d, n));
  return out;
}

/** First candidate that exists, or null. */
export function resolveWhisperModel(candidates: readonly string[], exists: (p: string) => boolean): string | null {
  return candidates.find((p) => exists(p)) ?? null;
}

/** whisper stdout → one clean line: drops [BLANK_AUDIO]/(music)-style tags and whitespace. */
export function cleanTranscript(stdout: string): string {
  return stdout
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:music|silence|applause|laughter|inaudible|background noise|noise|static)[^)]*\)/gi, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AudioKind = "webm" | "ogg" | "wav" | "mp4" | "mp3";

/** The container from magic bytes (the browser's content-type is never trusted). */
export function sniffAudio(b: Buffer): AudioKind | null {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.length >= 4 && b.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE") return "wav";
  if (b.length >= 8 && b.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  if (b.length >= 3 && (b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))) return "mp3";
  return null;
}

// ── TTS (Piper) ───────────────────────────────────────────────────────────

export const DEFAULT_PIPER_VOICE = "en_GB-northern_english_male-medium";

export interface PiperPaths {
  python: string;
  script: string;
  model: string;
}

/** Where the venv, the worker script and the voice live, relative to the repo root. */
export function piperPaths(repoRoot: string, voice = DEFAULT_PIPER_VOICE): PiperPaths {
  const safe = /^[A-Za-z0-9_.-]+$/.test(voice) ? voice : DEFAULT_PIPER_VOICE;
  return {
    python: join(repoRoot, ".venv-piper", "bin", "python"),
    script: join(repoRoot, "scripts", "piper-worker.py"),
    model: join(repoRoot, "data", "piper", `${safe}.onnx`),
  };
}

/** argv for the persistent worker (python is the executable). */
export function piperWorkerArgs(p: PiperPaths): string[] {
  return [p.script, "--model", p.model];
}

/** One stdin line for the worker. */
export function piperRequestLine(id: string, text: string, out: string): string {
  return `${JSON.stringify({ id, text, out })}\n`;
}

/** Text Piper should say: markdown and emoji stripped, whitespace collapsed. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── sentences ─────────────────────────────────────────────────────────────

const ABBREV = /(?:^|\s)(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|no)\.$/i;

/** Index just past the end of the first complete sentence in `s`, or -1. A sentence ends at
 *  . ! ? … (plus closing quotes/brackets) followed by whitespace, or at a newline. "3.5",
 *  "e.g." and "Mr." never end one. The final unterminated tail is NOT complete (see flush). */
function firstBoundary(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") return i + 1;
    if (c === "." || c === "!" || c === "?" || c === "…") {
      let j = i + 1;
      while (j < s.length && /[.!?…"'”’)\]]/.test(s[j] ?? "")) j++;
      if (j >= s.length) return -1; // might continue ("3." + "5")
      if (!/\s/.test(s[j] ?? "")) continue;
      if (c === "." && ABBREV.test(s.slice(0, i + 1))) continue;
      return j;
    }
  }
  return -1;
}

/** Splits streamed text into sentences as it arrives. */
export class SentenceStreamer {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const end = firstBoundary(this.buf);
      if (end < 0) break;
      const s = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (s) out.push(s);
    }
    return out;
  }

  flush(): string[] {
    const s = this.buf.trim();
    this.buf = "";
    return s ? [s] : [];
  }
}

/** Whole-text convenience wrapper. */
export function splitSentences(text: string): string[] {
  const st = new SentenceStreamer();
  return [...st.push(text), ...st.flush()];
}
