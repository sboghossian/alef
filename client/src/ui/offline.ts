import type { OfflineHandlers } from "../net";

/** Comic "world server is offline" card with a live countdown and a Retry button. */
export function mountOffline(): OfflineHandlers {
  const card = document.getElementById("offline");
  const countdown = document.getElementById("offline-countdown");
  const button = document.getElementById("offline-retry");
  if (!card || !countdown || !(button instanceof HTMLButtonElement)) {
    throw new Error("#offline card missing from index.html");
  }
  let retry: (() => void) | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  button.addEventListener("click", () => {
    countdown.textContent = "Knocking…";
    retry?.();
  });

  return {
    offline(nextRetryMs) {
      card.hidden = false;
      const due = Date.now() + nextRetryMs;
      if (ticker) clearInterval(ticker);
      const render = (): void => {
        const s = Math.max(0, Math.ceil((due - Date.now()) / 1000));
        countdown.textContent = s > 0 ? `Trying again in ${s}s` : "Knocking…";
      };
      render();
      ticker = setInterval(render, 250);
    },
    online() {
      card.hidden = true;
      if (ticker) clearInterval(ticker);
      ticker = null;
    },
    bindRetry(fn) {
      retry = fn;
    },
  };
}
