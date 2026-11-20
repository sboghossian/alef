// "voice-brain": talking to Alef, fully local.
//   POST /api/voice/transcribe  {audioBase64} → ffmpeg (16 kHz mono wav) → whisper-cli → text
//   POST /api/voice/turn        {clientId, text} → NDJSON: sentence… (each with Piper audio), action?, done
//   GET  /api/voice/audio/:id   one synthesized sentence (audio/wav)
// The brain is the owner's own `claude` CLI (Max plan login, no API key) in a stripped-down
// headless mode (see voice-brain-lib.ts for the measured flags). Speech starts before the reply
// is finished: every completed sentence is synthesized by Piper and announced at once.
// This feature NEVER performs an action. It proposes one validated action; read-only ones the
// client runs at once, mutating ones only after a spoken "yes" or a click (voice-logic.ts).
// Temp audio lives under data/voice-tmp/ and is deleted as soon as it's read.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { ChatEvent } from "../../shared/features/chat.js";
import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_AUDIO_SECONDS,
  VOICE_MAX_TURN_CHARS,
  type VoiceBrainMode,
  type VoiceRememberResult,
  type VoiceTranscribeResult,
  type VoiceTurnEvent,
  type VoiceTurnTimings,
} from "../../shared/features/voice-brain.js";
import { redactSecrets } from "../heuristics.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { pendingApprovalViews } from "./approvals.js";
import { archiveFeature } from "./archive.js";
import { brainFeature } from "./brain.js";
import { excludedDenyRules, looseSecretValues, unscannedDenyRules } from "./credential-scan-lib.js";
import { TIER_FILE, TIER_SPOKEN } from "./credential-taint-lib.js";
import { realOrResolved } from "./fork-lib.js";
import { realChatExec } from "./chat.js";
import { LineSplitter, parseStreamLine } from "./chat-lib.js";
import { piperEnabled, piperEngine, voiceTmpDir, type PiperEngine } from "./piper.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import {
  actionEchoesRetrieved,
  brainEnv,
  buildBrainArgs,
  buildDeepArgs,
  buildDeepSystemPrompt,
  buildSystemPrompt,
  buildTurnPrompt,
  classifyLead,
  closedInResult,
  ConversationStore,
  isBareLookup,
  deepToolViolation,
  isActionStart,
  parseBrainReply,
  parseToolResultBlocks,
  parseToolUses,
  pickBrainModel,
  stripLookup,
  summarizeWorld,
  toolPath,
  validateAction,
  wantsDeepLookup,
  actionStrings,
} from "./voice-brain-lib.js";
import { BlackoutSources, whereOf } from "./voice-brain-blackout-lib.js";
import { GuardSources, ReplyGuard, type GuardContext } from "./voice-brain-guard-lib.js";
import { CLOSED_NOTE, createVoiceRecall, defaultRecallPaths, type RecallResult, type VoiceRecall } from "./voice-brain-recall.js";
import { blockSnippets, deepDenyRules, redactSpoken, retrievedSecretValues } from "./voice-brain-recall-lib.js";
import { checkMemoryNote, REMEMBER_CREDENTIAL, STAGING_FILE, stagingEntry } from "./voice-remember-lib.js";
import {
  cleanTranscript,
  ffmpegArgs,
  FFMPEG_BIN,
  resolveWhisperModel,
  SentenceStreamer,
  sniffAudio,
  speakable,
  whisperArgs,
  whisperModelCandidates,
  WHISPER_BIN,
} from "./voice-lib.js";

const TURN_TIMEOUT_MS = 60_000;
/** Deep mode: a wall clock, a turn cap and a spend cap per lookup (read-only tools only). */
const DEEP_TIMEOUT_MS = 45_000;
const DEEP_MAX_TURNS = 8;
const DEEP_MAX_BUDGET_USD = 0.15;
const LET_ME_LOOK = "One moment, sir, let me look through your files.";
const DEEP_NOTHING = "I looked, sir, but found nothing on that in your files.";
const DEEP_TIMED_OUT = "That search is taking too long, I'm afraid. Could you narrow it down?";
const DEEP_FAILED = "Forgive me, sir, that search failed. Could you ask again?";
const DEEP_REFUSED = "I stopped that search: it reached for something I'm not permitted to read.";
/** The lookup reached a file that holds credentials (it is closed to Alef). */
const DEEP_CLOSED = "That note holds credentials, sir, so I keep it closed.";
/** No complete credential scan yet (a fresh install's first sweep): deep mode can't know what to close. */
const DEEP_SCAN_PENDING = "I'm still checking your files for credentials, sir. Ask me again in a minute or two.";
/** How long a lookup waits for the first credential scan before saying so. */
const DEEP_SCAN_WAIT_MS = 15_000;
const DEEP_NOTES_ONLY = "I'm afraid I only checked the quick notes, sir, and they don't cover that. Ask me to search your files and I'll dig properly.";
/** A retry of a lookup that searched nothing needs this much of its wall clock (and $) left. */
const DEEP_RETRY_MIN_MS = 8_000;
const DEEP_RETRY_MIN_USD = 0.02;
const ECHOED_ACTION = "That instruction came from your notes, not from you, so I won't act on it.";
/** An action whose text would carry a number or code from his notes, or a closed file's value. */
const ACTION_CARRIES_CODE = "That task would carry a code from your notes, sir, so I won't dispatch it.";
const AUDIO_TTL_MS = 120_000;
const AUDIO_ID_RE = /^a-[0-9a-f]{32}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface VoiceDeps {
  /** execFile wrapper (argv only, never a shell). */
  runFile(bin: string, args: readonly string[], timeoutMs: number): Promise<RunResult>;
  claude: {
    findClaude(): Promise<string | null>;
    spawn(bin: string, args: readonly string[], cwd: string, env: Record<string, string>): ChildProcess;
  };
  piper: PiperEngine;
  piperOn(): boolean;
  /** Always-on retrieval and deep lookups over his notes, sessions and folders. Absent = off
   *  (the brain then sees only the live world, as before). */
  recall?: VoiceRecall;
  whisperModel(): string | null;
  now(): number;
}

