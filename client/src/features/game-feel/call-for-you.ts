// P4a item 4 — "Waiting agents call for you": a house pulse (scene/agents.ts, via setCalling),
// a clickable speech bubble with the agent's real last question (redacted, capped, popping up
// every ~15s), a red "!" pip while a permission is pending, and a pooled off-screen edge arrow
// (pattern from courier/hud.ts) for callers you can't currently see. Clicking a bubble, pip or
// arrow dives into the agent's Room (round 11: the dedicated 1:1 view is gone, ctx.diveToRoom).
// A soft ding plays at most once per agent per state change into "waiting"/"permission" (the
// existing sound feature's courier cue, reused rather than adding a new one).
//
// Not a ClientFeature itself — built once and driven every frame by game-feel.ts.

import { agentTitle } from "../../../../shared/display";
import type { AgentState } from "../../../../shared/features/agent-state";
import { sceneParts } from "../../scene/scene-bus";
import { agentStateOf, STATE_LABELS } from "../agent-state";
import { h, overlayLayer, place, toScreen } from "../fleet-overlay";
import type { ClientContext } from "../registry";
import { playCue } from "../sound";
import { latestQuestionFor, sanitizeBubbleText } from "./game-feel-lib";

const BUBBLE_PERIOD_S = 15;
const BUBBLE_SHOW_S = 4.5;
const MAX_ARROWS = 6;
const BUBBLE_MAX_CHARS = 60;

interface CallState {
  state: AgentState;
  nextBubbleAt: number;
  bubbleUntil: number;
}

export interface CallForYou {
  /** Call every game-feel frame. */
  update(elapsed: number, ctx: ClientContext): void;
}

export function buildCallForYou(ctx: ClientContext): CallForYou {
  const states = new Map<string, CallState>();
  const bubbles = new Map<string, HTMLButtonElement>();
  const pips = new Map<string, HTMLButtonElement>();
  const layer = overlayLayer();

  const arrowEls: HTMLButtonElement[] = [];
  for (let i = 0; i < MAX_ARROWS; i++) {
    const a = h("button", "gf-arrow");
    a.type = "button";
    a.hidden = true;
    a.setAttribute("aria-label", "Jump to the agent calling for you");
    a.append(h("span", "gf-arrow-icon", "➔"), h("span", "gf-arrow-label"));
    a.addEventListener("click", () => {
      const id = a.dataset.agentId;
      if (id) ctx.diveToRoom(id);
    });
    layer.appendChild(a);
    arrowEls.push(a);
  }

  function dropBubble(id: string): void {
    bubbles.get(id)?.remove();
    bubbles.delete(id);
  }

  function dropPip(id: string): void {
    pips.get(id)?.remove();
    pips.delete(id);
  }

  function bubbleFor(id: string): HTMLButtonElement {
    let el = bubbles.get(id);
    if (!el) {
      el = h("button", "gf-bubble");
      el.type = "button";
      el.title = "Open its Room";
      el.addEventListener("click", () => ctx.diveToRoom(id));
      layer.appendChild(el);
      bubbles.set(id, el);
    }
    return el;
  }

  function pipFor(id: string): HTMLButtonElement {
    let el = pips.get(id);
    if (!el) {
      el = h("button", "gf-pip", "!");
      el.type = "button";
      el.title = "Needs your permission";
      el.addEventListener("click", () => ctx.diveToRoom(id));
      layer.appendChild(el);
      pips.set(id, el);
    }
    return el;
  }

  return {
    update(elapsed, ctx2) {
      const calling = new Set<string>();
      for (const a of ctx2.store.agents.values()) {
        const state = agentStateOf(a.id);
        if (state !== "waiting" && state !== "permission") continue;
        calling.add(a.id);
        let cs = states.get(a.id);
        if (!cs || cs.state !== state) {
          playCue("pickup"); // a soft ding, at most once per agent per state change
          cs = { state, nextBubbleAt: elapsed, bubbleUntil: elapsed + BUBBLE_SHOW_S };
          states.set(a.id, cs);
        }
        const anchor = ctx2.agentPosition(a.id);
        if (!anchor) continue;

        // Speech bubble: pops up for BUBBLE_SHOW_S every BUBBLE_PERIOD_S with the agent's real
        // last question (or a generic fallback), redacted and capped at 60 chars.
        if (elapsed >= cs.nextBubbleAt) {
          cs.bubbleUntil = elapsed + BUBBLE_SHOW_S;
          cs.nextBubbleAt = elapsed + BUBBLE_PERIOD_S;
        }
        const showBubble = elapsed < cs.bubbleUntil;
        const bubble = bubbleFor(a.id);
        bubble.hidden = !showBubble;
        if (showBubble) {
          const question = latestQuestionFor(ctx2.store.activities, a.id);
          const text = sanitizeBubbleText(question ?? STATE_LABELS[state], BUBBLE_MAX_CHARS);
          if (bubble.textContent !== text) bubble.textContent = text;
          place(bubble, toScreen(ctx2, anchor));
        }

        // "!" pip: only while a permission is pending.
        if (state === "permission") place(pipFor(a.id), toScreen(ctx2, anchor));
        else dropPip(a.id);
      }
      for (const id of [...states.keys()]) {
        if (calling.has(id)) continue;
        states.delete(id);
        dropBubble(id);
        dropPip(id);
      }
      sceneParts().agents?.setCalling(calling);

      // Off-screen edge arrows for callers you can't see right now.
      let ai = 0;
      for (const id of calling) {
        if (ai >= MAX_ARROWS) break;
        const anchor = ctx2.agentPosition(id);
        if (!anchor) continue;
        const sp = toScreen(ctx2, anchor);
        if (sp.visible) continue;
        const el = arrowEls[ai];
        if (!el) continue;
        el.hidden = false;
        el.dataset.agentId = id;
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const angle = Math.atan2(sp.x - cx, -(sp.y - cy));
        el.style.transform = `translate(${Math.round(cx + Math.sin(angle) * (cx - 44))}px, ${Math.round(cy - Math.cos(angle) * (cy - 44))}px)`;
        const icon = el.firstElementChild;
        if (icon instanceof HTMLElement) icon.style.transform = `rotate(${angle.toFixed(3)}rad)`;
        const label = el.lastElementChild;
        const agent = ctx2.store.agents.get(id);
        const shown = agent ? agentTitle(agent).slice(0, 24) : "";
        if (label && agent && label.textContent !== shown) label.textContent = shown;
        ai++;
      }
      for (; ai < MAX_ARROWS; ai++) {
        const el = arrowEls[ai];
        if (el) el.hidden = true;
      }
    },
  };
}
