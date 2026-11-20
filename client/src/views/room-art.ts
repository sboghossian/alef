// Inline SVG art for the Room: the model creature (same families and colours as the 3D
// creatures), the plant that grows with tokens, the uptime clock and a subagent drone.
// Pure string builders over numbers and enums only: no user text ever goes in here.

import type { LampMood, ModelKey, PlantStage } from "./room-lib";

const INK = "#1a1030";

export const FAMILY_HEX: Record<ModelKey, string> = {
  opus: "#ff6a1f",
  sonnet: "#ff9340",
  haiku: "#ffbe3b",
  fable: "#9d7bff",
  other: "#c9bfe0",
};

/** Spike length per family: opus is the big spiky one, haiku the small round-ish one. */
const SPIKE: Record<ModelKey, number> = { opus: 17, sonnet: 13, haiku: 8, fable: 0, other: 0 };

function eyes(mood: LampMood): string {
  if (mood === "sleep") {
    return `<path d="M40 50 q5 4 10 0 M60 50 q5 4 10 0" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
  }
  const big = mood === "alarm" || mood === "ask";
  const r = big ? 6 : 5;
  return `<ellipse cx="45" cy="50" rx="${r}" ry="${r + 2}" fill="${INK}"/><ellipse cx="65" cy="50" rx="${r}" ry="${r + 2}" fill="${INK}"/>` +
    `<circle cx="46.5" cy="47.5" r="1.8" fill="#fff"/><circle cx="66.5" cy="47.5" r="1.8" fill="#fff"/>`;
}

function mouth(mood: LampMood): string {
  if (mood === "alarm") return `<ellipse cx="55" cy="64" rx="4" ry="5" fill="${INK}"/>`;
  if (mood === "sleep") return `<path d="M50 64 q5 3 10 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  if (mood === "ask") return `<path d="M49 65 h12" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
  return `<path d="M48 62 q7 7 14 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
}

/** 110×110 creature. Starburst for opus/sonnet/haiku, a four-point star for fable, a blob otherwise. */
export function creatureSvg(family: ModelKey, mood: LampMood): string {
  const c = FAMILY_HEX[family];
  let body = "";
  if (family === "fable") {
    body = `<path d="M55 8 L66 44 L102 55 L66 66 L55 102 L44 66 L8 55 L44 44 Z" fill="${c}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`;
  } else if (SPIKE[family] > 0) {
    const n = 12;
    const r0 = 30;
    const r1 = r0 + SPIKE[family];
    const pts: string[] = [];
    for (let i = 0; i < n * 2; i++) {
      const a = (Math.PI * i) / n - Math.PI / 2;
      const r = i % 2 === 0 ? r1 : r0 - 2;
      pts.push(`${(55 + Math.cos(a) * r).toFixed(1)},${(57 + Math.sin(a) * r).toFixed(1)}`);
    }
    body = `<polygon points="${pts.join(" ")}" fill="${c}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>` +
      `<circle cx="55" cy="57" r="${r0 - 4}" fill="${c}"/>`;
  } else {
    body = `<ellipse cx="55" cy="60" rx="38" ry="33" fill="${c}" stroke="${INK}" stroke-width="4"/>`;
  }
  const cheeks = mood === "sleep" ? "" : `<circle cx="36" cy="60" r="4" fill="#ff8fb3" opacity=".8"/><circle cx="74" cy="60" r="4" fill="#ff8fb3" opacity=".8"/>`;
  return `<svg viewBox="0 0 110 110" class="rm-creature-svg" aria-hidden="true">${body}${cheeks}${eyes(mood)}${mouth(mood)}</svg>`;
}

