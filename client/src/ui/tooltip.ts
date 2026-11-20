export interface TooltipApi {
  show(text: string, x: number, y: number): void;
  hide(): void;
}

export function mountTooltip(): TooltipApi {
  const el = document.getElementById("tooltip");
  if (!el) throw new Error("#tooltip missing from index.html");

  return {
    show(text, x, y) {
      el.textContent = text;
      el.style.left = `${x + 14}px`;
      el.style.top = `${y + 14}px`;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
  };
}
