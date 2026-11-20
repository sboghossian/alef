// Desktop notification when an agent starts waiting on you — OPT-IN only. Alef is usually a
// background tab (VS Code in front): the inbox badge, sound and planet beacon are loud inside
// the tab, but nothing signals a wait outside it until this fires. The Settings toggle below is
// the only thing that ever calls Notification.requestPermission(), and only from its own click.
// Transition detection + dedupe (which agent just started waiting) is pure logic in waiting-lib.ts;
// this file is just the thin DOM/Notification/localStorage glue around it.

import type { WorldAgent } from "../../../shared/types";
import { agentTitle } from "../../../shared/display";
import { cityDisplayName } from "../ui/world";
import type { ClientContext, ClientFeature } from "./registry";
import { waitingIds, waitingTransition } from "./waiting-lib";

const NOTIFY_KEY = "agent-world.notify.waiting";

function readNotifyWanted(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false; // private mode / quota — stay opted out rather than assume consent
  }
}

function writeNotifyWanted(v: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function notifySupported(): boolean {
  return typeof Notification !== "undefined";
}

let notifyWanted = false;
let toggleBtn: HTMLElement | null = null;

function updateToggleButton(): void {
  if (!toggleBtn) return;
  toggleBtn.textContent = notifyWanted ? "🔔" : "🔕";
  toggleBtn.setAttribute("aria-pressed", String(notifyWanted));
  toggleBtn.dataset.label = notifyWanted ? "Notify: on" : "Notify: off";
}

/** Clicking the notification focuses the window and selects the agent — the same select/fly
 *  path the rest of the app uses (ClientContext.flyTo), not a bespoke one. */
function notifyAgentWaiting(agent: WorldAgent, city: string, ctx: ClientContext): void {
  const n = new Notification("Agent waiting on you", { body: `${agentTitle(agent)} · ${city}` });
  n.onclick = () => {
    window.focus();
    ctx.flyTo(agent.id);
    n.close();
  };
}

export const waitingNotifyFeature: ClientFeature = {
  id: "waiting-notify",
  mount(ctx) {
    notifyWanted = readNotifyWanted();
    toggleBtn = document.getElementById("hud-f-waiting-notify-toggle");
    updateToggleButton();

    // Seed silently from the very first snapshot: agents already waiting when the page loads
    // must never fire — only a genuine false → true transition afterwards does.
    let seen = waitingIds([...ctx.store.agents.values()]);

    const sync = (): void => {
      const agents = [...ctx.store.agents.values()];
      const { fired, now } = waitingTransition(seen, agents);
      seen = now;
      if (fired.length === 0 || !notifyWanted || !document.hidden) return;
      if (!notifySupported() || Notification.permission !== "granted") return;
      for (const id of fired) {
        const agent = ctx.store.agents.get(id);
        if (!agent) continue;
        const island = ctx.store.islands.get(agent.islandId);
        notifyAgentWaiting(agent, island ? cityDisplayName(island) : agent.islandId, ctx);
      }
    };
    ctx.store.onAgents(sync);
    ctx.store.onSnapshot(sync);
  },
  hudButtons: [
    {
      id: "toggle",
      label: "🔕",
      title: "Notify me when an agent waits on you",
      text: "Notify: off",
      onClick: (ctx) => {
        if (!notifySupported()) {
          ctx.toast("Desktop notifications aren't supported in this browser.", "error");
          return;
        }
        notifyWanted = !notifyWanted;
        writeNotifyWanted(notifyWanted);
        if (notifyWanted && Notification.permission === "default") void Notification.requestPermission();
        updateToggleButton();
        ctx.toast(notifyWanted ? "Notify me when an agent waits on you: on." : "Notify me when an agent waits on you: off.");
      },
    },
  ],
};