/** 90×120 potted plant; the number of leaves / flowers follows the stage (0 = a seed in soil). */
export function plantSvg(stage: PlantStage): string {
  const pot = `<path d="M22 86 h46 l-6 30 h-34 z" fill="#ff8a5c" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/><rect x="18" y="80" width="54" height="10" rx="3" fill="#ffa37f" stroke="${INK}" stroke-width="4"/>`;
  if (stage === 0) return `<svg viewBox="0 0 90 120" aria-hidden="true">${pot}<ellipse cx="45" cy="78" rx="5" ry="3.5" fill="#8a5a2b" stroke="${INK}" stroke-width="2.5"/></svg>`;
  const height = [0, 18, 34, 48, 60, 72][stage]!;
  const top = 80 - height;
  const stem = `<path d="M45 80 C${stage > 2 ? 40 : 45} ${80 - height / 2} ${stage > 2 ? 50 : 45} ${top + 8} 45 ${top}" stroke="#2e9e4f" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  const leaves: string[] = [];
  const count = Math.min(8, stage * 2);
  for (let i = 0; i < count; i++) {
    const y = 76 - ((i + 1) * height) / (count + 1);
    const side = i % 2 === 0 ? -1 : 1;
    const x = 45 + side * 3;
    leaves.push(`<ellipse cx="${x + side * 10}" cy="${y.toFixed(1)}" rx="11" ry="6" transform="rotate(${side * -28} ${x + side * 10} ${y.toFixed(1)})" fill="${i % 3 === 0 ? "#6fd46b" : "#4cc35a"}" stroke="${INK}" stroke-width="3"/>`);
  }
  const flowers: string[] = [];
  if (stage >= 4) {
    const spots = stage === 5 ? [[45, top], [30, top + 16], [60, top + 12]] : [[45, top]];
    for (const [x, y] of spots) {
      flowers.push(
        `<g transform="translate(${x} ${y})">${[0, 72, 144, 216, 288].map((a) => `<ellipse rx="5" ry="8" transform="rotate(${a}) translate(0 -7)" fill="#ff7eb6" stroke="${INK}" stroke-width="2.5"/>`).join("")}<circle r="4.5" fill="#ffd23f" stroke="${INK}" stroke-width="2.5"/></g>`,
      );
    }
  } else leaves.push(`<ellipse cx="45" cy="${top}" rx="6" ry="9" fill="#6fd46b" stroke="${INK}" stroke-width="3"/>`);
  return `<svg viewBox="0 0 90 120" aria-hidden="true">${stem}${leaves.join("")}${flowers.join("")}${pot}</svg>`;
}

/** 80×80 wall clock with the session's uptime on its hands. */
export function clockSvg(hands: { hour: number; minute: number } | null): string {
  const ticks = Array.from({ length: 12 }, (_, i) => `<rect x="38.5" y="9" width="3" height="${i % 3 === 0 ? 9 : 5}" rx="1.5" fill="${INK}" transform="rotate(${i * 30} 40 40)"/>`).join("");
  const h = hands ?? { hour: 0, minute: 0 };
  return `<svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="35" fill="#fffdf6" stroke="${INK}" stroke-width="5"/>${ticks}` +
    `<rect x="37.5" y="20" width="5" height="22" rx="2.5" fill="${INK}" transform="rotate(${h.hour.toFixed(1)} 40 40)"/>` +
    `<rect x="38.5" y="12" width="3" height="30" rx="1.5" fill="#ff4d8d" transform="rotate(${h.minute.toFixed(1)} 40 40)"/>` +
    `<circle cx="40" cy="40" r="4.5" fill="#ffd23f" stroke="${INK}" stroke-width="2.5"/></svg>`;
}

export function droneSvg(): string {
  return `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="4" y="6" width="20" height="5" rx="2.5" fill="#bfe3ff" stroke="${INK}" stroke-width="2.5"/><rect x="36" y="6" width="20" height="5" rx="2.5" fill="#bfe3ff" stroke="${INK}" stroke-width="2.5"/>` +
    `<path d="M14 11 v6 M46 11 v6" stroke="${INK}" stroke-width="3"/><rect x="12" y="15" width="36" height="18" rx="9" fill="#5bd1ff" stroke="${INK}" stroke-width="3"/><circle cx="24" cy="24" r="3" fill="${INK}"/><circle cx="36" cy="24" r="3" fill="${INK}"/></svg>`;
}
