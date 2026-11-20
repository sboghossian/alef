// Courier run DOM: the score HUD (#courier-hud — the root "hide all chrome" can collapse),
// the in-flight approval card (#courier-approval, deliberately OUTSIDE the HUD root so a
// hidden HUD can never hide what a real decision is about), edge arrows, the "near
// parcel" label, the delivery pop and the phone controls. All text via textContent.

import type { ApprovalView } from "../../../../shared/features/approvals";
import { h } from "../fleet-overlay";
import type { HoldAction } from "./hold";
import { PARCELS } from "./parcels";

export const STAGE_COLOR = { hook: "#ff8a3d", brain: "#ff6fb5", plan: "#7ad7ff", reason: "#b28dff", tool: "#ffd23f" } as const;

export interface RadarDot {
  /** -1..1 in plane space: x = right, y = ahead. */
  x: number;
  y: number;
  color: string;
  size: number;
}

export interface CourierHud {
  root: HTMLElement;
  show(on: boolean): void;
  setScore(points: number, helpedToday: number): void;
  setCombo(combo: number, windowLeft: number): void;
  setCarried(colors: readonly string[]): void;
  setBoost(meter: number, boosting: boolean): void;
  setStatus(text: string): void;
  setReplay(on: boolean): void;
  drawRadar(dots: readonly RadarDot[], count: number): void;
  pop(big: string, small: string, kind?: "deliver" | "approve" | "deny"): void;
  near(text: string | null, x: number, y: number, color: string): void;
  arrow(i: number, on: boolean, angle: number, label: string, kind: "beacon" | "hq" | "moon"): void;
  /** The in-flight approval card. */
  card: ApprovalCard;
  touch: TouchControls;
}

export interface ApprovalCard {
  el: HTMLElement;
  show(a: ApprovalView | null, who: string): void;
  /** Visible to the user right now (not hidden by any ancestor). */
  visible(): boolean;
  setHold(action: HoldAction | null, fill: number, boosting: boolean, secondsLeft: number): void;
  onHoldButton(fn: (action: HoldAction, down: boolean) => void): void;
}

export interface TouchControls {
  el: HTMLElement;
  enabled: boolean;
  /** -1..1 each; y up = climb. */
  stick: { x: number; y: number };
  boost: boolean;
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? "").trim();
}

/** "This really approves: Bash rm -rf dist" — the tool plus the concrete command/file. */
export function consequenceLine(a: ApprovalView): string {
  const detail = a.preview.kind === "command" ? firstLine(a.preview.body) || a.preview.title : a.preview.title || firstLine(a.preview.body);
  const text = `${a.toolName} ${detail}`.trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function mountCard(): ApprovalCard {
  const el = h("section", "cr-card");
  el.id = "courier-approval";
  el.hidden = true;
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-live", "assertive");
  const head = h("header", "cr-card-head");
  const bang = h("span", "cr-bang", "!");
  const title = h("h2", undefined, "Urgent delivery");
  const timer = h("span", "cr-timer", "");
  head.append(bang, title, timer);
  const who = h("div", "cr-who");
  const tool = h("div", "cr-tool");
  const toolName = h("span", "cr-toolname");
  const toolTitle = h("span", "cr-tooltitle");
  tool.append(toolName, toolTitle);
  const body = h("pre", "cr-body");
  const really = h("p", "cr-really");
  const row = h("div", "cr-holds");
  const mk = (action: HoldAction, key: string, label: string): HTMLButtonElement => {
    const b = h("button", `cr-hold cr-${action}`);
    b.type = "button";
    b.dataset.action = action;
    b.append(h("span", "cr-ring"), h("kbd", undefined, key), h("span", "cr-hold-label", label));
    b.title = `Hold ${key} (or press and hold here) for 1 second`;
    return b;
  };
  const approve = mk("allow", "A", "HOLD to approve");
  const deny = mk("deny", "D", "HOLD to deny");
  row.append(approve, deny);
  const hint = h("div", "cr-hint", "Fly away to skip · Shift (boost) disables deciding");
  el.append(head, who, tool, body, really, row, hint);
  document.body.appendChild(el);

  let shownId: string | null = null;
  let listener: ((action: HoldAction, down: boolean) => void) | null = null;
  for (const b of [approve, deny]) {
    const action = b.dataset.action === "allow" ? "allow" : "deny";
    b.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      b.setPointerCapture(ev.pointerId);
      listener?.(action, true);
    });
    const up = (): void => listener?.(action, false);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("lostpointercapture", up);
    // Keyboard activation of a focused button would be a single click, not a hold: ignore it.
    b.addEventListener("click", (ev) => ev.preventDefault());
  }

  return {
    el,
    show(a, whoText) {
      if (!a) {
        el.hidden = true;
        shownId = null;
        return;
      }
      el.hidden = false;
      if (a.id === shownId) return;
      shownId = a.id;
      who.textContent = whoText;
      toolName.textContent = a.toolName;
      toolTitle.textContent = a.preview.title;
      body.textContent = a.preview.body.split("\n").slice(0, 8).join("\n") || "(no details)";
      really.textContent = "";
      really.append(h("b", undefined, "This really approves: "), document.createTextNode(consequenceLine(a)));
    },
    visible: () => !el.hidden && el.getClientRects().length > 0,
    setHold(action, fill, boosting, secondsLeft) {
      approve.style.setProperty("--fill", String(action === "allow" ? fill : 0));
      deny.style.setProperty("--fill", String(action === "deny" ? fill : 0));
      approve.classList.toggle("on", action === "allow");
      deny.classList.toggle("on", action === "deny");
      el.classList.toggle("cr-boosting", boosting);
      hint.textContent = boosting ? "Let go of boost (Shift) to decide" : "Fly away to skip · Shift (boost) disables deciding";
      const t = `${secondsLeft}s`;
      if (timer.textContent !== t) timer.textContent = t;
    },
    onHoldButton(fn) {
      listener = fn;
    },
  };
}

