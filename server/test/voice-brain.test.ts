import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceTurnEvent } from "../../shared/features/voice-brain.js";
import type { RunningServer } from "../index.js";
import type { PiperEngine } from "../features/piper.js";
import { createVoiceBrainFeature, decodeAudioBody, transcribe, type RunResult, type VoiceDeps } from "../features/voice-brain.js";
import type { VoiceRecall } from "../features/voice-brain-recall.js";
import { STAGING_FILE } from "../features/voice-remember-lib.js";
import { bootTestServer } from "./helpers.js";

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);

interface Calls {
  run: { bin: string; args: string[] }[];
  spawn: { args: string[]; cwd: string; env: Record<string, string>; stdin: string }[];
  synth: string[];
}

function fakePiper(calls: Calls): PiperEngine {
  return {
    available: () => true,
    voice: () => "test-voice",
    close: () => undefined,
    async synthesize(text, out) {
      calls.synth.push(text);
      await writeFile(out, Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE"), Buffer.from(text)]));
    },
  };
}

/** A stand-in `claude`: a real node child that prints canned stream-json lines. */
function fakeClaude(calls: Calls, reply: string[], opts: { exitCode?: number } = {}): VoiceDeps["claude"] {
  return {
    findClaude: async () => "/fake/claude",
    spawn(_bin, args, cwd, env) {
      const rec = { args: [...args], cwd, env, stdin: "" };
      calls.spawn.push(rec);
      const lines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "haiku" }),
        ...reply.map((t) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } })),
        JSON.stringify({ type: "result", subtype: "success", result: reply.join(""), usage: {} }),
      ];
      const script = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stderr.write("STDIN:"+s);for(const l of ${JSON.stringify(lines)})process.stdout.write(l+"\\n");process.exit(${opts.exitCode ?? 0});});`;
      const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.on("data", (d: Buffer) => {
        rec.stdin += d.toString().replace(/^STDIN:/, "");
      });
      return child;
    },
  };
}

function deps(calls: Calls, over: Partial<VoiceDeps> = {}): VoiceDeps {
  return {
    async runFile(bin, args): Promise<RunResult> {
      calls.run.push({ bin, args: [...args] });
      if (bin.endsWith("ffmpeg")) {
        await writeFile(args[args.length - 1]!, "RIFFxxxxWAVE");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: " [BLANK_AUDIO]\n Hey Aleph, how many agents are live?\n", stderr: "" };
    },
    claude: fakeClaude(calls, ["Two agents are live, sir."]),
    piper: fakePiper(calls),
    piperOn: () => true,
    whisperModel: () => "/models/ggml-base.en.bin",
    now: Date.now,
    ...over,
  };
}

const newCalls = (): Calls => ({ run: [], spawn: [], synth: [] });

describe("transcribe (STT)", () => {
  it("converts with ffmpeg, runs whisper on the 16k wav, cleans the text, deletes every temp file", async () => {
    const { dir, server } = await bootTestServer({ configOverrides: { features: [] } });
    await server.close();
    const calls = newCalls();
    const tmp = join(dir, "voice-tmp");
    const r = await transcribe(WEBM, tmp, deps(calls));
    expect(r).toMatchObject({ ok: true, text: "Hey Aleph, how many agents are live?", model: "ggml-base.en.bin" });
    expect(calls.run[0]!.bin).toBe("/opt/homebrew/bin/ffmpeg");
    const input = calls.run[0]!.args[calls.run[0]!.args.indexOf("-i") + 1]!;
    expect(input.startsWith(tmp)).toBe(true);
    expect(input.endsWith(".webm")).toBe(true);
    expect(calls.run[1]!.bin).toBe("/opt/homebrew/bin/whisper-cli");
    expect(calls.run[1]!.args.slice(0, 4)).toEqual(["-m", "/models/ggml-base.en.bin", "-f", calls.run[0]!.args.at(-1)]);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("cleans up after an ffmpeg failure too, and reports it", async () => {
    const { dir, server } = await bootTestServer({ configOverrides: { features: [] } });
    await server.close();
    const calls = newCalls();
    const tmp = join(dir, "voice-tmp");
    const r = await transcribe(WEBM, tmp, deps(calls, { runFile: async (bin, args) => (calls.run.push({ bin, args: [...args] }), { code: 1, stdout: "", stderr: "Invalid data found" }) }));
    expect(r).toEqual({ ok: false, error: "ffmpeg failed: Invalid data found" });
    expect(calls.run).toHaveLength(1); // whisper never ran
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses non-audio and a missing model before touching the disk", async () => {
    const calls = newCalls();
    expect(await transcribe(Buffer.from("hello"), "/nonexistent/x", deps(calls))).toEqual({ ok: false, error: "not a recognizable audio file" });
    expect((await transcribe(WEBM, "/nonexistent/x", deps(calls, { whisperModel: () => null }))).ok).toBe(false);
    expect(calls.run).toEqual([]);
  });

  it("decodeAudioBody validates the JSON envelope", () => {
    expect(decodeAudioBody(Buffer.from("nope")).ok).toBe(false);
    expect(decodeAudioBody(Buffer.from(JSON.stringify({ audioBase64: "" }))).ok).toBe(false);
    expect(decodeAudioBody(Buffer.from(JSON.stringify({ audioBase64: "@@@" }))).ok).toBe(false);
    const ok = decodeAudioBody(Buffer.from(JSON.stringify({ audioBase64: WEBM.toString("base64") })));
    expect(ok.ok && ok.audio.equals(WEBM)).toBe(true);
  });
});

describe("routes", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  let dataDir = "";
  async function boot(d: VoiceDeps): Promise<string> {
    const b = await bootTestServer({ configOverrides: { features: [createVoiceBrainFeature(d)] } });
    server = b.server;
    dataDir = b.dir;
    return b.base;
  }
  const remember = (base: string, body: unknown): Promise<Response> => fetch(`${base}/api/voice/remember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function turn(base: string, text: string, clientId = "client-1"): Promise<VoiceTurnEvent[]> {
    const res = await fetch(`${base}/api/voice/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, text }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    return (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as VoiceTurnEvent);
  }

  it("POST /api/voice/transcribe takes JSON base64 and answers the text", async () => {
    const calls = newCalls();
    const base = await boot(deps(calls));
    const res = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audioBase64: WEBM.toString("base64") }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, text: "Hey Aleph, how many agents are live?" });
    const bad = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audioBase64: Buffer.from("text").toString("base64") }) });
    expect(bad.status).toBe(422);
  });

  it("a turn streams spoken sentences with audio, then done; the brain runs stripped-down with the prompt on stdin", async () => {
    const calls = newCalls();
    const base = await boot(deps(calls, { claude: fakeClaude(calls, ["Two agents are ", "live, sir. One is", " waiting."]) }));
    const events = await turn(base, "how many agents are live?");
    const sentences = events.filter((e) => e.type === "sentence");
    expect(sentences.map((s) => (s.type === "sentence" ? s.text : ""))).toEqual(["Two agents are live, sir.", "One is waiting."]);
    expect(calls.synth).toEqual(["Two agents are live, sir.", "One is waiting."]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", ok: true, model: "haiku", text: "Two agents are live, sir. One is waiting." });
    const sp = calls.spawn[0]!;
    expect(sp.args).toContain("--safe-mode");
    expect(sp.args).not.toContain("how many agents are live?");
    expect(sp.stdin).toBe("how many agents are live?");
    expect(sp.env).toEqual({ MAX_THINKING_TOKENS: "0" });
    expect(sp.cwd.endsWith("voice-brain")).toBe(true);

    // the audio is fetchable once, as wav
    const first = sentences[0];
    const url = first?.type === "sentence" ? first.audioUrl : null;
    expect(url).toMatch(/^\/api\/voice\/audio\/a-[0-9a-f]{32}$/);
    const audio = await fetch(`${base}${url}`);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect((await audio.text()).startsWith("RIFF")).toBe(true);
    expect((await fetch(`${base}/api/voice/audio/../../etc/passwd`)).status).toBe(404);

    // the next turn carries the history
    await turn(base, "and who is waiting?");
    expect(calls.spawn[1]!.stdin).toContain("User: how many agents are live?\nAlef: Two agents are live, sir. One is waiting.");
  });

  it("an allowed action arrives as an action event and is never spoken; a refused one is spoken", async () => {
    const calls = newCalls();
    const base = await boot(deps(calls, { claude: fakeClaude(calls, ['ACTION {"type":"open_view","view":"board"}']) }));
    const events = await turn(base, "open the board");
    expect(events.find((e) => e.type === "action")).toEqual({ type: "action", action: { type: "open_view", view: "board" } });
    expect(calls.synth).toEqual([]);

    const calls2 = newCalls();
    await server?.close();
    const base2 = await boot(deps(calls2, { claude: fakeClaude(calls2, ['Certainly.\nACTION {"type":"retire","agent":"x"}']) }));
    const ev2 = await turn(base2, "retire everything");
    expect(ev2.some((e) => e.type === "action")).toBe(false);
    expect(calls2.synth[0]).toBe("Certainly.");
    expect(calls2.synth[1]).toMatch(/permitted/);
  });

  it("a plan and a note arrive as proposals only: nothing is spoken, run or written by the server", async () => {
    const calls = newCalls();
    const base = await boot(deps(calls, { claude: fakeClaude(calls, ['ACTION {"type":"plan","steps":[{"type":"open_view","view":"board"},{"type":"mac_action","system":"mute"}]}']) }));
    const events = await turn(base, "open the board and mute");
    expect(events.find((e) => e.type === "action")).toEqual({ type: "action", action: { type: "plan", steps: [{ type: "open_view", view: "board" }, { type: "mac_action", kind: "system", action: "mute" }] } });
    expect(calls.synth).toEqual([]);

    const calls2 = newCalls();
    await server?.close();
    const base2 = await boot(deps(calls2, { claude: fakeClaude(calls2, ['ACTION {"type":"remember","title":"wifi","body":"the wifi password is hunter22"}']) }));
    const ev2 = await turn(base2, "remember the wifi password is hunter22");
    expect(ev2.some((e) => e.type === "action")).toBe(false); // refused at the proposal
    expect(calls2.synth[0]).toMatch(/never write those/);
    expect((await readdir(dataDir)).includes(STAGING_FILE)).toBe(false);
  });

  it("POST /api/voice/remember appends to the staging note only, and never stages a credential", async () => {
    const calls = newCalls();
    const base = await boot(deps(calls));
    const before = new Set(await readdir(dataDir));
    const bad = await remember(base, { title: "door", body: "the door code is 7731" });
    expect(bad.status).toBe(422);
    expect((await readdir(dataDir)).includes(STAGING_FILE)).toBe(false);
    expect((await remember(base, { title: "x" })).status).toBe(422);

    const ok = await remember(base, { title: "Doremi demo", body: "The Doremi Touch demo is on Thursday." });
    expect(await ok.json()).toEqual({ ok: true, file: STAGING_FILE });
    await remember(base, { title: "Flight", body: "Leila prefers the morning flight." });
    const staged = await readFile(join(dataDir, STAGING_FILE), "utf8");
    expect(staged).toContain("## Doremi demo");
    expect(staged).toContain("The Doremi Touch demo is on Thursday.");
    expect(staged).toContain("## Flight");
    expect(staged).toContain("not in memory until you move it");
    // the only new file is the staging note: no memory dir, no MEMORY.md
    const added = (await readdir(dataDir)).filter((f) => !before.has(f));
    expect(added).toEqual([STAGING_FILE]);
  });

  it("POST /api/voice/remember fails closed until the credential sweep has built the taint", async () => {
    const calls = newCalls();
    const recall = { credentials: { taint: () => null } } as unknown as VoiceRecall; // only the remember route runs
    const base = await boot(deps(calls, { recall }));
    const r = await remember(base, { title: "Doremi", body: "Demo on Thursday." });
    expect(r.status).toBe(503);
    expect((await readdir(dataDir)).includes(STAGING_FILE)).toBe(false);
  });

  it('"think harder" runs Sonnet with thinking left on', async () => {
    const calls = newCalls();
    const base = await boot(deps(calls));
    const events = await turn(base, "think harder about which city is slipping");
    expect(events.at(-1)).toMatchObject({ type: "done", model: "sonnet" });
    expect(calls.spawn[0]!.args.slice(0, 3)).toEqual(["-p", "--model", "sonnet"]);
    expect(calls.spawn[0]!.env).toEqual({});
  });

  it("no reply at all is reported, not silent", async () => {
    const calls = newCalls();
    const base = await boot(deps(calls, { claude: fakeClaude(calls, [], { exitCode: 1 }) }));
    const events = await turn(base, "hello");
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
    expect(events.some((e) => e.type === "sentence")).toBe(true); // "Forgive me…"
  });

  it("validates the turn body", async () => {
    const base = await boot(deps(newCalls()));
    const post = (body: unknown): Promise<Response> => fetch(`${base}/api/voice/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ clientId: "x", text: "hi" })).status).toBe(400);
    expect((await post({ clientId: "client-1", text: "" })).status).toBe(400);
    expect((await post({ clientId: "client-1", text: "x".repeat(1001) })).status).toBe(400);
    expect((await post({ clientId: "bad id!!", text: "hi" })).status).toBe(400);
  });
});
