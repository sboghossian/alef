// Voice-brain eval: asks Alef a fixed list of questions on a THROWAWAY server and records what he
// says, how fast, in which mode, and what it cost.
//
//   cd <throwaway dir>   # its data/ gets the db copy, caches and voice temp files
//   ALEF_EVAL_REPO=<checkout> npx tsx <checkout>/scripts/voice-brain-eval.ts questions.json out.json
//
// questions.json: [{ "id": "q1", "q": "Who is Alicia for me?", "truth": "…", "must": [["maya"], ["daughter"]] }]
//   `must`: every group needs one alternative (case-insensitive substring) for "correct"; some = "partial".
// The server: port ALEF_PORT (default 5199), db = ./data/world.db (copy it there first: never the live
// one), only the voice-brain, brain and archive features, no TypeSafe key, executors that throw.
// The brain is the real `claude` CLI (Haiku), so every question costs a little. Works against any
// checkout that has createVoiceBrainFeature/realVoiceDeps (main before retrieval, too).

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface Question {
  id: string;
  q: string;
  truth: string;
  must: string[][];
}

interface Row {
  id: string;
  q: string;
  answer: string;
  mode: string;
  firstSentenceMs: number | null;
  totalMs: number;
  retrievalMs: number | null;
  serverFirstSentenceMs: number | null;
  costUsd: number | null;
  auto: "correct" | "partial" | "wrong" | "refused";
}

const REFUSAL = /\b(?:don'?t have access|no access|can'?t (?:see|access|find)|cannot (?:see|access)|only see|unable to|not able to|I don'?t know|no (?:record|information|idea)|I can'?t tell)\b/i;

function grade(answer: string, must: string[][]): Row["auto"] {
  const a = answer.toLowerCase();
  const hit = must.filter((alts) => alts.some((x) => a.includes(x.toLowerCase()))).length;
  if (hit === must.length && must.length > 0) return "correct";
  if (hit > 0) return "partial";
  return REFUSAL.test(answer) ? "refused" : "wrong";
}

async function main(): Promise<void> {
  const repo = resolve(process.env.ALEF_EVAL_REPO ?? ".");
  const [questionsPath, outPath] = process.argv.slice(2);
  if (!questionsPath || !outPath) throw new Error("usage: voice-brain-eval.ts questions.json out.json");
  const questions = JSON.parse(await readFile(questionsPath, "utf8")) as Question[];
  const port = Number(process.env.ALEF_PORT) || 5199;
  const dbPath = join(process.cwd(), "data", "world.db");

  const { startServer, defaultConfig } = (await import(join(repo, "server", "index.ts"))) as typeof import("../server/index.js");
  const vb = (await import(join(repo, "server", "features", "voice-brain.ts"))) as typeof import("../server/features/voice-brain.js");
  const { brainFeature } = (await import(join(repo, "server", "features", "brain.ts"))) as typeof import("../server/features/brain.js");
  const { archiveFeature } = (await import(join(repo, "server", "features", "archive.ts"))) as typeof import("../server/features/archive.js");
  const { createPiperEngine } = (await import(join(repo, "server", "features", "piper.ts"))) as typeof import("../server/features/piper.js");
  const { piperPaths } = (await import(join(repo, "server", "features", "voice-lib.ts"))) as typeof import("../server/features/voice-lib.js");

  // Piper from the main checkout's venv (read-only use), so "first sentence" includes real TTS.
  const piperRoot = process.env.ALEF_EVAL_PIPER_ROOT;
  const piper = piperRoot ? createPiperEngine(piperPaths(piperRoot)) : vb.realVoiceDeps.piper;
  const voice = vb.createVoiceBrainFeature({ ...vb.realVoiceDeps, piper, piperOn: () => piper.available() });
  const never = (): never => {
    throw new Error("executors are off in the eval");
  };
  const server = await startServer({
    ...defaultConfig(),
    dbPath,
    port,
    typesafeApiKey: "",
    reactivateExecutor: never,
    dispatchExecutor: never,
    openEditorExecutor: never,
    features: [voice, brainFeature, archiveFeature],
  });
  const base = `http://127.0.0.1:${server.port}`;
  // Warm what a long-running server already has: the vault index, the archive scan, and the
  // credential scan (deep mode won't read a file until the scan says which ones are closed).
  await fetch(`${base}/api/brain/search?q=warm`);
  await brainFeature.whenIndexed();
  await fetch(`${base}/api/archive`);
  const scan = vb.realVoiceDeps.recall?.credentials;
  if (scan) {
    const t0 = Date.now();
    const ready = await scan.whenReady(20 * 60_000);
    // A long-running server has finished its first sweep (the value taint's counts included):
    // join it rather than asking while it still re-reads every file.
    if (ready && typeof scan.sweep === "function") await scan.sweep();
    const st = scan.status();
    process.stderr.write(`credential scan: ${ready ? "ready" : "NOT READY"} after ${Date.now() - t0} ms: ${st.files} files, ${st.excluded} closed ${JSON.stringify(st.byReason)}${st.taint ? `, taint ${JSON.stringify(st.taint)}` : ""}\n`);
  }

  const rows: Row[] = [];
  for (const [i, item] of questions.entries()) {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/voice/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: `eval-${Date.now()}-${i}`, text: item.q }),
    });
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let firstSentenceMs: number | null = null;
    const said: string[] = [];
    let done: Record<string, unknown> | null = null;
    while (reader) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (ev.type === "sentence") {
          if (firstSentenceMs === null) firstSentenceMs = Date.now() - t0;
          said.push(String(ev.text));
        } else if (ev.type === "action") said.push(`[ACTION ${JSON.stringify(ev.action)}]`);
        else if (ev.type === "done") done = ev;
      }
    }
    const timings = (done?.timings ?? {}) as Record<string, number | null>;
    const answer = said.join(" ");
    rows.push({
      id: item.id,
      q: item.q,
      answer,
      mode: typeof done?.mode === "string" ? done.mode : "fast (pre-retrieval)",
      firstSentenceMs,
      totalMs: Date.now() - t0,
      retrievalMs: timings.retrievalMs ?? null,
      serverFirstSentenceMs: timings.firstSentenceMs ?? null,
      costUsd: typeof done?.costUsd === "number" ? done.costUsd : null,
      auto: grade(answer, item.must),
    });
    process.stderr.write(`${item.id} ${rows.at(-1)?.auto} ${firstSentenceMs} ms: ${answer.slice(0, 160)}\n`);
  }
  await writeFile(outPath, JSON.stringify(rows, null, 2));
  await server.close();
  piper.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
