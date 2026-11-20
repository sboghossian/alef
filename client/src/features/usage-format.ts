// Pure display formatting for the "usage" feature. Kept separate from usage.ts (DOM glue)
// so the formatting rules are unit-testable without a document.

/** "≈$0.00", "≈$1.23", "≈$142.07" — always the ≈ prefix (this is an estimate, never a bill). */
export function formatUsd(costUsd: number): string {
  const safe = Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0;
  return `≈$${safe.toFixed(2)}`;
}

/** "0h", "1.5h", "12h" — one decimal below 10h, whole hours at or above it. */
export function formatHours(activeMs: number): string {
  const hours = Number.isFinite(activeMs) ? Math.max(0, activeMs) / 3_600_000 : 0;
  const rounded = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
  return `${rounded}h`;
}

/** The status-bar chip's exact label: "≈$X today · Yh". */
export function statusChipText(todayCostUsd: number, todayActiveMs: number): string {
  return `${formatUsd(todayCostUsd)} today · ${formatHours(todayActiveMs)}`;
}

/** "12,000 unpriced tokens" / "1 unpriced token" — omitted by the caller when 0. */
export function unpricedNote(unpricedTokens: number): string {
  const n = Math.max(0, Math.round(unpricedTokens));
  return `${n.toLocaleString()} unpriced token${n === 1 ? "" : "s"}`;
}
