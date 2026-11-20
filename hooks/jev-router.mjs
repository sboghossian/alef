#!/usr/bin/env node
// UserPromptSubmit hook: the Jev router (round 10 §2). Fires on EVERY Claude Code prompt on
// this Mac (once installed — see scripts/install-jev-router-hook.mjs, which only PRINTS the
// settings.json diff and never writes it). Posts the prompt to Alef's server
// (server/features/router.ts, POST /api/router/route) and, if it answers in time, prints a
// binding route card (tier, effort, delegation rule, tool hints, notes) as `additionalContext`,
// and appends one prompt-free telemetry line to ~/.claude/logs/route-card.jsonl.
//
// Hard contract, verified from the raw Claude Code docs (2026-09-26): a UserPromptSubmit
// hook can return `additionalContext` (this script's whole job) but CANNOT switch the model
// or rewrite the prompt — so this is advice, never a command. Default hook timeout is 30s
// and a timed-out hook's output is discarded, but this script enforces its own tighter 2.5s
// budget so a dead/slow Alef server never makes every prompt on the machine feel sluggish.
//
// Fail-open, always: on ANY problem (server down, slow, non-200, bad JSON, no advice to
// give) this prints nothing and exits 0. It never blocks a prompt and never throws.
//
// Distinct from `prompt-memory-recall.py` (the "## Memory Recall" hook already registered
// ahead of this one): this hook's own heading is "## Dispatch card" ("## Route card" when
// the server sends no dispatch block) so the two blocks never look like a duplicated note
// list, and as the router takes over ranking for both, prompt-memory-recall.py is the one
// that gets retired — not this one duplicated beside it.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DISABLED_ENV = "JEV_ROUTER_DISABLED";
const ROUTE_URL = "http://127.0.0.1:5179/api/router/route";
const ORIGIN = "http://localhost:5178";
const HARD_TIMEOUT_MS = 2500;
const MAX_CONTEXT_CHARS = 900;
const MAX_PROMPT_CHARS_SENT = 4000; // matches the server's own MAX_PROMPT_CHARS cap
const MAX_TOOLS = 4;
const RULES_RE = /no Jev key|rate-limited|unavailable/i;

// A tier missing from this table is a tier whose card formatContext DROPS ENTIRELY (it
// returns null on an unrecognised model), so every member of shared/features/router.ts's
// ModelTier union has to appear here. Guarded by jev-router.test.mjs.
const TIER_LINES = {
  opus: "Effort high. Orchestration/architecture/security/taste work: keep it in this session; hand mechanical sub-steps (search, renames, boilerplate, scraping) to haiku or sonnet subagents that return conclusions, not file dumps.",
  fable:
    "Effort high. Legal drafting, document extraction, or a public artifact that will be judged on its quality: keep the writing itself in this session and hand research and file-wrangling to haiku or sonnet subagents. Fable draws usage down faster than opus, so do not sit on it for ordinary feature work.",
  sonnet:
    "Effort medium. Standard feature work: if it takes more than ~3 tool calls, hand execution to a sonnet subagent (effort: medium) and keep only its conclusion; smaller than that, do it inline.",
  haiku:
    "Mechanical work: if it takes more than ~3 tool calls, hand it to a haiku subagent; smaller than that, do it inline and keep the reply short.",
};

