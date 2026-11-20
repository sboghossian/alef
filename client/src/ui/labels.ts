import * as THREE from "three";

export interface LabelTarget {
  id: string;
  text: string;
  count: string;
  anchor: THREE.Vector3;
  /** Bigger cities win ties when space is short. */
  weight: number;
  capital?: boolean;
}

export interface CityLabels {
  update(camera: THREE.Camera, width: number, height: number): void;
  /** Short stat lines pinned under the busiest cities' callouts (empty map = none). */
  setPinned(lines: Map<string, string>): void;
  /** Districts currently hidden (no session, no fossil, not harness): never scored/shown, even if
   *  they'd otherwise win a slot. Re-evaluated live — a set here is not a one-time filter, calling
   *  it again with a smaller set brings a label straight back with no rebuild. */
  setHidden(ids: ReadonlySet<string>): void;
}

const projected = new THREE.Vector3();
const toCam = new THREE.Vector3();
const normal = new THREE.Vector3();

/** Comic callouts for the ~12 most visible cities (6 on phones). Pure DOM, positioned per frame. */
export function mountCityLabels(
  targets: LabelTarget[],
  onClick: (id: string) => void,
  onHover: (id: string | null, rect: DOMRect | null) => void = () => undefined,
): CityLabels {
  const root = document.getElementById("labels");
  if (!root) throw new Error("#labels missing from index.html");
  const els = new Map<string, HTMLElement>();
  const widths = new Map<string, number>(); // cached so we never force layout per frame
  let hidden = new Set<string>();
  for (const t of targets) {
    const el = document.createElement("button");
    el.className = t.capital ? "callout capital" : "callout";
    el.type = "button";
    // The island id, not just the rendered text — two islands can share a display name (e.g.
    // both showing as "Vault" before the id-based fix, or any two projects a user happens to
    // name the same). Callers that need to match "this callout's city" (orbit-filters' district
    // dimming) key off this, never off .callout-name's textContent.
    el.dataset.islandId = t.id;
    const name = document.createElement("span");
    name.className = "callout-name";
    name.textContent = t.text;
    const count = document.createElement("span");
    count.className = "callout-count";
    count.textContent = t.count;
    const stats = document.createElement("span");
    stats.className = "callout-stats";
    el.append(name, count, stats);
    el.hidden = true;
    el.addEventListener("click", () => onClick(t.id));
    el.addEventListener("mouseenter", () => onHover(t.id, el.getBoundingClientRect()));
    el.addEventListener("focus", () => onHover(t.id, el.getBoundingClientRect()));
    el.addEventListener("mouseleave", () => onHover(null, null));
    el.addEventListener("blur", () => onHover(null, null));
    root.appendChild(el);
    els.set(t.id, el);
  }

  return {
    setPinned(lines) {
      for (const [id, el] of els) {
        const stat = el.querySelector<HTMLElement>(".callout-stats");
        const line = lines.get(id);
        el.classList.toggle("pinned", Boolean(line));
        if (stat) stat.textContent = line ?? "";
        widths.delete(id);
      }
    },
    setHidden(ids) {
      hidden = new Set(ids);
    },
    update(camera, width, height) {
      const max = width < 520 ? 6 : 12;
      const scored: { t: LabelTarget; x: number; y: number; score: number }[] = [];
      const blockers = ["hud-card", "title", "modes", "panel", "districts", "ticker", "compass", "dispatch", "captions", "exploring"]
        .map((id) => document.getElementById(id))
        .filter((el): el is HTMLElement => el !== null && !el.hidden)
        .map((el) => el.getBoundingClientRect());
      for (const t of targets) {
        if (hidden.has(t.id)) continue;
        normal.copy(t.anchor).normalize();
        toCam.subVectors(camera.position, t.anchor).normalize();
        const facing = normal.dot(toCam);
        if (facing < 0.12) continue;
        projected.copy(t.anchor).project(camera);
        if (projected.z > 1 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05) continue;
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        if (y < 64) continue;
        if (blockers.some((r) => x > r.left - 70 && x < r.right + 70 && y > r.top - 4 && y < r.bottom + 34)) continue;
        const centre = 1 - Math.min(1, Math.hypot(projected.x, projected.y));
        scored.push({ t, x, y, score: facing * 1.5 + centre + t.weight * 0.8 + (t.capital ? 2 : 0) });
      }
      scored.sort((a, b) => b.score - a.score);
      const shown = new Set<string>();
      const placed: { x: number; y: number }[] = [];
      for (const s of scored) {
        if (shown.size >= max) break;
        if (placed.some((p) => Math.abs(p.x - s.x) < 90 && Math.abs(p.y - s.y) < 30)) continue;
        placed.push({ x: s.x, y: s.y });
        shown.add(s.t.id);
        const el = els.get(s.t.id);
        if (!el) continue;
        el.hidden = false;
        let w = widths.get(s.t.id);
        if (w === undefined || w === 0) {
          w = el.offsetWidth;
          widths.set(s.t.id, w);
        }
        const half = w / 2 + 4;
        const x = Math.min(Math.max(s.x, half), width - half);
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      }
      for (const [id, el] of els) if (!shown.has(id)) el.hidden = true;
    },
  };
}

export interface SpeechBubble {
  say(text: string, anchor: THREE.Vector3, until: number): void;
  zapAt(points: THREE.Vector3[], until: number): void;
  update(camera: THREE.Camera, width: number, height: number, elapsed: number): void;
}

/** Jev's speech bubble + "ZAP!" bursts over the cities a decision is about. */
export function mountSpeechBubble(): SpeechBubble {
  const bubble = document.getElementById("bubble");
  const zapRoot = document.getElementById("zaps");
  if (!bubble || !zapRoot) throw new Error("#bubble / #zaps missing from index.html");
  let anchor: THREE.Vector3 | null = null;
  let hideAt = 0;
  let zaps: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  let zapHideAt = 0;

  function place(el: HTMLElement, p: THREE.Vector3, camera: THREE.Camera, w: number, h: number): boolean {
    projected.copy(p).project(camera);
    if (projected.z > 1) return false;
    const half = Math.min(el.offsetWidth / 2 + 12, w / 2);
    const x = THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * w, half, w - half);
    const y = THREE.MathUtils.clamp((-projected.y * 0.5 + 0.5) * h, 120, h - 40);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    return true;
  }

  return {
    say(text, at, until) {
      bubble.textContent = text;
      anchor = at;
      hideAt = until;
      bubble.hidden = false;
      bubble.classList.remove("pop");
      void bubble.offsetWidth;
      bubble.classList.add("pop");
    },
    zapAt(points, until) {
      zapRoot.innerHTML = "";
      zaps = points.slice(0, 4).map((at) => {
        const el = document.createElement("div");
        el.className = "zap";
        el.textContent = "ZAP!";
        zapRoot.appendChild(el);
        return { el, at: at.clone() };
      });
      zapHideAt = until;
    },
    update(camera, w, h, elapsed) {
      if (anchor && elapsed < hideAt) {
        bubble.hidden = !place(bubble, anchor, camera, w, h);
      } else {
        bubble.hidden = true;
      }
      if (zaps.length && elapsed > zapHideAt) {
        zapRoot.innerHTML = "";
        zaps = [];
      }
      for (const z of zaps) z.el.hidden = !place(z.el, z.at, camera, w, h);
    },
  };
}
