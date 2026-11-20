// THE CHROME'S ICONS. The frame used to label itself in emoji: five group pills, the rail's
// tabs, the rail buttons and the floating pills. Emoji are full-colour pictures drawn by the
// OS, so the bar carried a dozen uncoordinated palettes before a single deliberate colour was
// spent -- and they are the one element of the frame that no theme and no token can reach.
//
// These are line icons instead: one 24-grid, one stroke weight, `currentColor`, so an icon is
// whatever colour the control it sits in is. That is what makes a selected pill able to invert
// to ink and take its icon with it (see --ch-on in chrome.css).
//
// SCOPE: the shell's own chrome, plus the handful of glyphs it repeats on every row (the Feed's
// kinds, the Town square, the search palette's groups, the prompt box's Automations button and
// the Health chip). The view modules keep their emoji on purpose -- they are content, they carry
// meaning the reader looks up (a station, a theme, an outcome), and there are 600 of them. `viewIcon` therefore falls back to the view's emoji whenever the chrome has
// no icon for it, so registering a view can never leave a button blank.

/** The 24x24 path data. Stroke-only: no fill, so every icon weighs the same on screen. */
const PATHS: Record<string, string> = {
  // --- the five destinations
  today: "M13 3 5 14h6l-1 7 8-11h-6z",
  world: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3.2 10h17.6M3.2 14h17.6M12 3c2.3 2.4 3.5 5.5 3.5 9S14.3 18.6 12 21c-2.3-2.4-3.5-5.5-3.5-9S9.7 5.4 12 3",
  work: "M14.5 3.5a4.5 4.5 0 0 0-5.9 5.7l-5 5a2 2 0 0 0 2.8 2.8l5-5a4.5 4.5 0 0 0 5.7-5.9l-2.7 2.7-2.1-2.1z",
  // (Brain is the brain view's icon, below.)
  setup: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.3 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1A1.6 1.6 0 0 0 10 2.9v-.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.2 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1",

  // --- the right rail's three tabs (Activity is the feed icon) and the panes inside them
  controls: "M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1M15 4.5v4M9 10v4M17 15.5v4",
  loops: "M3.5 9.5a6 6 0 0 1 6-6h5a6 6 0 0 1 0 12h-10M6.5 12.5l-3 3 3 3",
  feed: "M4.5 4.5h15v15h-15zM7.5 8h6M7.5 11.5h6M7.5 15h9M16.5 8v3.5",
  mac: "M4 5.5h16v10H4zM9 19.5h6M12 15.5v4",
  help: "M12 18.5v.01M9.3 9a2.8 2.8 0 1 1 3.4 3.3c-.5.2-.7.7-.7 1.2v.7M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.3 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1A1.6 1.6 0 0 0 10 2.9v-.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.2 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1",
  routines: "M4 20V9.5l5 3v-3l5 3V7l6-3v16zM8 20v-3.5h3V20",
  logs: "M5.5 4.5h9l4 4v11h-13zM14 4.5V9h4.5M8 13h8M8 16.5h5",

  // --- the views, for the flat bar behind the Settings flag and the sidebar rail
  home: "M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  board: "M4 5h5.5v14H4zM14.5 5H20v8h-5.5z",
  orbit: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9M4.7 8.6C2.9 9.8 1.9 11 2.1 12c.4 2 4.9 2.9 10 2s9-3.1 8.6-5.1c-.2-1-1.6-1.7-3.7-2",
  district: "M4 20V11l5-3v3l5-3v12zM17 20V6l3-2v16M7.5 16.5h2M7.5 13.5h2",
  room: "M4.5 19.5V7l7.5-3.5L19.5 7v12.5zM10 19.5v-5h4v5",
  courier: "M3.5 16.5V8h10v8.5zm10-5.5h3.5l3 3v2.5h-6.5M7 16.5a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 0 0-3.5 0M16 16.5a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 0 0-3.5 0",
  code: "M8.5 8.5 4 12l4.5 3.5M15.5 8.5 20 12l-4.5 3.5M13.5 5l-3 14",
  canvas: "M4.5 4.5h15v12h-15zM9 20h6M12 16.5V20",
  voice: "M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20",
  brain: "M12 4.2a3.4 3.4 0 0 0-5.9 2.3 3.2 3.2 0 0 0-1 5.3 3.3 3.3 0 0 0 1.6 5.4 3.3 3.3 0 0 0 5.3 1.6zm0 0a3.4 3.4 0 0 1 5.9 2.3 3.2 3.2 0 0 1 1 5.3 3.3 3.3 0 0 1-1.6 5.4 3.3 3.3 0 0 1-5.3 1.6zM12 4.2v15.6",
  system: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.3 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1A1.6 1.6 0 0 0 10 2.9v-.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.2 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1",
  capabilities: "M9 5 4 7v12l5-2 6 2 5-2V5l-5 2zM9 5v12M15 7v12",
  library: "M5 4.5h4V20H5zM11 4.5h3V20h-3zM16.6 5.2l3 .8L16.4 20l-2.9-.8z",
  health: "M3.5 12.5h4l2-5 3 9 2-4h6",

  // --- the odds and ends the shell draws itself
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M15.8 15.8 20 20",
  filters: "M4 6.5h16M7 12h10M10 17.5h4",
  focus: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3",
  panels: "M4 6h16M4 12h16M4 18h16",
  welcome: "M4.5 5.5h15v13h-15zM4.5 9.5h15M8 13h8",
  reset: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5V9H9",

  // --- the Feed's kinds, the Town square's urgencies and the search palette's groups: the
  // glyphs the frame repeats on every row, so the ones that most needed to stop being emoji
  bolt: "M13 3 5 14h6l-1 7 8-11h-6z",
  hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.6 15.4a1.6 1.6 0 0 1 2.4-2.1L8 14.5",
  hourglass: "M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4.5 4.5 5.5 4.5 8.5s-4.5 4-4.5 8.5M16.5 3.5c0 4.5-4.5 5.5-4.5 8.5s4.5 4 4.5 8.5",
  alert: "M12 4 2.8 19.5h18.4zM12 10v4.5M12 17v.01",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10",
  cap: "M12 5 2.5 9.5 12 14l9.5-4.5zM6.5 11.5V16c3 2.4 8 2.4 11 0v-4.5M21.5 9.5v5",
  message: "M4.5 5.5h15v10h-8L7 19v-3.5H4.5z",
  report: "M6.5 3.5H14l4 4v13H6.5zM13.5 3.5V8H18M9.5 12.5h5M9.5 16h5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v5.5M12 7.5v.01",
  failure: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M9 9l6 6M15 9l-6 6",
  town: "M3.5 9.5 12 4l8.5 5.5zM5.5 9.5v8M10 9.5v8M14 9.5v8M18.5 9.5v8M3.5 20h17",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7.5V12l3 2",
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M15.5 8.5l-2 5-5 2 2-5z",
  agent: "M12 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7M5 20a7 7 0 0 1 14 0",
  note: "M5.5 3.5h13v17h-13zM8.5 8h7M8.5 11.5h7M8.5 15h4",
};

/** The icon called `name`, as an `<svg>` string, or null when there is none. */
export function icon(name: string, size = 19): string | null {
  const d = PATHS[name];
  if (!d) return null;
  return (
    `<svg class="alef-ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${d}"/></svg>`
  );
}

/** A view's icon, falling back to the emoji the view registered. `emoji` is already escaped
 *  by the caller when it is used; an icon needs no escaping because it is ours. */
export function viewIcon(id: string, emoji: string, size = 19): string {
  return icon(id, size) ?? emoji;
}
