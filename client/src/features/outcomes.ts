// "outcomes": the client's copy of every session's verdict (server/features/outcomes.ts). A tiny
// cache that round 2 (Board chips, panel rows, the Hall) only reads:
//   outcomeOf(id)  → "shipped" | "delivered" | "failed" | "stopped" | "abandoned" | "finished" |
//                    "active", or null: no outcome evidence, or not computed yet (never a failure)
//   onOutcomes(fn) → fn runs after every change; returns an unsubscribe.
//   outcomeChip(o) → the Board card / panel headline glyph for a KNOWN outcome, or null for
//                    "active"/"unknown" (no chip: a live agent's state already shows elsewhere,
//                    and "no outcome evidence" is a label, not a badge). One function so the Board
//                    and the panel can never draw two different chip sets for the same outcome.
//   OUTCOME_FILTER_LABEL → a label for every outcome, including the two with no chip, for the
//                    Board's sidebar filter (it counts all 8; the card only ever shows 6).
// The snapshot extra "outcomes.map" (page load, every WS reconnect) and each WS push carry the
// whole map, so each one replaces the cache. Both are validated before use.
//
// One agent-panel section (vision wave 4, generations and crews): "Shipped together", the other
// sessions whose outcome records name the same merged PR (family-lib.ts has the rule). Read from
// GET /api/outcomes (rows carry mergedPrs) when a house panel shows, reused for a minute, and
// re-read after every map change (family-lib.ts CrewCache). Where there is no crew it says which
// signal is missing, and while the server's first scan of the records runs it says "not known yet"
// instead. Titles render as text; PR links are built from owner/repo + number only.

import { agentTitle } from "../../../shared/display";
import { OUTCOMES_EXTRAS_KEY, parseOutcomesMap, parseOutcomesMessage, type KnownOutcome, type OutcomesMap, type SessionOutcome } from "../../../shared/features/outcomes";
import { log } from "../log";
import { runAction } from "../ui/action";
import { relativeTime } from "../ui/fuzzy";
import { CREW_RULE, CrewCache, crewCounts, crewsFor, noCrewText, townCrewLine } from "./family-lib";
import "./family.css";
import { h, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";

let current: OutcomesMap = {};
const listeners = new Set<() => void>();

function replace(next: OutcomesMap): void {
  current = next;
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      log.warn("outcomes", "a listener threw", String(err));
    }
  }
}

export function outcomeOf(id: string): KnownOutcome | null {
  return Object.hasOwn(current, id) ? (current[id] ?? null) : null;
}

