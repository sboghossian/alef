// The one Claude synthesis call: headless `claude -p`, no tools, stdin prompt, execFile
// with an argv array (no shell), a timeout. `--tools ""` is the flag verified against
// `claude --help` ("Use \"\" to disable all tools") and against a real run (see the
// e2e note in the PR/handback): `claude -p --model sonnet --tools "" --output-format
// text` returns plain text and never touches a tool. Known trap (memory:
// feedback_headless_claude_permission_gate): a headless `claude -p` can exit 0 having
// done nothing, so a short/empty stdout is treated as a failure regardless of exit code.

import { execFile } from "node:child_process";
import type { CouncilPersonaResult, CouncilVerdict } from "../../shared/features/council.js";

export const SYNTH_TIMEOUT_MS = 90_000;
const MIN_SYNTH_CHARS = 20;
const CLAUDE_ARGS = ["-p", "--model", "sonnet", "--tools", "", "--output-format", "text"];

export interface SynthOutput {
  stdout: string;
  stderr: string;
}

export type SynthRunner = (prompt: string, timeoutMs: number) => Promise<SynthOutput>;

/** Real runner: no shell (argv array), prompt goes over stdin, killed after timeoutMs. */
export const realSynthRunner: SynthRunner = (prompt, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile("claude", CLAUDE_ARGS, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    // A dead/never-started process would otherwise turn a stdin write into an unhandled EPIPE.
    child.stdin?.on("error", () => {});
    child.stdin?.write(prompt);
    child.stdin?.end();
  });

export interface SynthInput {
  decision: string;
  options: string[];
  context?: string;
  personas: readonly CouncilPersonaResult[];
}

function personaLine(p: CouncilPersonaResult): string {
  if (!p.ok || p.topChoice === null || !p.risk) return `- ${p.label} (${p.lens}): no signal — ${p.error ?? "unavailable"}`;
  const top = p.distribution.find((d) => d.option === p.topChoice);
  const pct = top ? `${Math.round(top.probability * 100)}%` : "?";
  return (
    `- ${p.label} (${p.lens}): picks "${p.topChoice}" (${pct}, confidence ${p.confidence.toFixed(2)}) — ` +
    `risk: ${p.risk.level} (confidence ${p.risk.confidence.toFixed(2)})`
  );
}

/** Plain-text prompt: the decision, options, context, the Jev table, and a strict
 *  4-line output format so `parseSynthOutput` can pull it apart reliably. */
export function buildSynthPrompt(input: SynthInput): string {
  const optionsLine = input.options.map((o, i) => `${i + 1}) ${o}`).join("  ");
  const personaLines = input.personas.map(personaLine).join("\n");
  return [
    `Decision: ${input.decision}`,
    `Options: ${optionsLine}`,
    `Context: ${input.context && input.context.length > 0 ? input.context : "(none given)"}`,
    "",
    "Council scores (4 personas, each scored independently by Jev, a fast judgment model — not by you):",
    personaLines,
    "",
    "You are the final synthesis step. Write a short, decisive verdict. Reply with EXACTLY these four " +
      "lines, in this order, each starting with its label and nothing before PICK or after CHANGE:",
    "PICK: <the option you recommend>",
    "WHY: <1-3 sentences>",
    "DISSENT: <the strongest reason someone could reasonably disagree, 1-2 sentences>",
    "CHANGE: <one sentence: what new information would change this call>",
  ].join("\n");
}

const LABELS = ["PICK", "WHY", "DISSENT", "CHANGE"] as const;
type Label = (typeof LABELS)[number];
const LABEL_LINE_RE = /^(PICK|WHY|DISSENT|CHANGE):\s*(.*)$/i;

/** Line-based, case-insensitive, tolerant of multi-line values. Treats empty/too-short
 *  output as a failure — never trust a headless claude -p exit code alone. */
export function parseSynthOutput(raw: string): CouncilVerdict {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_SYNTH_CHARS) return { ok: false, unavailable: true, error: "empty or too-short output" };

  const sections: Record<Label, string[]> = { PICK: [], WHY: [], DISSENT: [], CHANGE: [] };
  let current: Label | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = LABEL_LINE_RE.exec(line);
    if (m) {
      current = m[1]!.toUpperCase() as Label;
      if (m[2]) sections[current].push(m[2]);
    } else if (current) {
      sections[current].push(line);
    }
  }
  const join = (l: Label): string | undefined => sections[l].join(" ").trim() || undefined;
  const pick = join("PICK");
  const why = join("WHY");
  if (!pick && !why) return { ok: true, why: trimmed.slice(0, 800) }; // no labels found: show the raw text rather than fail
  return { ok: true, pick, why, dissent: join("DISSENT"), changeMind: join("CHANGE") };
}

/** Runs the synthesis call end to end. Never throws: a timeout, a missing `claude`
 *  binary, or too-short output all come back as `{ ok: false, unavailable: true }` so
 *  the caller can still show the Jev table with "synthesis unavailable". */
export async function runCouncilSynth(input: SynthInput, runner: SynthRunner = realSynthRunner, timeoutMs = SYNTH_TIMEOUT_MS): Promise<CouncilVerdict> {
  const prompt = buildSynthPrompt(input);
  try {
    const { stdout } = await runner(prompt, timeoutMs);
    return parseSynthOutput(stdout);
  } catch (err) {
    return { ok: false, unavailable: true, error: String(err) };
  }
}