function mountTouch(): TouchControls {
  const el = h("div", "cr-touch");
  el.id = "courier-touch";
  el.hidden = true;
  const base = h("div", "cr-stick");
  const knob = h("div", "cr-knob");
  base.appendChild(knob);
  base.setAttribute("aria-label", "Steer: drag left/right to turn, up/down to climb or dive");
  const boost = h("button", "cr-boost-btn", "BOOST");
  boost.type = "button";
  el.append(base, boost);
  document.body.appendChild(el);
  const t: TouchControls = { el, enabled: false, stick: { x: 0, y: 0 }, boost: false };
  let active: number | null = null;
  const move = (ev: PointerEvent): void => {
    const r = base.getBoundingClientRect();
    const rad = r.width / 2;
    let dx = (ev.clientX - (r.left + rad)) / rad;
    let dy = (ev.clientY - (r.top + rad)) / rad;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    t.stick.x = dx;
    t.stick.y = -dy;
    knob.style.transform = `translate(${Math.round(dx * rad * 0.6)}px, ${Math.round(dy * rad * 0.6)}px)`;
  };
  base.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    active = ev.pointerId;
    base.setPointerCapture(ev.pointerId);
    move(ev);
  });
  base.addEventListener("pointermove", (ev) => {
    if (ev.pointerId === active) move(ev);
  });
  const end = (): void => {
    active = null;
    t.stick.x = 0;
    t.stick.y = 0;
    knob.style.transform = "";
  };
  base.addEventListener("pointerup", end);
  base.addEventListener("pointercancel", end);
  boost.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    boost.setPointerCapture(ev.pointerId);
    t.boost = true;
    boost.classList.add("on");
  });
  const boostOff = (): void => {
    t.boost = false;
    boost.classList.remove("on");
  };
  boost.addEventListener("pointerup", boostOff);
  boost.addEventListener("pointercancel", boostOff);
  return t;
}

