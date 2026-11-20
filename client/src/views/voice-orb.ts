// The Voice view's big comic moon-face: a 2D canvas port of aleph's orb.js ideas (a fibonacci
// sphere of dots rotating in 3D, per-state params eased every frame, breathing with the audio
// level) redrawn in Alef's bright comic kit: a butter-yellow face with a thick ink outline, a
// hard offset shadow, cheeks, eyes that blink, and a mouth that opens with the amplitude.
// `easeOrb` / `ORB_STATES` are pure (voice-orb.test.ts); `mountOrb` is the canvas glue.

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export interface OrbParams {
  /** Halo dot hue. */
  hue: number;
  /** Radians per frame. */
  spin: number;
  /** Halo radius as a fraction of the face radius. */
  halo: number;
  /** Idle breathing depth. */
  pulse: number;
  /** How far the mouth opens at level 1 (fraction of the face radius). */
  mouth: number;
  /** Eye look-up offset (thinking), fraction of the face radius. */
  gaze: number;
}

export const ORB_STATES: Readonly<Record<OrbState, OrbParams>> = {
  idle: { hue: 262, spin: 0.004, halo: 1.28, pulse: 0.02, mouth: 0.05, gaze: 0 },
  listening: { hue: 152, spin: 0.008, halo: 1.36, pulse: 0.05, mouth: 0.08, gaze: 0 },
  thinking: { hue: 280, spin: 0.03, halo: 1.3, pulse: 0.03, mouth: 0.04, gaze: -0.07 },
  speaking: { hue: 335, spin: 0.012, halo: 1.42, pulse: 0.06, mouth: 0.26, gaze: 0 },
};

/** One easing step of the animated params toward `state` (k = 0..1 per frame). Pure. */
export function easeOrb(cur: OrbParams, state: OrbState, k = 0.08): OrbParams {
  const t = ORB_STATES[state];
  const mix = (a: number, b: number): number => a + (b - a) * k;
  return {
    hue: mix(cur.hue, t.hue),
    spin: mix(cur.spin, t.spin),
    halo: mix(cur.halo, t.halo),
    pulse: mix(cur.pulse, t.pulse),
    mouth: mix(cur.mouth, t.mouth),
    gaze: mix(cur.gaze, t.gaze),
  };
}

export interface OrbHandle {
  setState(s: OrbState): void;
  state(): OrbState;
  /** 0..1 audio amplitude (mic while listening, voice while speaking). */
  setLevel(v: number): void;
  /** Draw one frame (the view calls it from its own rAF loop). */
  frame(): void;
  destroy(): void;
}

function fib(n: number): Array<[number, number, number, number]> {
  const pts: Array<[number, number, number, number]> = [];
  const gold = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    pts.push([Math.cos(gold * i) * r, y, Math.sin(gold * i) * r, (i * 0.6180339) % 1]);
  }
  return pts;
}

const INK = "#1a1030";

