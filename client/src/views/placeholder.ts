// A friendly "coming in wave 2" card for views that are registered but not built yet.
// Wave-2 builders replace the comingSoon(...) line in views/index.ts with their real view.

import { escapeHtml } from "../ui/fuzzy";
import type { AlefView } from "../shell/views";

export interface ComingSoon {
  id: string;
  emoji: string;
  name: string;
  keys?: string[];
  hint: string;
  /** What the finished view will do, one line each. */
  plans: string[];
  /** Optional "meanwhile" action that already works today. */
  meanwhile?: { label: string; run(ctx: Parameters<AlefView["mount"]>[1]): void };
}

export function comingSoon(spec: ComingSoon): AlefView {
  return {
    id: spec.id,
    emoji: spec.emoji,
    name: spec.name,
    keys: spec.keys,
    hint: spec.hint,
    mount(root, ctx) {
      root.innerHTML = `<div class="alef-card alef-soon">
        <div class="alef-burst" aria-hidden="true">SOON!</div>
        <div class="alef-soon-emoji" aria-hidden="true">${escapeHtml(spec.emoji)}</div>
        <h2>${escapeHtml(spec.name)} is coming in wave 2</h2>
        <p class="alef-soon-hint">${escapeHtml(spec.hint)}</p>
        <ul>${spec.plans.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
        <div class="alef-soon-actions">
          ${spec.meanwhile ? `<button type="button" class="comic-btn small" data-act="meanwhile">${escapeHtml(spec.meanwhile.label)}</button>` : ""}
          <button type="button" class="comic-btn small secondary" data-act="orbit">🌍 Back to Orbit</button>
        </div>
      </div>`;
      root.querySelector('[data-act="orbit"]')?.addEventListener("click", () => ctx.showView("orbit"));
      const m = spec.meanwhile;
      if (m) root.querySelector('[data-act="meanwhile"]')?.addEventListener("click", () => m.run(ctx));
    },
    unmount() {},
  };
}
