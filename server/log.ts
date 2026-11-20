// Tiny logger. Never use console.log elsewhere in server/ — always go through this.
// Writes structured, timestamped lines to stderr so stdout stays free for any
// future piping and so logs never leak into HTTP/WS payloads.

type Level = "info" | "warn" | "error";

/** One line exactly as this logger wrote it to stderr. */
export interface LogLine {
  ts: string;
  level: Level;
  scope: string;
  message: string;
  extra?: unknown;
}

let listeners: ReadonlyArray<(line: LogLine) => void> = [];
let notifying = false;

/** Subscribes to every line this logger writes, right after the stderr write. A listener that
 *  itself logs never recurses (the notify pass is reentrancy-guarded), and a throwing listener
 *  never breaks logging. Returns an unsubscribe function. */
export function onLogLine(listener: (line: LogLine) => void): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function notify(line: LogLine): void {
  if (notifying) return; // a listener that logs must never recurse into another notify pass
  notifying = true;
  try {
    for (const listener of listeners) {
      try {
        listener(line);
      } catch {
        // a throwing listener never breaks logging
      }
    }
  } finally {
    notifying = false;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] [${scope}] ${message}`;
  if (extra !== undefined) {
    process.stderr.write(`${line} ${safeStringify(extra)}\n`);
  } else {
    process.stderr.write(`${line}\n`);
  }
  notify(extra !== undefined ? { ts, level, scope, message, extra } : { ts, level, scope, message });
}

export const log = {
  info(scope: string, message: string, extra?: unknown): void {
    write("info", scope, message, extra);
  },
  warn(scope: string, message: string, extra?: unknown): void {
    write("warn", scope, message, extra);
  },
  error(scope: string, message: string, extra?: unknown): void {
    write("error", scope, message, extra);
  },
};
