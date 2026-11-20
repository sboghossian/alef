// One empty / error / loading state for every view (UX-11): centred in the view, a title, at most
// one line of detail and at most ONE action, instead of a line tucked into a left-sidebar section
// ("Could not load…" under Stats · Zoom) or a dead "Couldn't load" with nothing to press.
// Styled by shell.css (.alef-state). DOM-light: the caller places it and removes it.

export interface ViewStateSpec {
  tone: "empty" | "error" | "loading";
  title: string;
  detail?: string;
  /** The one thing to do about it (Try again, Open Health…). None while loading. */
  action?: { label: string; run(): void };
  /** Fill the positioned parent (a graph stage) instead of sitting in the flow of a column. */
  overlay?: boolean;
}

/** The state's element. An error is an alert; empty and loading are a polite status. */
export function viewState(spec: ViewStateSpec): HTMLElement {
  const box = document.createElement("div");
  box.className = `alef-state alef-state-${spec.tone}${spec.overlay ? " alef-state-overlay" : ""}`;
  box.setAttribute("role", spec.tone === "error" ? "alert" : "status");
  const title = document.createElement("p");
  title.className = "alef-state-title";
  title.textContent = spec.title;
  box.append(title);
  if (spec.detail) {
    const detail = document.createElement("p");
    detail.className = "alef-state-detail";
    detail.textContent = spec.detail;
    box.append(detail);
  }
  if (spec.action && spec.tone !== "loading") {
    const { label, run } = spec.action;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "alef-state-action";
    b.textContent = label;
    b.addEventListener("click", run);
    box.append(b);
  }
  return box;
}