export function onOutcomes(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The chip for a KNOWN outcome (Board card, panel headline): emoji + short word, in the one
 *  stable order the spec fixes (shipped, delivered, failed, stopped, abandoned, finished). "active"
 *  and "unknown" return null on purpose — no chip, not a blank chip. */
export function outcomeChip(outcome: SessionOutcome): { emoji: string; label: string } | null {
  switch (outcome) {
    case "shipped":
      return { emoji: "🎓", label: "shipped" };
    case "delivered":
      return { emoji: "📦", label: "delivered" };
    case "failed":
      return { emoji: "✗", label: "failed" };
    case "stopped":
      return { emoji: "⏸", label: "stopped" };
    case "abandoned":
      return { emoji: "⌛", label: "abandoned" };
    case "finished":
      return { emoji: "✓", label: "finished" };
    case "active":
    case "unknown":
      return null;
  }
}

/** Sidebar filter label for every outcome, including the two with no card chip. */
export const OUTCOME_FILTER_LABEL: Readonly<Record<SessionOutcome, string>> = {
  shipped: "Shipped",
  delivered: "Delivered",
  failed: "Failed",
  stopped: "Stopped",
  abandoned: "Abandoned",
  finished: "Finished",
  active: "Active now",
  unknown: "No outcome evidence",
};

// ---------------------------------------------------------------- "Shipped together" (crews)

const CREWS_SLOT = "fx-crews";
const CREWS_SHOWN = 6;

/** When to read GET /api/outcomes again, and the last good copy (family-lib.ts CrewCache). */
const crewCache = new CrewCache(60_000);

function refreshCrews(ctx: ClientContext): void {
  refreshAgentPanel(CREWS_SLOT, (id, slot) => renderCrews(id, slot, ctx));
}

function loadCrews(ctx: ClientContext): void {
  crewCache.begin(Date.now());
  // getJson never throws: it resolves null on any failure, which settle() tells apart from data.
  void ctx.api.getJson<unknown>("/api/outcomes", 15_000).then((body) => {
    crewCache.settle(body, Date.now());
    refreshCrews(ctx);
  });
}

function partnerEl(ctx: ClientContext, id: string): HTMLElement {
  const agent = ctx.store.agents.get(id);
  if (!agent) return h("span", "fam-gone", `a session no longer in the world (${id.slice(0, 8)})`);
  const b = h("button", "fam-link", agentTitle(agent));
  b.type = "button";
  b.title = "Fly to this session's house";
  b.addEventListener("click", () => {
    void runAction({
      label: "Fly to the session",
      run: async () => {
        if (!ctx.store.agents.has(id)) return { ok: false, error: "that session is no longer in the world" };
        ctx.flyTo(id);
        return { ok: true };
      },
      success: () => null,
      toast: ctx.toast,
      button: b,
    });
  });
  return b;
}

function renderCrews(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  if (crewCache.due(Date.now())) loadCrews(ctx);
  const head = h("h3", undefined, "Shipped together");
  head.title = CREW_RULE;
  slot.replaceChildren(head);
  const held = crewCache.held;
  if (!held) {
    slot.append(h("p", "fam-note", crewCache.unknown ? "Unknown: the outcome records (GET /api/outcomes) couldn't be read." : "Checking the outcome records…"));
    return;
  }
  const mine = crewsFor(agentId, held.crews);
  if (mine.length === 0) {
    const row = held.rows.find((r) => r.sessionId === agentId);
    slot.append(h("p", "fam-note", noCrewText(row ? row.mergedPrs.length : null, held.scan)));
  } else {
    const ul = h("ul", "fam-crews");
    for (const c of mine.slice(0, CREWS_SHOWN)) {
      const li = h("li");
      const a = h("a", undefined, `PR #${c.number}`);
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener";
      li.append(document.createTextNode("Shipped "), a, document.createTextNode(" together with "));
      c.partners.forEach((p, i) => {
        if (i > 0) li.append(document.createTextNode(", "));
        li.append(partnerEl(ctx, p));
      });
      li.append(h("span", "fam-tag", ` · ${c.repo}${c.mergedAt ? ` · merged ${relativeTime(c.mergedAt)}` : ""}`));
      ul.append(li);
    }
    slot.append(ul);
    if (mine.length > CREWS_SHOWN) slot.append(h("p", "fam-note", `+${mine.length - CREWS_SHOWN} more merged PRs shipped with other sessions`));
  }
  slot.append(h("p", "fam-note fam-town", townCrewLine(crewCounts(held.crews), held.scan)));
}

export const outcomesFeature: ClientFeature = {
  id: "outcomes",
  mount(ctx) {
    watchAgentPanel(CREWS_SLOT, (id, slot) => renderCrews(id, slot, ctx));
    // A new verdict can make a crew: re-read on the next render of an open house panel.
    onOutcomes(() => {
      crewCache.invalidate();
      refreshCrews(ctx);
    });
  },
  onSnapshot(world) {
    const map = parseOutcomesMap(world.extras?.[OUTCOMES_EXTRAS_KEY]);
    if (map) replace(map);
  },
  onMessage(msg) {
    const m = parseOutcomesMessage(msg.payload);
    if (m) replace(m.map);
  },
};