export function mountOrb(canvas: HTMLCanvasElement, reducedMotion: boolean): OrbHandle {
  const g = canvas.getContext("2d");
  let state: OrbState = "idle";
  let cur: OrbParams = { ...ORB_STATES.idle };
  let level = 0;
  let smooth = 0;
  let rot = 0;
  let t = 0;
  let blinkAt = 90;
  const pts = fib(260);

  const resize = (): { w: number; h: number } => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 300;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  };

  function frame(): void {
    if (!g) return;
    const { w, h } = resize();
    t += 1;
    cur = easeOrb(cur, state);
    smooth += (level - smooth) * 0.3;
    rot += reducedMotion ? 0 : cur.spin + smooth * 0.01;
    g.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const breathe = 1 + (reducedMotion ? 0 : Math.sin(t * 0.04) * cur.pulse) + smooth * 0.06;
    const R = Math.min(w, h) * 0.3 * breathe;

    // halo: the rotating dot sphere, flattened into a ring of comic dots behind the face
    const sin = Math.sin(rot);
    const cos = Math.cos(rot);
    for (const [px, py, pz, seed] of pts) {
      const x = px * cos - pz * sin;
      const z = px * sin + pz * cos;
      const push = cur.halo + smooth * 0.25 * Math.sin(seed * 12 + t * 0.12);
      const depth = (z + 1) / 2;
      const sx = cx + x * R * push;
      const sy = cy + py * R * push;
      if (Math.hypot(sx - cx, sy - cy) < R * 1.02) continue; // hidden behind the face
      g.fillStyle = `hsla(${cur.hue + seed * 30}, 85%, ${58 - depth * 10}%, ${0.35 + depth * 0.6})`;
      g.beginPath();
      g.arc(sx, sy, 2 + depth * 3.2, 0, Math.PI * 2);
      g.fill();
    }

    // hard offset shadow, then the face with a thick ink outline
    g.fillStyle = INK;
    g.beginPath();
    g.arc(cx + R * 0.06, cy + R * 0.08, R, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffe98a";
    g.strokeStyle = INK;
    g.lineWidth = Math.max(3, R * 0.045);
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    // craters
    g.fillStyle = "#f5d566";
    for (const [dx, dy, r] of [[-0.45, -0.5, 0.13], [0.52, -0.3, 0.09], [0.4, 0.55, 0.11]] as const) {
      g.beginPath();
      g.arc(cx + dx * R, cy + dy * R, r * R, 0, Math.PI * 2);
      g.fill();
    }
    // cheeks
    g.fillStyle = "rgba(255, 77, 141, 0.45)";
    for (const side of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + side * R * 0.48, cy + R * 0.22, R * 0.13, R * 0.08, 0, 0, Math.PI * 2);
      g.fill();
    }
    // eyes (blink every few seconds; closed arcs while listening = "ears on")
    blinkAt -= 1;
    const blinking = !reducedMotion && blinkAt < 6;
    if (blinkAt < 0) blinkAt = 140 + Math.floor(((t * 7919) % 97) + 40);
    const eyeY = cy - R * 0.14 + cur.gaze * R;
    for (const side of [-1, 1]) {
      const ex = cx + side * R * 0.3;
      if (blinking) {
        g.strokeStyle = INK;
        g.lineWidth = Math.max(3, R * 0.04);
        g.beginPath();
        g.moveTo(ex - R * 0.08, eyeY);
        g.lineTo(ex + R * 0.08, eyeY);
        g.stroke();
      } else {
        g.fillStyle = INK;
        g.beginPath();
        g.ellipse(ex, eyeY, R * 0.075, R * 0.105, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#fff";
        g.beginPath();
        g.arc(ex + R * 0.025, eyeY - R * 0.04 + cur.gaze * R * 0.3, R * 0.028, 0, Math.PI * 2);
        g.fill();
      }
    }
    // mouth: a smile that opens into a comic "O" with the level
    const open = Math.max(0.02, cur.mouth * (state === "speaking" ? 0.35 + smooth * 1.4 : 0.6 + smooth));
    const my = cy + R * 0.3;
    g.lineWidth = Math.max(3, R * 0.04);
    g.strokeStyle = INK;
    if (open < 0.07) {
      g.beginPath();
      g.arc(cx, my - R * 0.1, R * 0.2, Math.PI * 0.18, Math.PI * 0.82);
      g.stroke();
    } else {
      g.fillStyle = "#7a1f3d";
      g.beginPath();
      g.ellipse(cx, my, R * 0.16, R * open, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = "#ff8fab";
      g.beginPath();
      g.ellipse(cx, my + R * open * 0.45, R * 0.09, R * open * 0.4, 0, 0, Math.PI);
      g.fill();
    }
    // thinking: three bouncing dots over the head
    if (state === "thinking") {
      for (let i = 0; i < 3; i++) {
        const bounce = reducedMotion ? 0 : Math.abs(Math.sin(t * 0.12 + i * 0.9)) * R * 0.08;
        g.fillStyle = INK;
        g.beginPath();
        g.arc(cx + (i - 1) * R * 0.18, cy - R * 1.2 - bounce, R * 0.045, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  return {
    setState(s) {
      state = s;
    },
    state: () => state,
    setLevel(v) {
      level = Math.max(0, Math.min(1, v));
    },
    frame,
    destroy() {
      g?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
