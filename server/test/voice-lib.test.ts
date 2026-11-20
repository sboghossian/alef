import { describe, expect, it } from "vitest";
import {
  cleanTranscript,
  DEFAULT_PIPER_VOICE,
  ffmpegArgs,
  piperPaths,
  piperRequestLine,
  piperWorkerArgs,
  resolveWhisperModel,
  SentenceStreamer,
  sniffAudio,
  speakable,
  splitSentences,
  whisperArgs,
  whisperModelCandidates,
} from "../features/voice-lib.js";

describe("STT argv", () => {
  it("ffmpeg converts any input to 16 kHz mono s16 wav, capped, never reading stdin", () => {
    const a = ffmpegArgs("/d/in.webm", "/d/out.wav", 60);
    expect(a).toEqual(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", "/d/in.webm", "-t", "60", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "/d/out.wav"]);
  });

  it("keeps hostile-looking paths as single argv entries (no shell)", () => {
    const a = ffmpegArgs("/d/x; rm -rf ~.webm", "/d/o.wav", 5);
    expect(a).toContain("/d/x; rm -rf ~.webm");
  });

  it("whisper-cli: model, file, English, text only, clamped threads", () => {
    expect(whisperArgs("/m/base.bin", "/d/a.wav")).toEqual(["-m", "/m/base.bin", "-f", "/d/a.wav", "-l", "en", "-nt", "-np", "-t", "4"]);
    expect(whisperArgs("/m", "/a", 0)).toContain("1");
    expect(whisperArgs("/m", "/a", 3.7)).toContain("3");
  });
});

describe("whisper model resolution", () => {
  it("prefers the override, then base.en before small.en, homebrew before the cache", () => {
    const c = whisperModelCandidates(" /x/custom.bin ", "/home/u");
    expect(c[0]).toBe("/x/custom.bin");
    expect(c.slice(1)).toEqual([
      "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
      "/home/u/.cache/whisper-cpp/ggml-base.en.bin",
      "/opt/homebrew/share/whisper-cpp/ggml-small.en.bin",
      "/home/u/.cache/whisper-cpp/ggml-small.en.bin",
    ]);
  });

  it("ignores an empty override and returns null when nothing exists", () => {
    expect(whisperModelCandidates("", "/h")[0]).toBe("/opt/homebrew/share/whisper-cpp/ggml-base.en.bin");
    expect(resolveWhisperModel(whisperModelCandidates(undefined, "/h"), () => false)).toBeNull();
    expect(resolveWhisperModel(["/a", "/b"], (p) => p === "/b")).toBe("/b");
  });
});

describe("cleanTranscript", () => {
  it("drops whisper's non-speech tags and collapses whitespace", () => {
    expect(cleanTranscript(" [BLANK_AUDIO]\n Hey Alef,  how many\n agents? (music) ")).toBe("Hey Alef, how many agents?");
    expect(cleanTranscript("*coughs* hello [ Silence ]")).toBe("hello");
  });
  it("is empty for silence-only or empty output", () => {
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript("")).toBe("");
  });
});

describe("sniffAudio", () => {
  it("recognizes webm, ogg, wav, mp4 and mp3 by magic bytes", () => {
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe("webm");
    expect(sniffAudio(Buffer.from("OggS\0\0"))).toBe("ogg");
    expect(sniffAudio(Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBe("wav");
    expect(sniffAudio(Buffer.from("\0\0\0\x18ftypM4A "))).toBe("mp4");
    expect(sniffAudio(Buffer.from("ID3\x04"))).toBe("mp3");
  });
  it("rejects text, images and empty buffers", () => {
    expect(sniffAudio(Buffer.from("hello world"))).toBeNull();
    expect(sniffAudio(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffAudio(Buffer.alloc(0))).toBeNull();
  });
});

describe("Piper argv", () => {
  it("points at the repo venv, the worker script and the voice model", () => {
    const p = piperPaths("/repo");
    expect(p).toEqual({ python: "/repo/.venv-piper/bin/python", script: "/repo/scripts/piper-worker.py", model: `/repo/data/piper/${DEFAULT_PIPER_VOICE}.onnx` });
    expect(piperWorkerArgs(p)).toEqual(["/repo/scripts/piper-worker.py", "--model", "/repo/data/piper/en_GB-northern_english_male-medium.onnx"]);
  });
  it("refuses a voice name that could escape data/piper", () => {
    expect(piperPaths("/repo", "../../etc/passwd").model).toBe("/repo/data/piper/en_GB-northern_english_male-medium.onnx");
    expect(piperPaths("/repo", "en_GB-northern_english_male-medium").model).toBe("/repo/data/piper/en_GB-northern_english_male-medium.onnx");
  });
  it("encodes one request per line as JSON (newlines in text can't split it)", () => {
    const line = piperRequestLine("r1", "Hello.\nSecond line", "/t/a.wav");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ id: "r1", text: "Hello.\nSecond line", out: "/t/a.wav" });
  });
});

describe("speakable", () => {
  it("strips markdown, links, code and emoji", () => {
    expect(speakable("**Four** agents are `live` 🎉 — see [the board](http://x)")).toBe("Four agents are live — see the board");
    expect(speakable("# Title\n```js\ncode()\n```\nDone.")).toBe("Title Done.");
    expect(speakable("")).toBe("");
  });
});

describe("sentences", () => {
  it("splits on terminal punctuation followed by space, and on newlines", () => {
    expect(splitSentences("Three agents are live. One is waiting! Shall I?")).toEqual(["Three agents are live.", "One is waiting!", "Shall I?"]);
    expect(splitSentences("Line one\nLine two")).toEqual(["Line one", "Line two"]);
  });

  it("never splits decimals, abbreviations or e.g.", () => {
    expect(splitSentences("You used 3.5 million tokens. Mr. Pope agrees, e.g. today.")).toEqual(["You used 3.5 million tokens.", "Mr. Pope agrees, e.g. today."]);
  });

  it("keeps closing quotes with their sentence", () => {
    expect(splitSentences('He said "done." Then left.')).toEqual(['He said "done."', "Then left."]);
  });

  it("streams: a sentence is released only once it's complete, the tail on flush", () => {
    const st = new SentenceStreamer();
    expect(st.push("Four agents")).toEqual([]);
    expect(st.push(" are live")).toEqual([]);
    expect(st.push(". Tw")).toEqual(["Four agents are live."]);
    expect(st.push("o are wai")).toEqual([]);
    expect(st.push("ting.")).toEqual([]); // "." at the very end could still be "3." + "5"
    expect(st.flush()).toEqual(["Two are waiting."]);
    expect(st.flush()).toEqual([]);
  });

  it("a split decimal across deltas stays one sentence", () => {
    const st = new SentenceStreamer();
    expect(st.push("About 3.")).toEqual([]);
    expect(st.push("5 million. Next")).toEqual(["About 3.5 million."]);
    expect(st.flush()).toEqual(["Next"]);
  });

  it("empty and whitespace-only input yields nothing", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("  \n \n")).toEqual([]);
  });
});
