// Tiny logger wrapper — the only place in the client allowed to touch console.*.
type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  const line = `[${scope}] ${message}`;
  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  if (extra !== undefined) target(line, extra);
  else target(line);
}

export const log = {
  info: (scope: string, message: string, extra?: unknown): void => emit("info", scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown): void => emit("warn", scope, message, extra),
  error: (scope: string, message: string, extra?: unknown): void => emit("error", scope, message, extra),
};
