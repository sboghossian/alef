// Help content (map legend, every shortcut, three things to try), shown in the ? Help overlay
// (shell.ts openHelp), and the one-time welcome card (a modal dialog from ./kit).

import { markWelcomed, modalDialog, safeLocalStorage, shouldShowWelcome, type Dialog } from "./kit";

export interface Shortcut {
  keys: string[];
  what: string;
  where?: string;
}

/** Every keyboard shortcut the app handles. Keep in sync with main.ts / palette.ts / approvals.ts. */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["⌘K"], what: "Search everything (left sidebar): views, vault sections, projects, people, notes, agents, cities, files, commands, or ask Jev" },
  { keys: ["?"], what: "Open or close this Help" },
  { keys: ["1", "2", "3", "4", "5"], what: "Today · Work · World · Brain · Setup, the five destinations, each on the view you last used there. Again: the destination's next view" },
  { keys: ["V"], what: "Canvas: the orchestration graph in lanes (0 fits it, drag to pan). V again goes back" },
  { keys: ["6", "B"], what: "Board: every agent, grouped by what it is doing. B again goes back" },
  { keys: ["7", "8", "9"], what: "Voice · Code · Brain" },
  { keys: ["Esc"], what: "Close the top card or dialog, then go back to the previous view" },
  { keys: ["H"], what: "Hide the two side rails (the top bar stays); press again to bring them back" },
  { keys: ["F"], what: "Focus mode in any view (on Orbit: on the selected or hovered agent). F or Esc leaves" },
  { keys: ["Z"], what: "Zen mode: no UI, slow orbit. Any key or click comes back" },
  { keys: ["M"], what: "Play/pause Claude FM, the background radio" },
  { keys: ["↵"], what: "Start a new Claude session with the text you typed", where: "prompt box" },
  { keys: ["⇧↵"], what: "New line", where: "prompt box" },
  { keys: ["↑", "↓"], what: "Move through results", where: "search" },
  { keys: ["↵"], what: "Go to the result", where: "search" },
  { keys: ["⌘↵"], what: "Reactivate the agent in Terminal", where: "search" },
  { keys: ["⇧↵"], what: "Open the agent's folder in VS Code", where: "search" },
  { keys: ["A"], what: "Approve", where: "permission card" },
  { keys: ["D"], what: "Deny", where: "permission card" },
  { keys: ["hold"], what: "Hold Approve / Deny for 1 second", where: "Feed" },
];

export interface LegendEntry {
  glyph: string;
  name: string;
  what: string;
  /** CSS color for a swatch instead of a glyph. */
  swatch?: string;
  dashed?: boolean;
}

/** What each thing on the planet means. Ring colors match features/agent-state.ts. */
export const LEGEND: readonly LegendEntry[] = [
  { glyph: "🏙", name: "City", what: "A project folder you ran claude in. Its tag shows agents, live and today counts." },
  { glyph: "🏠", name: "House", what: "One Claude session. The roof is the agent's role color and fades as it gets older." },
  { glyph: "🚗", name: "Car", what: "A live agent. It drives to Harness City when it uses a skill, hook or MCP." },
  { glyph: "✈", name: "Plane", what: "A live agent flying to another district because it is reading or editing files there right now. Press 2 to ride along." },
  { glyph: "🌙", name: "Moon (Jev)", what: "The president. Click it to ask “who worked on…?” Jev is the only one Alef sends out to search the web (Search the web), and every search is kept, so what Jev found comes back later." },
  { glyph: "🌐", name: "Web trips", what: "In a house's panel: how often that session went onto the web on its own (search, fetch, browser, curl) and to how many sites. Sessions browse by themselves; Alef itself only sends Jev." },
  { glyph: "★", name: "Harness City", what: "Your skills, hooks and MCP servers as buildings. They grow as you use them." },
  { glyph: "🏭", name: "Factories", what: "Your scheduled routines (launchd). Green = last run OK, red = failed, grey = never ran." },
  { glyph: "", name: "Red dashed beam", what: "Two agents wrote the same file in the last 30 minutes.", swatch: "#ff3b3b", dashed: true },
  { glyph: "", name: "Green ring", what: "Agent is working.", swatch: "#2ecc71" },
  { glyph: "", name: "Red ring", what: "Agent needs your permission.", swatch: "#ff3b3b" },
  { glyph: "", name: "Amber ring", what: "Agent is waiting for your reply.", swatch: "#ffb21e" },
  { glyph: "", name: "Blue ring", what: "Agent is idle.", swatch: "#4aa3ff" },
  { glyph: "💥", name: "POW! / ZAP!", what: "A tool call just hit that building." },
  { glyph: "⛅", name: "Sky", what: "Real local weather and time of day. A storm cloud means CPU is over 80%." },
];

