// The planet theme picker (World, Space, Archipelago, Snow globe, Blueprint), rendered from
// T's orbitThemes API. Compact (emoji row + name) in Orbit's sidebar section, full (emoji +
// name + blurb rows) in Settings. Returns an unsubscribe.

import { orbitThemes } from "../features/orbit-themes";
import { escapeHtml } from "../ui/fuzzy";

export function renderThemePicker(host: HTMLElement, compact: boolean): () => void {
  const wrap = document.createElement("div");
  wrap.className = compact ? "alef-theme alef-theme-compact" : "alef-theme";
  wrap.setAttribute("role", "radiogroup");
  wrap.setAttribute("aria-label", "Planet theme");
  const caption = document.createElement("p");
  caption.className = "alef-theme-cap";
  host.append(wrap);
  if (compact) host.append(caption);

  const draw = (): void => {
    const cur = orbitThemes.current();
    const list = orbitThemes.list();
    wrap.innerHTML = list
      .map(
        (t) => `<button type="button" role="radio" class="alef-theme-btn${t.id === cur ? " on" : ""}" data-theme="${escapeHtml(t.id)}" aria-checked="${t.id === cur}" title="${escapeHtml(`${t.name}: ${t.blurb}`)}" aria-label="${escapeHtml(t.name)}">
          <span class="alef-theme-emoji" aria-hidden="true">${escapeHtml(t.emoji)}</span>${compact ? "" : `<span class="alef-theme-text"><b>${escapeHtml(t.name)}</b><span>${escapeHtml(t.blurb)}</span></span>`}
        </button>`,
      )
      .join("");
    const info = list.find((t) => t.id === cur);
    caption.innerHTML = info ? `<b>${escapeHtml(info.name)}</b> · ${escapeHtml(info.blurb)}` : "";
  };
  wrap.addEventListener("click", (ev) => {
    const b = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[data-theme]") : null;
    const id = orbitThemes.list().find((t) => t.id === b?.dataset.theme)?.id;
    if (id) orbitThemes.set(id);
  });
  wrap.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    const list = orbitThemes.list();
    const i = list.findIndex((t) => t.id === orbitThemes.current());
    const next = list[(i + (ev.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
    if (!next) return;
    ev.preventDefault();
    orbitThemes.set(next.id);
    wrap.querySelector<HTMLElement>(`[data-theme="${CSS.escape(next.id)}"]`)?.focus();
  });
  draw();
  return orbitThemes.onChange(draw);
}
