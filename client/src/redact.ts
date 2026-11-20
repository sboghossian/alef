// ?redact=1: screenshot mode for anything shown publicly (alex.bio's slider). Agent titles
// (the first prompt, and Claude Code's own name for the session) and activity lines become
// neutral, and free text the store doesn't own (feed lines, live screens, 1:1 history, bubbles)
// is blurred by CSS (body.alef-redact in style.css). The world, counts and layout stay real.
// Read lazily: vitest runs in Node.

import type { AgentActivity, WorldAgent } from "../../shared/types";

let on: boolean | null = null;
export function redactOn(): boolean {
  on ??= typeof location !== "undefined" && new URLSearchParams(location.search).get("redact") === "1";
  return on;
}

export function redactAgent(a: WorldAgent): WorldAgent {
  return { ...a, title: `${a.islandId} session ${a.id.slice(0, 4)}`, displayName: null };
}

export function redactActivity(a: AgentActivity): AgentActivity {
  return { ...a, summary: a.toolName ?? a.stage };
}
