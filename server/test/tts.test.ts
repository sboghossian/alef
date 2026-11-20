import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningServer } from "../index.js";
import { elevenLabsAvailable, synthesizeSpeech, ttsFeature, type TtsFetch } from "../features/tts.js";
import { bootTestServer } from "./helpers.js";

describe("elevenLabsAvailable", () => {
  it("is false for undefined/empty, true for a non-empty key", () => {
    expect(elevenLabsAvailable(undefined)).toBe(false);
    expect(elevenLabsAvailable("")).toBe(false);
    expect(elevenLabsAvailable("sk-test")).toBe(true);
  });
});

describe("synthesizeSpeech", () => {
  it("posts the streaming endpoint with the model, voice and key — never text in a header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: TtsFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    }) as TtsFetch;

    await synthesizeSpeech("hello jev", { apiKey: "secret-key", voiceId: "voice-42", fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-42/stream");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("secret-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "hello jev", model_id: "eleven_flash_v2_5" });
  });

  it("falls back to the default premade voice when none is configured", async () => {
    const fetchImpl: TtsFetch = (async (url: string) => {
      expect(url).toContain("/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream");
      return { ok: true, status: 200 } as Response;
    }) as TtsFetch;
    await synthesizeSpeech("hi", { apiKey: "k", fetchImpl });
  });
});

describe("POST /api/tts", () => {
  let server: RunningServer | null = null;

  // These cover the ElevenLabs path: Piper (the local default) is switched off so a host
  // with .venv-piper installed behaves like one without it.
  beforeEach(() => {
    vi.stubEnv("ALEF_PIPER", "0");
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("503s when neither Piper nor ELEVENLABS_API_KEY is available, without reading the body", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [ttsFeature] } });
    server = s;

    const res = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(503);
  });

  it("400s on a missing/oversized text field once a key is present", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [ttsFeature] } });
    server = s;

    const empty = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(empty.status).toBe(400);

    const tooLong = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(2001) }),
    });
    expect(tooLong.status).toBe(400);
  });

  it("streams the upstream audio body through on success", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    // Stub only the ElevenLabs call; every other fetch (including this test's own
    // requests to the local test server) goes through the real implementation.
    const realFetch = globalThis.fetch;
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes("elevenlabs.io")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "audio/mpeg" }),
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(audioBytes);
                controller.close();
              },
            }),
          } as unknown as Response;
        }
        return realFetch(url, init);
      }),
    );
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [ttsFeature] } });
    server = s;

    const res = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello jev" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it("502s when the upstream call fails", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes("elevenlabs.io")) throw new Error("network down");
        return realFetch(url, init);
      }),
    );
    const { base, server: s } = await bootTestServer({ configOverrides: { features: [ttsFeature] } });
    server = s;

    const res = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello jev" }),
    });
    expect(res.status).toBe(502);
  });
});
