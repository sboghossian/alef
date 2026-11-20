// Pure logic for the Orbit's guided tour (round 11 C): the ~10 steps, the Next / Back / Skip / Esc
// state machine and the "auto-start at most once" rule. No DOM, no THREE: tour.ts flies the
// camera and draws the caption card. Unit-tested in tour-lib.test.ts.

/** Where the camera goes for a step. Places resolve through system-places.ts; "district" is the
 *  busiest district right now, "house" the most recently active live session (else any). */
export type TourTarget =
  | { kind: "overview" }
  | { kind: "district" }
  | { kind: "house" }
  | { kind: "place"; id: "jev" | "semantic" | "gate:UserPromptSubmit" | "plant:opus" }
  | { kind: "harness" }
  | { kind: "routines" }
  | { kind: "moon" };

export interface TourStep {
  id: string;
  title: string;
  caption: string;
  target: TourTarget;
  /** Camera height above the target (world units). */
  height: number;
}

/** ~12s per step: the whole tour reads in about two minutes. */
export const STEP_SECONDS = 12;

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "planet",
    title: "This is your fleet",
    caption: "Every Claude Code session on this Mac lives on this planet. Nothing here is made up: it all comes from your session files, hooks and settings.",
    target: { kind: "overview" },
    height: 0,
  },
  {
    id: "district",
    title: "Cities and continents",
    caption: "Each city is one project folder, and cities sit in topic continents (Website, GTM, Content…). This is the busiest city right now. Click one in the left sidebar's Districts to focus it.",
    target: { kind: "district" },
    height: 34,
  },
  {
    id: "house",
    title: "Houses are sessions",
    caption: "Each house is one session. A ring shows its state (working, waiting on you, idle), little stations beside it pop with the tool it is using, and drones are its subagents.",
    target: { kind: "house" },
    height: 24,
  },
  {
    id: "gates",
    title: "Hook gates",
    caption: "Your prompt first passes the hook gates: scripts Claude Code runs on each prompt, before each tool call, on permission asks and when a turn stops.",
    target: { kind: "place", id: "gate:UserPromptSubmit" },
    height: 16,
  },
  {
    id: "jev",
    title: "The Jev tower",
    caption: "Then it reaches Jev's router. Jev advises which model tier fits and which notes are worth reading. It advises; you stay in charge of the model.",
    target: { kind: "place", id: "jev" },
    height: 18,
  },
  {
    id: "plants",
    title: "Model power plants",
    caption:
      "Opus, Sonnet, Haiku and Fable each have a power plant. A plant's core grows with the live sessions running that model. Click one (Explain on) for the six-stage strip of how the model itself gets built.",
    target: { kind: "place", id: "plant:opus" },
    height: 18,
  },
  {
    id: "memory",
    title: "The Institute of Truth",
    caption:
      "The town's second brain, in three buildings: the episodic archive keeps what happened, the semantic library what's true, the procedural workshop what works. Sessions read from it as they wake; its card counts who really did.",
    target: { kind: "place", id: "semantic" },
    height: 16,
  },
  {
    id: "harness",
    title: "Harness City",
    caption: "The capital holds what all sessions share: skills (shops), hooks (arches) and MCP servers (antennas). The Tool Yard shows which built-in tools you use most.",
    target: { kind: "harness" },
    height: 30,
  },
  {
    id: "routines",
    title: "The routines factory",
    caption: "One factory per scheduled job. Green ran fine, red failed, smoke means it just ran.",
    target: { kind: "routines" },
    height: 24,
  },
  {
    id: "moon",
    title: "Jev, the moon",
    caption: "Jev also orbits as the moon: it answers \"who worked on X?\". Turn on Explain (E) any time to label everything; click a structure for its live numbers.",
    target: { kind: "moon" },
    height: 0,
  },
];

export interface TourState {
  active: boolean;
  index: number;
}

export const TOUR_IDLE: TourState = { active: false, index: 0 };

export type TourAction = { type: "start" } | { type: "next" } | { type: "back" } | { type: "skip" } | { type: "escape" } | { type: "goto"; index: number };

/** Next on the last step finishes; Back on the first stays; Skip / Esc end the tour anywhere. */
export function tourReducer(state: TourState, action: TourAction, steps = TOUR_STEPS.length): TourState {
  if (steps <= 0) return TOUR_IDLE;
  switch (action.type) {
    case "start":
      return { active: true, index: 0 };
    case "next":
      if (!state.active) return state;
      return state.index + 1 >= steps ? TOUR_IDLE : { active: true, index: state.index + 1 };
    case "back":
      if (!state.active) return state;
      return { active: true, index: Math.max(0, state.index - 1) };
    case "skip":
    case "escape":
      return TOUR_IDLE;
    case "goto":
      if (!state.active || !Number.isInteger(action.index)) return state;
      return { active: true, index: Math.min(steps - 1, Math.max(0, action.index)) };
  }
}

export interface TourMemory {
  /** The user finished or skipped the tour at least once. */
  seen: boolean;
  /** The tour already started on its own once (it never does again). */
  autoStarted: boolean;
}

/** Parses the stored flags; anything malformed counts as "never". */
export function parseTourMemory(raw: string | null): TourMemory {
  if (!raw) return { seen: false, autoStarted: false };
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return { seen: false, autoStarted: false };
    const o = v as Record<string, unknown>;
    return { seen: o.seen === true, autoStarted: o.autoStarted === true };
  } catch {
    return { seen: false, autoStarted: false };
  }
}

/** Auto-start only once ever, only after the welcome card was dismissed, never if the tour was
 *  already seen. Automation (webdriver, ?perf, ?tour=0) is ruled out by the caller. */
export function shouldAutoStart(mem: TourMemory, welcomed: boolean): boolean {
  return welcomed && !mem.seen && !mem.autoStarted;
}

/** A tour that auto-started but was never finished or skipped (the tab closed or reloaded mid-tour)
 *  left {seen:false, autoStarted:true}: it would never start again, nor count as seen. On the next
 *  load that counts as seen (Help offers it any time); returns the memory to write, or null. */
export function recoverStuckTour(mem: TourMemory): TourMemory | null {
  return mem.autoStarted && !mem.seen ? { seen: true, autoStarted: true } : null;
}

/** "Step 3 of 10" */
export function stepCounter(index: number, total = TOUR_STEPS.length): string {
  return `Step ${Math.min(total, index + 1)} of ${total}`;
}
