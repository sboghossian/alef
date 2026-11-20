import * as THREE from "three";
import type { ActivityStage } from "../../../shared/types";

export const STAGES: ActivityStage[] = ["hook", "brain", "plan", "reason", "tool"];
const STAGE_LABEL: Record<ActivityStage, string> = {
  hook: "Hook",
  brain: "Brain",
  plan: "Plan",
  reason: "Reason",
  tool: "Tool",
};
// Tiny 12px glyphs (inline SVG, no icon font / CDN).
const STAGE_ICON: Record<ActivityStage, string> = {
  hook: '<path d="M7 1 3 7h3l-1 4 4-6H6z"/>',
  brain: '<path d="M4 2a2 2 0 0 0-2 2v1a2 2 0 0 0 0 3 2 2 0 0 0 2 2h1V2zm3 0v8h1a2 2 0 0 0 2-2 2 2 0 0 0 0-3V4a2 2 0 0 0-2-2z"/>',
  plan: '<path d="M2 2h8v1.6H2zm0 3.2h8v1.6H2zm0 3.2h5V10H2z"/>',
  reason: '<path d="M6 1l1.3 3.2L10.5 5 7.8 7l.8 3.4L6 8.6 3.4 10.4 4.2 7 1.5 5l3.2-.8z"/>',
  tool: '<path d="M9.6 1.2 7.8 3l1.2 1.2 1.8-1.8A3 3 0 0 1 7 6.4L2.8 10.6 1.4 9.2 5.6 5A3 3 0 0 1 9.6 1.2z"/>',
};

export interface PipTarget {
  agentId: string;
  anchor: THREE.Vector3;
  stage: ActivityStage;
  at: number; // ms timestamp of the stage
}

export interface Overlays {
  setPips(list: PipTarget[]): void;
  setAwaiting(list: { agentId: string; anchor: THREE.Vector3 }[]): void;
  burst(text: string, anchor: THREE.Vector3, kind?: "pow" | "dispatch"): void;
  update(camera: THREE.Camera, width: number, height: number): void;
}

const proj = new THREE.Vector3();
const toCam = new THREE.Vector3();

function onScreen(p: THREE.Vector3, camera: THREE.Camera, w: number, h: number, minFacing = 0.1): { x: number; y: number } | null {
  toCam.subVectors(camera.position, p).normalize();
  if (proj.copy(p).normalize().dot(toCam) < minFacing) return null;
  proj.copy(p).project(camera);
  if (proj.z > 1 || Math.abs(proj.x) > 1.02 || Math.abs(proj.y) > 1.02) return null;
  return { x: (proj.x * 0.5 + 0.5) * w, y: (-proj.y * 0.5 + 0.5) * h };
}