export function mountCourierHud(): CourierHud {
  const root = h("aside", "cr-hud");
  root.id = "courier-hud";
  root.hidden = true;
  root.setAttribute("aria-label", "Courier run");
  const top = h("div", "cr-top");
  const title = h("span", "cr-title", "COURIER RUN");
  const replay = h("span", "cr-replay", "REPLAY");
  replay.title = "Parcels replayed from today's real transcript events (not live)";
  replay.hidden = true;
  top.append(title, replay);
  const score = h("div", "cr-score");
  const points = h("b", "cr-points", "0");
  const pts = h("span", "cr-pts", "pts");
  score.append(points, pts);
  const helpedEl = h("div", "cr-helped", "0 agents helped today");
  const combo = h("div", "cr-combo");
  const comboText = h("span", "cr-combo-text", "");
  const comboBar = h("i", "cr-combo-bar");
  combo.append(comboText, comboBar);
  const carried = h("div", "cr-carried");
  carried.setAttribute("aria-label", "Parcels carried");
  const slots: HTMLElement[] = [];
  for (let i = 0; i < PARCELS.maxCarried; i++) {
    const s = h("i", "cr-slot");
    slots.push(s);
    carried.appendChild(s);
  }
  const boostRow = h("div", "cr-boost");
  const boostLabel = h("span", undefined, "BOOST");
  const boostBar = h("span", "cr-boost-bar");
  const boostFill = h("i");
  boostBar.appendChild(boostFill);
  boostRow.append(boostLabel, boostBar);
  const radar = h("canvas", "cr-radar");
  radar.width = 220;
  radar.height = 220;
  radar.setAttribute("aria-hidden", "true");
  const status = h("p", "cr-status");
  const hint = h("p", "cr-keys", "W/S climb·dive · A/D turn · Shift boost · Esc exit");
  const left = h("div", "cr-col");
  left.append(top, score, helpedEl, combo, carried, boostRow);
  root.append(left, radar, status, hint);
  document.body.appendChild(root);

  const arrows = h("div", "cr-arrows");
  arrows.id = "courier-arrows";
  arrows.hidden = true;
  const arrowEls: HTMLElement[] = [];
  for (let i = 0; i < 4; i++) {
    const a = h("div", "cr-arrow");
    a.append(h("i"), h("span"));
    a.hidden = true;
    arrowEls.push(a);
    arrows.appendChild(a);
  }
  document.body.appendChild(arrows);

  const nearEl = h("div", "cr-near");
  nearEl.id = "courier-near";
  nearEl.hidden = true;
  document.body.appendChild(nearEl);

  const popEl = h("div", "cr-pop");
  popEl.id = "courier-pop";
  popEl.hidden = true;
  document.body.appendChild(popEl);
  let popTimer: ReturnType<typeof setTimeout> | null = null;

  const g = radar.getContext("2d");
  let last = { points: -1, helped: -1, combo: -1, carried: "", status: "\u0000", boost: -1 };

  return {
    root,
    card: mountCard(),
    touch: mountTouch(),
    show(on) {
      root.hidden = !on;
      arrows.hidden = !on;
      if (!on) {
        nearEl.hidden = true;
        popEl.hidden = true;
      }
    },
    setScore(p, helpedToday) {
      if (p !== last.points) points.textContent = String(p);
      if (helpedToday !== last.helped) helpedEl.textContent = `${helpedToday} agent${helpedToday === 1 ? "" : "s"} helped today`;
      last.points = p;
      last.helped = helpedToday;
    },
    setCombo(c, windowLeft) {
      if (c !== last.combo) {
        comboText.textContent = c > 1 ? `COMBO ×${Math.min(c, PARCELS.maxMultiplier)}` : c === 1 ? "Deliver again within 20s for a combo" : "";
        combo.classList.toggle("hot", c > 1);
        last.combo = c;
      }
      comboBar.style.transform = `scaleX(${c > 0 ? windowLeft.toFixed(3) : "0"})`;
    },
    setCarried(colors) {
      const key = colors.join(",");
      if (key === last.carried) return;
      last.carried = key;
      slots.forEach((s, i) => {
        const c = colors[i];
        s.classList.toggle("full", c !== undefined);
        s.style.background = c ?? "";
      });
    },
    setBoost(meter, boosting) {
      const m = Math.round(meter * 100) / 100;
      if (m !== last.boost) boostFill.style.transform = `scaleX(${m})`;
      last.boost = m;
      boostRow.classList.toggle("on", boosting);
    },
    setStatus(text) {
      if (text === last.status) return;
      last.status = text;
      status.textContent = text;
      status.hidden = text === "";
    },
    setReplay(on) {
      replay.hidden = !on;
    },
    drawRadar(dots, count) {
      if (!g) return;
      const W = radar.width;
      const c = W / 2;
      const r = c - 10;
      g.clearRect(0, 0, W, W);
      g.fillStyle = "#fff8e7";
      g.strokeStyle = "#1a1030";
      g.lineWidth = 6;
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.lineWidth = 2;
      g.strokeStyle = "rgba(26,16,48,0.18)";
      g.beginPath();
      g.arc(c, c, r / 2, 0, Math.PI * 2);
      g.stroke();
      for (let i = 0; i < count; i++) {
        const d = dots[i];
        if (!d) continue;
        g.fillStyle = d.color;
        g.strokeStyle = "#1a1030";
        g.lineWidth = 3;
        g.beginPath();
        g.arc(c + d.x * r * 0.9, c - d.y * r * 0.9, d.size, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      // The plane: a chunky arrow pointing "ahead" (up).
      g.fillStyle = "#ff4d8d";
      g.strokeStyle = "#1a1030";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(c, c - 16);
      g.lineTo(c + 11, c + 11);
      g.lineTo(c, c + 5);
      g.lineTo(c - 11, c + 11);
      g.closePath();
      g.fill();
      g.stroke();
    },
    pop(big, small, kind = "deliver") {
      popEl.textContent = "";
      popEl.append(h("b", undefined, big), h("span", undefined, small));
      popEl.className = `cr-pop cr-pop-${kind}`;
      popEl.hidden = false;
      // Restart the CSS animation.
      void popEl.offsetWidth;
      popEl.classList.add("go");
      if (popTimer) clearTimeout(popTimer);
      popTimer = setTimeout(() => {
        popEl.hidden = true;
      }, 1600);
    },
    near(text, x, y, color) {
      if (text === null) {
        nearEl.hidden = true;
        return;
      }
      nearEl.hidden = false;
      if (nearEl.textContent !== text) nearEl.textContent = text;
      nearEl.style.borderColor = color;
      nearEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -140%)`;
    },
    arrow(i, on, angle, label, kind) {
      const a = arrowEls[i];
      if (!a) return;
      a.hidden = !on;
      if (!on) return;
      a.className = `cr-arrow cr-arrow-${kind}`;
      const w = window.innerWidth;
      const hgt = window.innerHeight;
      // On an ellipse hugging the screen edge; angle 0 = straight ahead (screen up).
      const x = w / 2 + Math.sin(angle) * (w / 2 - 44);
      const y = hgt / 2 - Math.cos(angle) * (hgt / 2 - 44);
      a.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      const icon = a.firstElementChild;
      if (icon instanceof HTMLElement) icon.style.transform = `rotate(${angle.toFixed(3)}rad)`;
      const span = a.lastElementChild;
      if (span && span.textContent !== label) span.textContent = label;
    },
  };
}