const TOOL_TABLE = [
  [/\blinear\b|\bGRO-\d+|\bticket\b/i, "Linear MCP"],
  [/\b(e-?mail|inbox|spark)\b/i, "spark CLI"],
  [/\b(calendar|meeting|agenda)\b/i, "spark CLI (calendar)"],
  [/\bposthog\b|\bsignups?\b|\bfunnel\b/i, "PostHog MCP"],
  [/\bfigma\b/i, "Figma MCP"],
  [/\bnotion\b/i, "Notion MCP"],
  [/\bhubspot\b|\bcrm\b/i, "HubSpot MCP"],
  [/\bhiggsfield\b/i, "Higgsfield MCP"],
  [/\b(pull request|PR #?\d+|github)\b/i, "gh CLI"],
  [/https?:\/\/|\bscreenshot\b|\bbrowse\b|\bqa\b/i, "/browse"],
  [/\bvercel\b|\bdeploy\b/i, "vercel / acme-deploy-verify"],
];

async function readStdin() {
  if (process.stdin.isTTY) return ""; // never hang waiting on a terminal (e.g. a manual run with no pipe)
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function extractPrompt(payload) {
  const raw = payload.prompt ?? payload.user_prompt ?? payload.message ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

/** Subagent hand-backs and task notifications also fire UserPromptSubmit; they are not Alex's
 *  prompts, so routing them would pollute the route log the Aleph brief counts. */
const HARNESS_TURN_RE = /<agent-message\b|\[Subagent hand-back\]|<task-notification>|^\s*\[SYSTEM NOTIFICATION/;

export function isHarnessTurn(prompt) {
  return HARNESS_TURN_RE.test(prompt);
}

function extractCwd(payload) {
  const raw = payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? "";
  return typeof raw === "string" ? raw : "";
}

function basenameWithParent(path) {
  const parts = String(path).split("/").filter(Boolean);
  if (parts.length === 0) return String(path);
  if (parts.length === 1) return parts[0];
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Confidence percent parsed from the server's `why`, or null. */
export function parseConfidence(why) {
  const m = /(\d{1,3})%\s*confidence/.exec(typeof why === "string" ? why : "");
  return m ? Number(m[1]) : null;
}

export function isRulesFallback(why) {
  return RULES_RE.test(typeof why === "string" ? why : "");
}

/** Unique tool hints from the prompt, in table order, capped at MAX_TOOLS.
 *
 *  The OFFLINE fallback only. When the server answers, its own tool list wins: the same
 *  keyword table runs there as the candidate generator and Jev then prunes it, so the
 *  server's answer is this list minus the tools the prompt does not actually need. This
 *  copy exists so the card still names tools with nothing listening — see serverTools. */
export function detectTools(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const out = [];
  for (const [re, name] of TOOL_TABLE) {
    if (re.test(text) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_TOOLS) break;
  }
  return out;
}

/** The server's pruned tool names, or null when it did not send any (an older server, or
 *  one that found no candidates) so the caller knows to fall back rather than treating an
 *  empty list as "no tools needed". */
export function serverTools(result) {
  const raw = result && Array.isArray(result.tools) ? result.tools : null;
  if (!raw || raw.length === 0) return null;
  const names = raw.filter((t) => t && typeof t.name === "string" && t.name.length > 0).map((t) => t.name);
  return names.length > 0 ? names.slice(0, MAX_TOOLS) : null;
}

const pct = (p) => `${Math.round(p * 100)}%`;

// A terse prompt ("pr", "switch", "all good?") answers something earlier in the
// conversation, which Jev never sees. Its pick of notes and questions is then a guess from
// two words: the first live day showed irrelevant notes and the same three generic questions
// on every such turn. The session's own context is the better guide there.
const TERSE_MAX_WORDS = 5;
const TERSE_MAX_CHARS = 40;

export function isTerse(prompt) {
  const p = typeof prompt === "string" ? prompt.trim() : "";
  return p.length <= TERSE_MAX_CHARS && p.split(/\s+/).filter(Boolean).length <= TERSE_MAX_WORDS;
}

/** The dispatch lines, or [] when the server sent no dispatch (rules fallback, an older
 *  server). History under 0.5 is the "act now" branch: the notes are left off the card on
 *  purpose, because reading them is exactly the cost that branch exists to skip. A terse
 *  prompt drops the notes and the questions (see isTerse), and "big" only says delegate
 *  when Jev is confident, since a low-confidence size is mostly noise. */
export function dispatchLines(d, notesText, { terse = false, confident = true } = {}) {
  if (!d || typeof d !== "object") return null;
  const lines = [];
  if (terse && typeof d.history === "number") {
    lines.push("Short reply: carry on from this session's context; no notes or questions from the card.");
  } else if (typeof d.history === "number") {
    lines.push(
      d.history < 0.5
        ? `History: not needed (${pct(d.history)}). Act now; fetch only if you hit an unknown.`
        : `History: needed (${pct(d.history)}).${notesText ? ` Read first, only these: ${notesText}` : " Check project memory first."}`,
    );
  } else if (notesText) {
    lines.push(`Related notes: ${notesText}`);
  }
  const plan = [];
  if (d.skill && typeof d.skill.name === "string") plan.push(`Skill: ${d.skill.name} (${pct(d.skill.p)})`);
  if (typeof d.web === "number") plan.push(`Web: ${d.web >= 0.5 ? "yes" : "no"}`);
  if (typeof d.deliver === "string") plan.push(`Deliver: ${d.deliver}`);
  if (typeof d.size === "string") {
    const big = confident ? " (delegate per the tier line)" : " (unsure; delegate only if the work proves big)";
    plan.push(`Size: ${d.size}${d.size === "big" ? big : d.size === "quick" ? " (inline, no planning step)" : ""}`);
  }
  if (plan.length > 0) lines.push(plan.join(" · "));
  const ask = Array.isArray(d.ask) ? d.ask.filter((q) => typeof q === "string").slice(0, 3) : [];
  if (ask.length > 0 && !terse) lines.push(`Ask Steph first, only these: ${ask.join(" | ")}`);
  return lines;
}

/** Builds the card, or null when there is no model pick at all. */
export function formatContext(result, tools = [], { terse = false } = {}) {
  if (!result || result.ok === false || !result.model) return null;
  const tier = TIER_LINES[result.model];
  if (!tier) return null;

  const why = typeof result.why === "string" ? result.why : "";
  const rules = isRulesFallback(why);
  const conf = parseConfidence(why);
  const source = rules ? "rules" : "Jev";
  const dispatch = result.dispatch && typeof result.dispatch === "object" ? result.dispatch : null;
  const name = dispatch ? "Dispatch card" : "Route card";
  const heading = conf !== null ? `## ${name} (Jev · ${result.model} · ${conf}%)` : `## ${name} (${source} · ${result.model})`;
  const lines = [heading, tier];

  if (tools.length > 0) {
    lines.push(
      `Tools: ${tools.join(", ")}. Check each against this session's MCP notices before starting; if one is down or needs auth, say so in your first line.`,
    );
  }
  if (rules || (conf !== null && conf < 50)) {
    lines.push("Low confidence: your judgment overrides this card; say which tier you used.");
  }

  const notes = Array.isArray(result.notes) ? result.notes.slice(0, 4) : [];
  const rendered = notes
    .filter((n) => n && typeof n.title === "string" && typeof n.path === "string")
    .map((n) => `${n.title} [${basenameWithParent(n.path)}]`)
    .join("; ");
  const extra = dispatchLines(dispatch, rendered, { terse, confident: !rules && (conf === null || conf >= 50) });
  if (extra) lines.push(...extra);
  else if (rendered) lines.push(`Related notes: ${rendered}`);

  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…` : text;
}

// ── Session cache ─────────────────────────────────────────────────────────────────────
// A short follow-up inside a task ("yes", "merge it", "fix that") does not need a new card:
// the last one is still in the session's context. Skipping the call saves the hook's
// latency and keeps the plan from changing under the work. The test is deliberately
// conservative: short, recent, and naming no tool the keyword table knows.

const FOLLOW_UP_MAX_CHARS = 80;
const CARD_FRESH_MS = 30 * 60_000;

function cacheFile(session) {
  const safe = String(session).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return safe ? join(homedir(), ".claude", "state", "dispatch-cache", `${safe}.json`) : null;
}

export function isFollowUp(prompt, lastCardAt, now = Date.now()) {
  if (typeof lastCardAt !== "number" || now - lastCardAt > CARD_FRESH_MS) return false;
  return prompt.length <= FOLLOW_UP_MAX_CHARS && detectTools(prompt).length === 0;
}

function readLastCardAt(session) {
  const file = session ? cacheFile(session) : null;
  if (!file) return null;
  try {
    const at = JSON.parse(readFileSync(file, "utf8")).at;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
}

function writeLastCardAt(session, at) {
  const file = session ? cacheFile(session) : null;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ at }));
  } catch {
    /* the cache is an optimisation; losing it only means one extra call */
  }
}

/** One telemetry record. Never contains the prompt text. `result` null means the server was down. */
export function buildLogEntry({ payload, cwd, result, tools, terse = false }) {
  const down = !result || !result.model;
  const why = down ? "" : typeof result.why === "string" ? result.why : "";
  return {
    ts: new Date().toISOString(),
    session: payload?.session_id ?? null,
    cwd,
    model: down ? null : result.model,
    confidence: down ? null : parseConfidence(why),
    tools,
    source: down ? "down" : isRulesFallback(why) ? "rules" : "jev",
    ...dispatchLog(result),
    ...(terse ? { terse: true } : {}),
  };
}

/** Prompt-free dispatch fields for the learning loop: what the card told the session. */
export function dispatchLog(result) {
  const d = result && result.dispatch && typeof result.dispatch === "object" ? result.dispatch : null;
  if (!d) return {};
  return {
    history: typeof d.history === "number" ? Math.round(d.history * 100) / 100 : null,
    web: typeof d.web === "number" ? Math.round(d.web * 100) / 100 : null,
    deliver: d.deliver ?? null,
    size: d.size ?? null,
    skill: d.skill?.name ?? null,
    asked: Array.isArray(d.ask) ? d.ask.length : 0,
  };
}

function appendLog(entry) {
  try {
    const file = process.env.ROUTE_CARD_LOG || join(homedir(), ".claude", "logs", "route-card.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    /* logging must never break a prompt */
  }
}

function printAdditionalContext(text) {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } })}\n`,
  );
}

async function fetchRoute(prompt, cwd) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  try {
    const res = await fetch(ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ prompt: prompt.slice(0, MAX_PROMPT_CHARS_SENT), cwd }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // network error, abort, or bad JSON: fail open
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (process.env[DISABLED_ENV] === "1") return;

  let payload;
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return; // malformed stdin: say nothing, never throw
  }
  if (typeof payload !== "object" || payload === null) return;

  const prompt = extractPrompt(payload);
  if (!prompt || isHarnessTurn(prompt)) return;
  const cwd = extractCwd(payload);
  const session = typeof payload.session_id === "string" ? payload.session_id : null;

  if (isFollowUp(prompt, readLastCardAt(session))) {
    appendLog({ ts: new Date().toISOString(), session, cwd, model: null, confidence: null, tools: [], source: "cached" });
    return; // the last card is still in context; say nothing
  }

  const result = await fetchRoute(prompt, cwd);
  // Jev's pruned list when the server answered, the local keyword table when it did not.
  const tools = serverTools(result) ?? detectTools(prompt);
  const terse = isTerse(prompt);
  appendLog(buildLogEntry({ payload, cwd, result, tools, terse }));

  const context = formatContext(result, tools, { terse });
  if (context) {
    printAdditionalContext(context);
    writeLastCardAt(session, Date.now());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch(() => {}) // never let an unexpected error surface as a nonzero exit or a stack trace
    .finally(() => process.exit(0));
}