/** World-anchored comic overlays: stage pips over live houses, "!" over agents waiting on you, POW bursts. */
export function mountOverlays(onPick: (agentId: string) => void): Overlays {
  const root = document.getElementById("overlays");
  if (!root) throw new Error("#overlays missing from index.html");

  const pipEls = new Map<string, HTMLElement>();
  const bangEls = new Map<string, HTMLElement>();
  let pips: PipTarget[] = [];
  let awaiting: { agentId: string; anchor: THREE.Vector3 }[] = [];
  const bursts: { el: HTMLElement; anchor: THREE.Vector3; until: number }[] = [];
  // Last view, so a new burst is placed immediately instead of waiting a frame.
  let lastView: { camera: THREE.Camera; w: number; h: number } | null = null;

  function pipEl(agentId: string): HTMLElement {
    let el = pipEls.get(agentId);
    if (!el) {
      const btn = document.createElement("button");
      btn.type = "button";
      el = btn;
      el.className = "pip";
      el.innerHTML = STAGES.map(
        (s) => `<i data-stage="${s}" title="${STAGE_LABEL[s]}"><svg viewBox="0 0 12 12" aria-hidden="true">${STAGE_ICON[s]}</svg></i>`,
      ).join("");
      el.addEventListener("click", () => onPick(agentId));
      root!.appendChild(el);
      pipEls.set(agentId, el);
    }
    return el;
  }

  function bangEl(agentId: string): HTMLElement {
    let el = bangEls.get(agentId);
    if (!el) {
      const btn = document.createElement("button");
      btn.type = "button";
      el = btn;
      el.className = "bang";
      el.textContent = "!";
      el.title = "Waiting for your answer";
      el.setAttribute("aria-label", "Agent waiting for your answer: open it");
      el.addEventListener("click", () => onPick(agentId));
      root!.appendChild(el);
      bangEls.set(agentId, el);
    }
    return el;
  }

  return {
    setPips(list) {
      pips = list;
      for (const p of list) {
        const el = pipEl(p.agentId);
        el.querySelectorAll<HTMLElement>("i").forEach((i) => i.classList.toggle("on", i.dataset.stage === p.stage));
        el.setAttribute("aria-label", `stage: ${STAGE_LABEL[p.stage]}`);
      }
      const keep = new Set(list.map((p) => p.agentId));
      for (const [id, el] of pipEls) {
        if (!keep.has(id)) {
          el.remove();
          pipEls.delete(id);
        }
      }
    },

    setAwaiting(list) {
      awaiting = list;
      const keep = new Set(list.map((a) => a.agentId));
      for (const a of list) bangEl(a.agentId);
      for (const [id, el] of bangEls) {
        if (!keep.has(id)) {
          el.remove();
          bangEls.delete(id);
        }
      }
    },

    burst(text, anchor, kind = "pow") {
      const el = document.createElement("div");
      el.className = `burst ${kind}`;
      el.textContent = text;
      el.hidden = true;
      if (lastView) {
        const s0 = onScreen(anchor, lastView.camera, lastView.w, lastView.h, -0.05);
        if (s0) {
          el.hidden = false;
          el.style.transform = `translate(${Math.round(s0.x)}px, ${Math.round(s0.y)}px)`;
        }
      }
      root.appendChild(el);
      // ?slowfx=1 (debug, for software-GL screenshots at ~1 fps) stretches bursts to 6s.
      const slow = document.body.classList.contains("slowfx") ? 6 : 1;
      bursts.push({ el, anchor: anchor.clone(), until: performance.now() + (kind === "dispatch" ? 1800 : 1000) * slow });
      while (bursts.length > 6) bursts.shift()?.el.remove();
    },

    update(camera, w, h) {
      lastView = { camera, w, h };
      const max = w < 520 ? 4 : 10;
      const placed: { x: number; y: number }[] = [];
      // Keep pips off the city callouts.
      const labelRects = [...document.querySelectorAll<HTMLElement>("#labels .callout:not([hidden])")].map((el) =>
        el.getBoundingClientRect(),
      );
      const scored = pips
        .map((p) => ({ p, s: onScreen(p.anchor, camera, w, h) }))
        .filter((e): e is { p: PipTarget; s: { x: number; y: number } } => e.s !== null)
        .sort((a, b) => b.p.at - a.p.at);
      const shown = new Set<string>();
      for (const { p, s } of scored) {
        if (shown.size >= max) break;
        if (placed.some((q) => Math.abs(q.x - s.x) < 74 && Math.abs(q.y - s.y) < 20)) continue;
        if (labelRects.some((r) => s.x > r.left - 45 && s.x < r.right + 45 && s.y > r.top - 4 && s.y < r.bottom + 26)) continue;
        placed.push(s);
        shown.add(p.agentId);
        const el = pipEls.get(p.agentId);
        if (el) {
          el.hidden = false;
          el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
        }
      }
      for (const [id, el] of pipEls) if (!shown.has(id)) el.hidden = true;

      for (const a of awaiting) {
        const el = bangEls.get(a.agentId);
        if (!el) continue;
        const s = onScreen(a.anchor, camera, w, h);
        el.hidden = s === null;
        if (s) el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y - 22)}px) translate(-50%, -100%)`;
      }

      const now = performance.now();
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        if (!b) continue;
        if (now > b.until) {
          b.el.remove();
          bursts.splice(i, 1);
          continue;
        }
        const s = onScreen(b.anchor, camera, w, h, -0.05);
        b.el.hidden = s === null;
        if (s) b.el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
      }
    },
  };
}
