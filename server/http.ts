// Tiny HTTP helpers shared by the hub (index.ts) and feature modules (server/features/*).

import type { IncomingMessage, ServerResponse } from "node:http";
import { gzip } from "node:zlib";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
/** JSON answers this big or bigger are gzipped for a client that accepts it; smaller ones aren't worth it. */
export const GZIP_MIN_BYTES = 32 * 1024;
/** On a 3.9 MB /api/world, level 6 (zlib's default) took ~1.6x level 4's time for ~3% less. */
const GZIP_LEVEL = 4;

/** What a JSON response said about itself, for the per-request action log (index.ts). */
export interface ResponseOutcome {
  /** The body's `ok`, when it had a boolean one. */
  ok: boolean | null;
  /** The body's `error`, when it had a string one. */
  error: string | null;
}

const outcomes = new WeakMap<ServerResponse, ResponseOutcome>();

/** The outcome respondJson recorded for this response; undefined when it never answered through it. */
export function responseOutcome(res: ServerResponse): ResponseOutcome | undefined {
  return outcomes.get(res);
}

export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  outcomes.set(res, {
    ok: isRecord(body) && typeof body.ok === "boolean" ? body.ok : null,
    error: isRecord(body) && typeof body.error === "string" ? body.error : null,
  });
  sendJson(res, status, JSON.stringify(body));
}

/** Like respondJson for a body that is already a JSON string (a cached, pre-serialised answer). */
export function respondJsonText(res: ServerResponse, status: number, json: string, outcome: ResponseOutcome = { ok: status < 400, error: null }): void {
  outcomes.set(res, outcome);
  sendJson(res, status, json);
}

/** True when the request that `res` answers says it takes gzip (Accept-Encoding, q>0). */
export function acceptsGzip(res: ServerResponse): boolean {
  const raw = res.req?.headers["accept-encoding"];
  const header = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  return header.split(",").some((part) => {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** A JSON body of GZIP_MIN_BYTES or more goes out gzipped when the client takes it. The deflate runs
 *  on libuv's thread pool, so a megabyte /api/world never blocks the event loop on it. */
function sendJson(res: ServerResponse, status: number, json: string): void {
  const data = Buffer.from(json);
  if (data.length < GZIP_MIN_BYTES || !acceptsGzip(res)) {
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
    res.end(data);
    return;
  }
  gzip(data, { level: GZIP_LEVEL }, (err, zipped) => {
    if (res.destroyed) return;
    if (err) {
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
      res.end(data);
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json", "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": zipped.length });
    res.end(zipped);
  });
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads and JSON-parses a request body, capped at MAX_REQUEST_BODY_BYTES. Rejects
 *  on an oversized body (destroying the request) or invalid JSON. */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        rejectPromise(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolvePromise(null);
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        rejectPromise(err);
      }
    });
    req.on("error", rejectPromise);
  });
}