const realRunFile: VoiceDeps["runFile"] = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export const realVoiceDeps: VoiceDeps = {
  runFile: realRunFile,
  claude: {
    findClaude: () => realChatExec.findClaude(),
    spawn(bin, args, cwd, extraEnv) {
      const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
      delete env.CLAUDECODE; // the dev server may itself run under a Claude session
      return spawn(bin, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    },
  },
  piper: piperEngine,
  piperOn: () => piperEnabled(piperEngine),
  recall: createVoiceRecall({
    ...defaultRecallPaths(),
    vaultSearch: (ctx, q, limit) => brainFeature.searchNotes(ctx, q, limit),
    archivedSessions: () => archiveFeature.archivedSessions(),
  }),
  whisperModel: () => resolveWhisperModel(whisperModelCandidates(process.env.ALEF_WHISPER_MODEL), existsSync),
  now: Date.now,
};

function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        rejectPromise(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", rejectPromise);
  });
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** `{"audioBase64": "..."}` → the audio bytes (≤ VOICE_MAX_AUDIO_BYTES). */
export function decodeAudioBody(raw: Buffer): { ok: true; audio: Buffer } | { ok: false; error: string } {
  let o: unknown;
  try {
    o = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }
  const b64 = isRecord(o) && typeof o.audioBase64 === "string" ? o.audioBase64.replace(/\s+/g, "") : "";
  if (!b64) return { ok: false, error: "empty audio" };
  if (!B64_RE.test(b64)) return { ok: false, error: "audioBase64 is not base64" };
  const audio = Buffer.from(b64, "base64");
  if (audio.length === 0) return { ok: false, error: "empty audio" };
  if (audio.length > VOICE_MAX_AUDIO_BYTES) return { ok: false, error: `audio must be at most ${VOICE_MAX_AUDIO_BYTES / 1024 / 1024} MB` };
  return { ok: true, audio };
}

/** Transcribes one recording. Every temp file is removed before this returns. */
export async function transcribe(audio: Buffer, tmpDir: string, deps: VoiceDeps): Promise<VoiceTranscribeResult> {
  const t0 = deps.now();
  const kind = sniffAudio(audio);
  if (!kind) return { ok: false, error: "not a recognizable audio file" };
  const model = deps.whisperModel();
  if (!model) return { ok: false, error: "no whisper model found (ggml-base.en.bin)" };
  await mkdir(tmpDir, { recursive: true });
  const id = randomUUID();
  const input = join(tmpDir, `stt-${id}.${kind}`);
  const wav = join(tmpDir, `stt-${id}.16k.wav`);
  try {
    await writeFile(input, audio, { mode: 0o600 });
    const conv = await deps.runFile(FFMPEG_BIN, ffmpegArgs(input, wav, VOICE_MAX_AUDIO_SECONDS), 20_000);
    if (conv.code !== 0) return { ok: false, error: `ffmpeg failed: ${conv.stderr.trim().slice(0, 200) || `code ${conv.code}`}` };
    const w = await deps.runFile(WHISPER_BIN, whisperArgs(model, wav), 45_000);
    if (w.code !== 0) return { ok: false, error: `whisper failed: ${w.stderr.trim().split("\n").pop()?.slice(0, 200) || `code ${w.code}`}` };
    return { ok: true, text: cleanTranscript(w.stdout), ms: deps.now() - t0, model: model.split("/").pop() ?? model };
  } finally {
    await rm(input, { force: true });
    await rm(wav, { force: true });
  }
}

