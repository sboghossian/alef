import type { ServerMessage, WorldSnapshot } from "../../shared/types";
import { log } from "./log";

export interface DataSource {
  world: WorldSnapshot;
  onMessage(handler: (msg: ServerMessage) => void): void;
}

export interface OfflineHandlers {
  /** Called on every failed attempt with the delay before the next automatic retry. */
  offline(nextRetryMs: number, error: unknown): void;
  /** Called once the world has loaded. */
  online(): void;
  /** Lets the UI trigger an immediate retry (Retry button). */
  bindRetry(retryNow: () => void): void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** 1s, 2s, 4s, ... capped at 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, attempt));
}

async function fetchWorld(timeoutMs = 10_000): Promise<WorldSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/world", { signal: controller.signal });
    if (!res.ok) throw new Error(`GET /api/world -> ${res.status}`);
    return (await res.json()) as WorldSnapshot;
  } finally {
    clearTimeout(timer);
  }
}

/** The /ws URL. `have` (the generatedAt of the world this tab just loaded) asks the server to skip
 *  the boot snapshot it would repeat and send only what changed since (shared/types.ts). */
export function wsUrl(loc: Pick<Location, "protocol" | "host">, have?: string): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws${have ? `?have=${encodeURIComponent(have)}` : ""}`;
}

/** Only the first connect says `have`: after a drop the tab may have missed pushes, so a reconnect
 *  always takes the server's full snapshot. */
function connectWs(onMessage: (msg: ServerMessage) => void, attempt = 0, have?: string): void {
  const ws = new WebSocket(wsUrl(location, have));
  let opened = false;

  ws.addEventListener("open", () => {
    opened = true;
  });
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as ServerMessage;
      onMessage(msg);
    } catch (err) {
      log.warn("net", "dropped malformed ws payload", err);
    }
  });
  ws.addEventListener("close", () => {
    const next = opened ? 0 : attempt + 1;
    const delay = backoffMs(next);
    log.warn("net", `ws closed, retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(() => connectWs(onMessage, next), delay);
  });
  ws.addEventListener("error", (err) => log.warn("net", "ws error", err));
}

/**
 * Loads the real world from the server. Never falls back to invented data:
 * while the server is unreachable it keeps retrying with backoff and tells
 * the UI (offline card) when the next attempt is due.
 */
export async function loadWorld(ui: OfflineHandlers): Promise<DataSource> {
  let wake: (() => void) | null = null;
  ui.bindRetry(() => wake?.());

  for (let attempt = 0; ; attempt++) {
    try {
      const world = await fetchWorld();
      log.info("net", `loaded live world: ${world.islands.length} islands, ${world.agents.length} agents`);
      ui.online();
      return { world, onMessage: (handler) => connectWs(handler, 0, world.generatedAt) };
    } catch (err) {
      const delay = backoffMs(attempt);
      log.warn("net", `world server unreachable, retrying in ${Math.round(delay / 1000)}s`, err);
      ui.offline(delay, err);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  }
}
