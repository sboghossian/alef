#!/usr/bin/env node
// Claude Code PermissionRequest hook → agent-world approval queue.
//
// Contract (plain Node, zero deps):
//   - World unreachable / errors / toggle OFF (204) → exit 0 with NO stdout, immediately.
//     Claude then shows its normal terminal permission prompt.
//   - Otherwise long-poll the world until it decides or 60s pass.
//     allow/deny → print the hookSpecificOutput decision JSON; passthrough/expired/timeout → silent exit 0.
//   - stdout carries nothing but that one decision line. Diagnostics go to stderr.
//
// Env overrides (tests): AGENT_WORLD_URL (default http://127.0.0.1:5179), AGENT_WORLD_DEADLINE_MS (60000).

import http from "node:http";

const BASE = new URL(process.env.AGENT_WORLD_URL || "http://127.0.0.1:5179");
const CONNECT_TIMEOUT_MS = 700;
const DEADLINE_MS = Number(process.env.AGENT_WORLD_DEADLINE_MS) || 60_000;
const POLL_REQUEST_MS = 30_000;
const MAX_POLL_FAILURE_MS = 5_000;
const MAX_STRING = 3_000;
const MAX_BODY_BYTES = 15_000;

const NOT_PERMISSIONS = new Set(["AskUserQuestion"]);

const started = Date.now();

function quit() {
  process.exit(0);
}

function warn(msg) {
  try {
    process.stderr.write(`[agent-world hook] ${msg}\n`);
  } catch {
    // nothing left to do
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

/** Trims every string so the payload fits the world's 16KB body cap. */
function trimStrings(v, depth = 0) {
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => trimStrings(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 50)) out[k] = trimStrings(x, depth + 1);
  return out;
}

/** One HTTP request: 700ms to connect, `totalMs` for the whole exchange. Resolves {status, body} or rejects. */
function request(method, path, body, totalMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: BASE.hostname,
        port: BASE.port || 80,
        method,
        path,
        headers: data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    const connectTimer = setTimeout(() => req.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    req.on("socket", (sock) => sock.once("connect", () => clearTimeout(connectTimer)));
    req.setTimeout(totalMs, () => req.destroy(new Error("request timeout")));
    req.on("error", (err) => {
      clearTimeout(connectTimer);
      reject(err);
    });
    req.on("close", () => clearTimeout(connectTimer));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function decide(behavior, message) {
  const decision = behavior === "deny" && typeof message === "string" && message ? { behavior, message } : { behavior };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }) + "\n", quit);
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return quit();
  }
  if (!payload || typeof payload !== "object") return quit();
  // Questions to the user are not permissions: "allow" would skip the question UI. Leave them to the terminal.
  if (NOT_PERMISSIONS.has(payload.tool_name)) return quit();

  let body = {
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    permission_mode: payload.permission_mode,
    hook_event_name: payload.hook_event_name,
    tool_name: payload.tool_name,
    tool_input: trimStrings(payload.tool_input ?? {}),
    tool_use_id: payload.tool_use_id,
    agent_world_hook: 1, // tells the world the real hook is installed (agent-state then trusts the queue)
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) body = { ...body, tool_input: {} };

  let created;
  try {
    created = await request("POST", "/api/approvals", body, 1_500);
  } catch {
    return quit(); // world closed: stay out of the way, silently
  }
  if (created.status !== 201) return quit(); // 204 = toggle OFF; anything else = fall through
  let id;
  try {
    id = JSON.parse(created.body).id;
  } catch {
    return quit();
  }
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return quit();

  let failingSince = 0;
  while (Date.now() - started < DEADLINE_MS) {
    const left = DEADLINE_MS - (Date.now() - started);
    let r;
    try {
      r = await request("GET", `/api/approvals/${id}`, undefined, Math.min(POLL_REQUEST_MS, Math.max(left, 1)));
    } catch {
      // The world may be restarting (tsx watch); give it a few seconds, then fall through.
      failingSince ||= Date.now();
      if (Date.now() - failingSince > MAX_POLL_FAILURE_MS) return quit();
      await new Promise((res) => setTimeout(res, 500));
      continue;
    }
    failingSince = 0;
    if (r.status !== 200) return quit();
    let result;
    try {
      result = JSON.parse(r.body);
    } catch {
      return quit();
    }
    if (result?.status === "pending") continue;
    if (result?.status === "decided" && (result.behavior === "allow" || result.behavior === "deny")) {
      return decide(result.behavior, result.message);
    }
    return quit(); // passthrough / expired
  }
  return quit();
}

main().catch((err) => {
  warn(String(err));
  quit();
});