export function createVoiceBrainFeature(deps: VoiceDeps = realVoiceDeps): ServerFeature {
  const conversations = new ConversationStore(6, 20);
  const audio = new Map<string, { buf: Buffer; at: number }>();
  const turns = new Map<string, ChildProcess>();
  let sttInFlight = 0;

  const sweep = (): void => {
    const cutoff = deps.now() - AUDIO_TTL_MS;
    for (const [id, a] of audio) if (a.at < cutoff) audio.delete(id);
  };

  async function synth(ctx: FeatureContext, text: string): Promise<string | null> {
    if (!deps.piperOn()) return null;
    const say = speakable(text);
    if (!say) return null;
    const dir = voiceTmpDir(ctx.config.dbPath);
    await mkdir(dir, { recursive: true });
    const id = `a-${randomUUID().replace(/-/g, "")}`;
    const out = join(dir, `${id}.wav`);
    try {
      await deps.piper.synthesize(say, out);
      const buf = await readFile(out);
      sweep();
      audio.set(id, { buf, at: deps.now() });
      return `/api/voice/audio/${id}`;
    } catch (err) {
      ctx.log.warn("voice-brain", "piper failed", String(err));
      return null;
    } finally {
      await rm(out, { force: true });
    }
  }

  interface ClaudeRun {
    deltaText: string;
    assistantText: string;
    resultText: string;
    sawDelta: boolean;
    costUsd: number | null;
    /** The result line's subtype ("success", "error_max_turns", …), null when none came. */
    subtype: string | null;
    /** The result line said success AND not is_error (an API or usage-limit failure can come as
     *  subtype "success" with is_error: true, its "answer" being the error text). */
    resultOk: boolean;
    stderr: string;
    /** Why the server ended it early (timeout, tripwire), or null. */
    stopped: string | null;
  }

  /** Spawns one headless claude, feeds it `stdin`, and hands every stream-json line to `onLine`
   *  (plus the parsed events to `onEvent`). Barge-in (a new utterance) and the client hanging up
   *  both kill it; so does `timeoutMs`. */
  function runClaude(
    clientId: string,
    res: ServerResponse,
    bin: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
    stdin: string | Promise<string>,
    timeoutMs: number,
    on: { event?(ev: ChatEvent, run: ClaudeRun, stop: (why: string) => void): void; line?(line: string, stop: (why: string) => void): void },
  ): Promise<ClaudeRun> {
    const run: ClaudeRun = { deltaText: "", assistantText: "", resultText: "", sawDelta: false, costUsd: null, subtype: null, resultOk: false, stderr: "", stopped: null };
    // A turn whose client already hung up (barge-in, Esc) spawns nothing, and above all never kills
    // the newer turn's claude that now sits in `turns` under the same client id.
    if (res.destroyed) {
      run.stopped = "client gone";
      return Promise.resolve(run);
    }
    turns.get(clientId)?.kill(); // a new utterance barges in on the previous turn
    const child = deps.claude.spawn(bin, args, cwd, env);
    turns.set(clientId, child);
    const stop = (why: string): void => {
      if (run.stopped === null) run.stopped = why;
      child.kill();
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onClose = (): void => {
      if (!res.writableFinished) child.kill(); // the client hung up (barge-in / Esc)
    };
    res.on("close", onClose);
    const lines = new LineSplitter();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of lines.push(chunk)) {
        on.line?.(line, stop);
        for (const ev of parseStreamLine(line)) {
          if (ev.kind === "text-delta") {
            run.sawDelta = true;
            run.deltaText += ev.text;
          } else if (ev.kind === "assistant-text") run.assistantText += ev.text;
          else if (ev.kind === "result") {
            run.resultText = ev.text;
            run.costUsd = ev.costUsd;
            run.subtype = ev.subtype;
            run.resultOk = ev.ok;
          }
          on.event?.(ev, run, stop);
          if (ev.kind === "result") child.stdin?.end();
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      run.stderr = (run.stderr + c).slice(-2000);
    });
    child.stdin?.on("error", () => {
      // EPIPE when claude dies early: the close handler reports it
    });
    // The prompt can still be in the making (retrieval runs while claude boots): write it when ready.
    void Promise.resolve(stdin).then((prompt) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end(prompt);
    });
    return new Promise<ClaudeRun>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        res.off("close", onClose);
        if (turns.get(clientId) === child) turns.delete(clientId);
        resolve(run);
      };
      child.on("error", (err) => {
        run.stderr += String(err);
        finish();
      });
      child.on("close", finish);
    });
  }

  async function runTurn(ctx: FeatureContext, res: ServerResponse, clientId: string, text: string): Promise<void> {
    const t0 = deps.now();
    const timings: VoiceTurnTimings = { firstTokenMs: null, firstAudioMs: null, totalMs: 0, firstSentenceMs: null, retrievalMs: null };
    const send = (ev: VoiceTurnEvent): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
    };
    const model = pickBrainModel(text);
    const bin = await deps.claude.findClaude();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
    if (!bin) {
      const url = await synth(ctx, "I can't find the claude command on this Mac, I'm afraid.");
      send({ type: "sentence", index: 0, text: "I can't find the claude command on this Mac, I'm afraid.", audioUrl: url });
      send({ type: "done", ok: false, model, text: "", timings: { ...timings, totalMs: deps.now() - t0 }, error: "claude CLI not found" });
      res.end();
      return;
    }
    const views = ctx.worldViews();
    const summary = summarizeWorld({ agents: views.agents, islands: views.islands, approvals: pendingApprovalViews(), now: new Date(deps.now()) });
    const cwd = join(dirname(voiceTmpDir(ctx.config.dbPath)), "voice-brain"); // neutral: no CLAUDE.md, no repo
    await mkdir(cwd, { recursive: true });

    let index = 0;
    let chain: Promise<void> = Promise.resolve();
    /** Values a sentence must never repeat (spoken or stored, however it is worded): a closed
     *  file's values this turn's lookup somehow saw (the tripwire ends that lookup; this is the net
     *  under it), and the reply guard's values: what the credential rules and the guard's own
     *  looser net find in the retrieved notes and in what a deep lookup read (retrieval never quotes
     *  a closed file, so the rules normally find none; the looser net is there for what they miss). */
    const secretValues = new Set<string>();
    /** The dictionary the guard tells a password from a word with (from the recall, once it's back). */
    let isWord: ((w: string) => boolean) | undefined;
    // The copy guard (voice-brain-guard-lib.ts): what a sentence copies from this turn's sources
    // (the world summary, the retrieved notes, every tool result a lookup read) is withheld when it
    // is a closed file's value, or when the turn is about access and it looks like a credential.
    const sources = new GuardSources();
    sources.add(summary);
    // The number blackout (voice-brain-blackout-lib.ts): the numbers and codes this turn's notes and
    // lookups wrote, never said aloud whatever the question is about (the world summary is not in it).
    const blackout = new BlackoutSources();
    // The taint is read again once the notes are back and before a lookup: after a restart it is
    // rebuilt from the closed files while the first turns run.
    const guardCtx: GuardContext = { question: text, previous: conversations.get(clientId).map((t) => t.user), sources, taint: deps.recall?.credentials.taint() ?? null, blackout };
    const guard = new ReplyGuard(guardCtx);
    /** The last net on every sentence and the stored reply: token shapes and this turn's credential values. */
    const redact = (s: string): string => redactSpoken(s, secretValues);
    const emit = (guarded: string): void => {
      if (!guarded) return; // a second withheld sentence in a row: the notice was already said
      const clean = redact(guarded);
      const i = index++;
      chain = chain.then(async () => {
        if (res.destroyed) return; // the client hung up: don't synthesize for nobody
        const url = await synth(ctx, clean);
        if (url && timings.firstAudioMs === null) timings.firstAudioMs = deps.now() - t0;
        if (timings.firstSentenceMs === null) timings.firstSentenceMs = deps.now() - t0;
        send({ type: "sentence", index: i, text: clean, audioUrl: url });
      });
    };
    /** Says what the guard still holds (a number being read out waits for what follows it). */
    const drain = (): void => {
      for (const g of guard.flush()) emit(g);
    };
    /** Queues one spoken sentence (guarded and redacted; Alef's own fixed lines skip the guard, and
     *  first let out what it held): synthesized and sent in order. */
    const say = (s: string, fixed = false): void => {
      if (fixed) {
        drain();
        emit(s);
      } else for (const g of guard.push(s)) emit(g);
    };

    // Always-on retrieval: a few fenced snippets of his own notes, sessions and folders. It runs
    // while claude boots (the notes go on stdin, so nothing in argv waits for them).
    const recall = deps.recall ?? null;
    const retrievalP: Promise<RecallResult | null> = recall
      ? recall.retrieve(ctx, { text, agents: views.agents, islands: views.islands, now: new Date(deps.now()) }).then(
          async (r) => {
            timings.retrievalMs = r.ms;
            isWord = r.isWord;
            guardCtx.isWord = r.isWord;
            guardCtx.taint = recall?.credentials.taint() ?? guardCtx.taint;
            sources.add(blockSnippets(r.block).split(CLOSED_NOTE).join(" "));
            blackout.addBlock(r.block);
            const guarded = retrievedSecretValues(r.block, r.isWord);
            for (const v of guarded) secretValues.add(v); // before the model says a word
            // The closed notes this turn matched: their values too (read in memory, never logged).
            for (const p of r.closedPaths ?? []) for (const v of await recall.credentials.valuesOf(p)) secretValues.add(v);
            const counts = Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(", ");
            ctx.log.info("voice-brain", `recall: ${r.hits.length} hits${counts ? ` (${counts})` : ""}, ${r.closed} closed, ${r.corrections.length} name corrections, ${r.ms} ms${r.vaultReady ? "" : " (vault index still building)"}${guarded.length ? `, ${guarded.length} values guarded` : ""}`);
            return r;
          },
          (err: unknown) => {
            ctx.log.warn("voice-brain", "recall failed", String(err));
            return null;
          },
        )
      : Promise.resolve(null);
    const history = conversations.get(clientId);
    // The notes ride on stdin with his words, never in argv (which `ps` shows).
    const stdinP = retrievalP.then((r) => buildTurnPrompt(history, text, recall ? (r?.block ?? "") : undefined));
    let mode: VoiceBrainMode = "fast";
    let costUsd = 0;
    let speech = "";
    let action: unknown = null;
    let full = "";
    let stderr = "";
    /** A failure Alef already apologized for aloud (the done event still says ok: false). */
    let failure: string | null = null;

    /** Deep mode: "let me look" at once, then a read-only claude with Read/Grep/Glob; only its
     *  final answer is spoken, and it never proposes an action. `notesMissed`: the fast brain said
     *  LOOKUP, so the quick notes did not answer and the lookup must really search. */
    const deep = async (notesMissed: boolean): Promise<void> => {
      if (!recall || res.destroyed) return; // barge-in between the fast reply and the lookup
      say(LET_ME_LOOK, true);
      // Deep mode reads files directly: it needs the complete list of files that hold credentials.
      const gate = recall.credentials;
      if (!(await gate.whenReady(DEEP_SCAN_WAIT_MS))) {
        failure = "credential scan not ready";
        say(DEEP_SCAN_PENDING, true);
        return;
      }
      guardCtx.taint = gate.taint() ?? guardCtx.taint; // whenReady waited for it
      const deepModel = model;
      // Real paths throughout: the deny rules name real paths, so the model's tool calls should too.
      const [memoryDir, vaultRoot, codeRoot, residentDir] = await Promise.all([recall.memoryDir, recall.vaultRoot, recall.codeRoot, recall.residentDir].map(realOrResolved));
      const systemPrompt = buildDeepSystemPrompt({ worldSummary: summary, memoryDir: memoryDir ?? recall.memoryDir, vaultRoot: vaultRoot ?? recall.vaultRoot, codeRoot: codeRoot ?? recall.codeRoot, residentDir: residentDir ?? recall.residentDir, now: new Date(deps.now()), notesMissed });
      const roots = await recall.deepRoots();
      const deadline = deps.now() + DEEP_TIMEOUT_MS;
      // The deny rules (secret classes, skipped folders, and one per closed file) go in a settings
      // file: thousands of paths don't belong in argv, where `ps` shows them.
      const excluded = gate.excluded().map((e) => e.path);
      const denyRules = [...deepDenyRules(recall.home), ...unscannedDenyRules(), ...excludedDenyRules(excluded)];
      const tmp = voiceTmpDir(ctx.config.dbPath);
      await mkdir(tmp, { recursive: true });
      const settingsFile = join(tmp, `deep-${randomUUID()}.json`);
      await writeFile(settingsFile, JSON.stringify({ permissions: { deny: denyRules } }), { mode: 0o600 });
      const isClosed = (abs: string): boolean => gate.isExcluded(abs);
      /** One read-only claude run: counts its tool calls; the tripwire ends it on a refused path or
       *  tool, and on anything closed (a closed file, or a result that holds a credential). */
      const lookup = async (maxBudgetUsd: number, timeoutMs: number): Promise<{ run: ClaudeRun; tools: number }> => {
        const args = buildDeepArgs(deepModel, systemPrompt, { roots, denyRules, settingsFile, maxTurns: DEEP_MAX_TURNS, maxBudgetUsd });
        let tools = 0;
        const calls = new Map<string, { name: string; path: string }>();
        const run = await runClaude(clientId, res, bin, args, cwd, brainEnv(deepModel), stdinP, timeoutMs, {
          line(line, stop) {
            for (const t of parseToolUses(line)) {
              tools++;
              if (t.id) calls.set(t.id, { name: t.name, path: toolPath(t.input) });
              const v = deepToolViolation(t, recall.home, cwd, isClosed);
              if (!v) continue;
              ctx.log.warn("voice-brain", `deep lookup stopped: ${v.why}`);
              if (v.closed) void gate.valuesOf(v.path).then((vals) => vals.forEach((x) => secretValues.add(x)));
              stop(v.closed ? "closed" : "tripwire");
            }
            for (const r of parseToolResultBlocks(line)) {
              sources.add(r.text); // what the answer may copy from
              const call = calls.get(r.id);
              const base = call?.name === "Read" ? (call.path.split("/").at(-1) ?? "") : "";
              blackout.add(r.text, base ? whereOf(/\.md$/i.test(base) ? "note" : "file", base) : "your files");
              // A result that repeats a closed file's value (a file changed since the last sweep, or
              // one the sweep has not re-checked yet) ends the lookup like a closed file.
              if (guardCtx.taint?.textHit(r.text, TIER_FILE)) {
                ctx.log.warn("voice-brain", "deep lookup stopped: a result repeated a closed file's value");
                stop("closed");
                continue;
              }
              // The guard's looser net over everything the lookup reads, before its answer is said.
              for (const x of looseSecretValues(r.text, isWord)) secretValues.add(x);
              const c = closedInResult(r.text, calls.get(r.id), isClosed, roots);
              if (!c) continue;
              for (const x of c.values) secretValues.add(x);
              ctx.log.warn("voice-brain", `deep lookup stopped: ${c.why}`);
              stop("closed");
            }
          },
          event(ev) {
            if (ev.kind === "result" && timings.firstTokenMs === null) timings.firstTokenMs = deps.now() - t0;
          },
        });
        costUsd += run.costUsd ?? 0;
        stderr = run.stderr;
        ctx.log.info("voice-brain", `deep lookup: ${tools} tool calls, ${run.stopped ?? "finished"}, $${(run.costUsd ?? 0).toFixed(4)}`);
        return { run, tools };
      };
      // After a LOOKUP an answer that searched nothing would claim a search that never happened
      // ("I checked your vault, nothing there"). Retry once inside the same time and $ caps; if it
      // still searches nothing, say honestly that only the quick notes were checked.
      const searchOnce = async (): Promise<{ run: ClaudeRun; searchedNothing: boolean }> => {
        let { run, tools } = await lookup(DEEP_MAX_BUDGET_USD, DEEP_TIMEOUT_MS);
        let searchedNothing = notesMissed && tools === 0 && run.stopped === null && run.resultOk;
        const leftMs = deadline - deps.now();
        const leftUsd = DEEP_MAX_BUDGET_USD - (run.costUsd ?? 0);
        if (searchedNothing && leftMs >= DEEP_RETRY_MIN_MS && leftUsd >= DEEP_RETRY_MIN_USD && !res.destroyed) {
          ctx.log.info("voice-brain", "deep lookup searched nothing after a LOOKUP: retrying once");
          ({ run, tools } = await lookup(Number(leftUsd.toFixed(4)), leftMs));
          searchedNothing = tools === 0 && run.stopped === null && run.resultOk;
        }
        return { run, searchedNothing };
      };
      const { run, searchedNothing } = await searchOnce().finally(() => rm(settingsFile, { force: true }));
      if (run.stopped === "closed") {
        failure = "deep lookup reached a closed file";
        say(DEEP_CLOSED, true);
        return;
      }
      if (run.stopped === "tripwire") {
        failure = "deep lookup stopped by the tripwire";
        say(DEEP_REFUSED, true);
        return;
      }
      if (searchedNothing) {
        failure = "deep lookup searched nothing";
        say(DEEP_NOTES_ONLY, true);
        return;
      }
      // Only a successful final answer is spoken: a capped or cut-off run may end on its own
      // narration ("Let me search…"), which is not an answer.
      const answered = run.resultOk && run.resultText.trim().length > 0;
      full = answered ? run.resultText : "";
      speech = answered ? speakable(parseBrainReply(full).speech) : ""; // lookup-only: any action is dropped; tool-mode answers drift into markdown
      const sentences = new SentenceStreamer();
      const out = speech ? [...sentences.push(speech), ...sentences.flush()] : [];
      for (const s of out) say(s);
      if (out.length) return;
      if (answered) {
        say(DEEP_NOTHING, true);
        return;
      }
      if (res.destroyed) return; // barge-in: nobody to tell
      const cut = run.stopped === "timeout" || (run.subtype !== null && run.subtype.startsWith("error_max"));
      failure = cut ? `deep lookup ${run.stopped ?? run.subtype}` : "deep lookup ended without an answer";
      say(cut ? DEEP_TIMED_OUT : DEEP_FAILED, true);
    };

    if (recall && wantsDeepLookup(text)) {
      mode = "deep";
      await deep(false);
    } else {
      // Fast mode: the stripped-down brain, streaming sentences as they come.
      const args = buildBrainArgs(model, buildSystemPrompt(summary, recall !== null));
      const sentences = new SentenceStreamer();
      let inAction = false;
      const st: { lead: "pending" | "lookup" | "speech"; buf: string; trailing: boolean } = { lead: recall ? "pending" : "speech", buf: "", trailing: false };
      const speakModel = (s: string): void => {
        if (inAction || isActionStart(s)) {
          inAction = true;
          return;
        }
        if (recall && isBareLookup(s)) {
          st.trailing = true; // "…in my notes. Lookup." in any case
          return;
        }
        const l = recall ? stripLookup(s) : { text: s, found: false };
        if (l.found) st.trailing = true;
        if (l.text) say(l.text);
      };
      /** The reply ended while its first characters were still undecided: a bare "Lookup." (any
       *  case) is the escape hatch, anything else is speech. */
      const settleLead = (): void => {
        if (st.lead !== "pending") return;
        if (isBareLookup(st.buf)) {
          st.lead = "lookup";
          return;
        }
        st.lead = "speech";
        if (st.buf) for (const s of sentences.push(st.buf)) speakModel(s);
      };
      const onText = (t: string): void => {
        if (timings.firstTokenMs === null) timings.firstTokenMs = deps.now() - t0;
        if (st.lead === "lookup") return;
        let chunk = t;
        if (st.lead === "pending") {
          st.buf += t;
          st.lead = classifyLead(st.buf);
          if (st.lead === "lookup") return; // not killed: it ends at once, and its result line carries the cost
          if (st.lead === "pending") return;
          chunk = st.buf;
        }
        for (const s of sentences.push(chunk)) speakModel(s);
      };
      const run = await runClaude(clientId, res, bin, args, cwd, brainEnv(model), stdinP, TURN_TIMEOUT_MS, {
        event(ev, r) {
          if (ev.kind === "text-delta") onText(ev.text);
          else if (ev.kind === "assistant-text" && !r.sawDelta) onText(ev.text);
          else if (ev.kind === "result") {
            // The reply is complete: speak the unterminated tail now instead of waiting ~0.5 s
            // for the claude process to exit.
            if (!r.sawDelta && !r.assistantText) onText(ev.text);
            settleLead();
            if (st.lead !== "lookup") for (const s of sentences.flush()) speakModel(s);
          }
        },
      });
      costUsd += run.costUsd ?? 0;
      stderr = run.stderr;
      settleLead();
      if (st.lead === "lookup" && recall) {
        mode = "fast+deep";
        await deep(true);
      } else {
        for (const s of sentences.flush()) speakModel(s);
        full = (run.sawDelta ? run.deltaText : run.assistantText) || run.resultText;
        ({ speech, action } = parseBrainReply(full));
        if (st.trailing) speech = stripLookup(speech).text; // never stored or shown, even if he barges in now
        if (st.trailing && recall) {
          // "I don't have that in my notes. LOOKUP": the apology is spoken, then Alef looks.
          mode = "fast+deep";
          await deep(true);
        } else if (action !== null) {
          const check = validateAction(action, views);
          if (actionEchoesRetrieved(action, (await retrievalP)?.block ?? "")) {
            ctx.log.warn("voice-brain", "refused an action copied from retrieved notes");
            say(ECHOED_ACTION, true);
          } else if (check.ok && actionStrings(check.action).some((f) => guard.carries(f) || redact(f) !== f || (guardCtx.taint?.textHit(f, TIER_SPOKEN) ?? false))) {
            // Its read-back is spoken by the client and its prompt becomes a session's: it gets the
            // same nets as a sentence Alef says.
            ctx.log.warn("voice-brain", "refused an action that carries a number or code from the notes");
            say(ACTION_CARRIES_CODE, true);
          } else if (check.ok) {
            drain();
            await chain;
            send({ type: "action", action: check.action });
          } else say(check.text);
        }
      }
    }
    drain();
    await chain;
    const ok = full.trim().length > 0;
    if (!ok && failure === null && !res.writableEnded) {
      ctx.log.warn("voice-brain", `turn produced no text: ${redactSecrets(stderr.trim().slice(-300))}`);
      say("Forgive me, I lost my train of thought. Could you say that again?", true);
      await chain;
    }
    speech = redact(ReplyGuard.text(speech, guardCtx));
    if (ok) conversations.add(clientId, { user: text, alef: speech || (action !== null && mode === "fast" ? "(proposed an action for the user to confirm)" : "…") });
    timings.totalMs = deps.now() - t0;
    ctx.log.info("voice-brain", `turn ${model} ${mode}: recall ${timings.retrievalMs ?? "-"} ms, first token ${timings.firstTokenMs ?? "-"} ms, first sentence ${timings.firstSentenceMs ?? "-"} ms, first audio ${timings.firstAudioMs ?? "-"} ms, total ${timings.totalMs} ms, $${costUsd.toFixed(4)}`);
    send({ type: "done", ok, model, text: speech, timings, mode, costUsd: costUsd || null, ...(ok ? {} : { error: failure ?? (redactSecrets(stderr.trim().slice(-300)) || "no reply") }) });
    res.end();
  }

  return {
    id: "voice-brain",
    routes: [
      {
        method: "POST",
        path: "/api/voice/transcribe",
        async handler(req, res, ctx) {
          if (sttInFlight >= 2) return respondJson(res, 429, { ok: false, error: "busy transcribing, try again" } satisfies VoiceTranscribeResult);
          // JSON (the hub's guard only lets application/json POSTs through): {audioBase64}.
          let raw: Buffer;
          try {
            raw = await readRawBody(req, Math.ceil((VOICE_MAX_AUDIO_BYTES * 4) / 3) + 4096);
          } catch {
            return respondJson(res, 413, { ok: false, error: `audio must be at most ${VOICE_MAX_AUDIO_BYTES / 1024 / 1024} MB` } satisfies VoiceTranscribeResult);
          }
          const body = decodeAudioBody(raw);
          if (!body.ok) return respondJson(res, 400, body satisfies VoiceTranscribeResult);
          deps.recall?.warm(ctx); // he is talking: have the note indexes ready by the time he's heard
          sttInFlight++;
          try {
            const r = await transcribe(body.audio, voiceTmpDir(ctx.config.dbPath), deps);
            if (r.ok) ctx.log.info("voice-brain", `transcribed ${body.audio.length} bytes in ${r.ms} ms (${r.model})`);
            respondJson(res, r.ok ? 200 : 422, r);
          } catch (err) {
            ctx.log.error("voice-brain", "transcribe failed", String(err));
            respondJson(res, 500, { ok: false, error: "transcription failed" } satisfies VoiceTranscribeResult);
          } finally {
            sttInFlight--;
          }
        },
      },
      {
        method: "POST",
        path: "/api/voice/turn",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" });
          }
          const clientId = isRecord(body) && typeof body.clientId === "string" ? body.clientId : "";
          const text = isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";
          if (!CLIENT_ID_RE.test(clientId)) return respondJson(res, 400, { ok: false, error: "clientId must be 6-64 url-safe characters" });
          if (!text || text.length > VOICE_MAX_TURN_CHARS) return respondJson(res, 400, { ok: false, error: `text must be 1..${VOICE_MAX_TURN_CHARS} characters` });
          try {
            await runTurn(ctx, res, clientId, text);
          } catch (err) {
            ctx.log.error("voice-brain", "turn failed", String(err));
            if (!res.headersSent) respondJson(res, 500, { ok: false, error: "voice turn failed" });
            else if (!res.writableEnded) res.end();
          }
        },
      },
      {
        // Sent by the client only after his spoken "yes" to the read-back. Appends to ONE staging
        // note in the data folder, never to the memory files. Same nets as the proposal, plus the
        // value taint; fail-closed while the first credential sweep is still running.
        method: "POST",
        path: "/api/voice/remember",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies VoiceRememberResult);
          }
          const c = checkMemoryNote(isRecord(body) ? body.title : "", isRecord(body) ? body.body : "");
          if (!c.ok) return respondJson(res, 422, { ok: false, error: c.text } satisfies VoiceRememberResult);
          const taint = deps.recall ? deps.recall.credentials.taint() : null;
          if (deps.recall && !taint) return respondJson(res, 503, { ok: false, error: "I'm still checking your files for credentials, sir. Ask me again in a minute or two." } satisfies VoiceRememberResult);
          if (taint?.textHit(`${c.note.title}\n${c.note.body}`, TIER_SPOKEN)) return respondJson(res, 422, { ok: false, error: REMEMBER_CREDENTIAL } satisfies VoiceRememberResult);
          if (ctx.config.dbPath === ":memory:") return respondJson(res, 409, { ok: false, error: "no data folder to stage the note in" } satisfies VoiceRememberResult);
          const file = join(dirname(ctx.config.dbPath), STAGING_FILE);
          try {
            await appendFile(file, stagingEntry(c.note, new Date(deps.now())), "utf8");
          } catch (err) {
            ctx.log.error("voice-brain", "staging note write failed", String(err));
            return respondJson(res, 500, { ok: false, error: "I couldn't write the staging note." } satisfies VoiceRememberResult);
          }
          ctx.log.info("voice-brain", `staged a note (${c.note.body.length} chars)`);
          respondJson(res, 200, { ok: true, file: STAGING_FILE } satisfies VoiceRememberResult);
        },
      },
      {
        method: "GET",
        path: "/api/voice/audio/:id",
        handler(_req, res, _ctx, params) {
          const id = params.id ?? "";
          const a = AUDIO_ID_RE.test(id) ? audio.get(id) : undefined;
          if (!a) return respondJson(res, 404, { ok: false, error: "no such audio (it expires after 2 minutes)" });
          res.writeHead(200, { "content-type": "audio/wav", "content-length": a.buf.length, "cache-control": "no-store" });
          res.end(a.buf);
        },
      },
    ],
    snapshotExtras() {
      return { "voice-brain.stt": deps.whisperModel() !== null, "voice-brain.piper": deps.piperOn() };
    },
    // Keeps the credential scan current (an incremental sweep every 15 minutes reads only what changed).
    tickIntervalMs: 60_000,
    onTick(ctx) {
      deps.recall?.maintain(ctx);
    },
  };
}

export const voiceBrainFeature = createVoiceBrainFeature();
