// 🏭 Routines: Setup's fourth tab (UX-9). The scheduled com.stephane.* routines as one page, the
// same live list the right rail's Controls › Routines pane shows (features/routines.ts draws both),
// so routines have one home in the bar instead of four half-homes. No filters: the shell hides the
// left sidebar for it.

import { currentRoutines, onRoutines, renderRoutinesPanel } from "../features/routines";
import type { AlefView } from "../shell/views";
import { viewState } from "../shell/view-state";
import "./routines.css";

let root: HTMLElement | null = null;
let stop: (() => void) | null = null;

export const routinesView: AlefView = {
  id: "routines",
  emoji: "🏭",
  name: "Routines",
  hint: "Your scheduled routines: when each runs next, how the last run ended, and its workflow to the prompt box",
  usesPlanet: false,
  mount(r, c) {
    root = document.createElement("section");
    root.className = "rt-root";
    root.setAttribute("aria-label", "Routines");
    const head = document.createElement("header");
    head.className = "rt-head";
    const h = document.createElement("h2");
    h.className = "rt-title";
    h.textContent = "Routines";
    const sub = document.createElement("p");
    sub.className = "rt-sub";
    sub.textContent = "Every com.stephane.* launchd routine on this Mac. Drag a row, or press → prompt, to run its workflow by hand.";
    head.append(h, sub);
    root.append(head);
    if (c.hasPanel("routines")) {
      const list = document.createElement("div");
      list.className = "rt-list";
      // None found: say it in the middle of the page with one way on (UX-11), not as a row.
      const none = viewState({ tone: "empty", title: "No routines on this Mac yet", detail: "Alef lists every com.stephane.* job in ~/Library/LaunchAgents. Machine shows the services plane they run on.", action: { label: "Open Machine", run: () => c.showView("system") } });
      const paint = (n: number): void => {
        list.hidden = n === 0;
        none.hidden = n > 0;
      };
      root.append(list, none);
      renderRoutinesPanel(list, c);
      paint(currentRoutines().length);
      stop = onRoutines((l) => paint(l.length));
    } else {
      root.append(viewState({ tone: "empty", title: "The routines feature is off", detail: "Turn it back on to list and run your routines here.", action: { label: "Open Machine", run: () => c.showView("system") } }));
    }
    r.append(root);
  },
  unmount() {
    stop?.();
    stop = null;
    root?.remove();
    root = null;
  },
};