export const TRY_FIRST: readonly string[] = [
  "Press ⌘K, type a project name, press ↵. You fly straight there.",
  "Click any house to step into that agent's room, where you can resume it or open it in VS Code.",
  "Type a task in the prompt box (centred on 🏠 Home, at the bottom everywhere else), pick a city, press ↵. A new Claude session starts in Terminal.",
];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export function helpHtml(): string {
  const legend = LEGEND.map((l) => {
    const mark = l.swatch
      ? `<i class="help-swatch${l.dashed ? " dashed" : ""}" style="--sw:${l.swatch}"></i>`
      : `<span class="help-glyph">${esc(l.glyph)}</span>`;
    return `<li>${mark}<span><b>${esc(l.name)}</b> ${esc(l.what)}</span></li>`;
  }).join("");
  const keys = SHORTCUTS.map(
    (s) =>
      `<tr><td>${s.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(" ")}</td><td>${esc(s.what)}${s.where ? ` <span class="help-where">${esc(s.where)}</span>` : ""}</td></tr>`,
  ).join("");
  const tries = TRY_FIRST.map((t) => `<li>${esc(t)}</li>`).join("");
  return `
    <section class="help-sec help-try"><h3>Try these first</h3><ol>${tries}</ol></section>
    <section class="help-sec"><h3>What the planet shows</h3><ul class="help-legend">${legend}</ul>
      <h4 class="help-roles-h">Agent role colors</h4><div id="hud-legend" class="help-roles"></div></section>
    <section class="help-sec"><h3>Keyboard</h3><table class="help-keys">${keys}</table></section>
    <div class="help-foot"><button id="help-tour" type="button" class="comic-btn small">▶ Take the tour (2 min)</button>
      <button id="help-welcome" type="button" class="comic-btn small secondary">Show the welcome card again</button></div>`;
}

export interface HelpApi {
  welcome: Dialog;
  /** Opens the welcome card on the very first visit only. */
  maybeWelcome(): void;
  /** Esc: closes the welcome card if it is open. True when it closed something. */
  escape(): boolean;
}

/** The help itself is the ? Help overlay (shell.ts renders helpHtml there); this wires the
 *  one-time welcome card. `openHelp` opens that overlay. */
export function mountHelp(openHelp: () => void): HelpApi {
  const welcomeRoot = document.getElementById("welcome");
  const welcomeCard = welcomeRoot?.querySelector<HTMLElement>(".welcome-card");
  if (!welcomeRoot || !welcomeCard) throw new Error("#welcome missing from index.html");

  const store = safeLocalStorage();
  const welcome = modalDialog(welcomeRoot, welcomeCard, "Welcome", () => markWelcomed(store));

  document.getElementById("welcome-ok")?.addEventListener("click", () => welcome.close());
  document.getElementById("welcome-help")?.addEventListener("click", () => {
    welcome.close();
    openHelp();
  });

  return {
    welcome,
    maybeWelcome() {
      if (shouldShowWelcome(store)) welcome.open(document.getElementById("welcome-ok"));
    },
    escape() {
      if (!welcome.isOpen()) return false;
      welcome.close();
      return true;
    },
  };
}
