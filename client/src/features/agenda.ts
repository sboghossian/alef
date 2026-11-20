// "agenda" feature: a comic billboard building in Harness City + a "My agenda"
// chip/palette command that opens today's Calendar.app events (GET /api/agenda —
// lazy server-side: nothing is fetched until the panel is actually opened, so this
// never triggers macOS's Calendar permission prompt at boot).

import * as THREE from "three";
import type { AgendaResult } from "../../../shared/features/agenda";
import { escapeHtml } from "../ui/fuzzy";
import type { ClientContext, ClientFeature } from "./registry";

const BILLBOARD_W = 22;
const BILLBOARD_H = 13;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface Billboard {
  mesh: THREE.Mesh;
  draw(lines: readonly string[]): void;
}

/** Bright comic panel: cream background, thick black border — matches the world's style. */
function buildBillboard(): Billboard {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 300;
  const c2d = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BILLBOARD_W, BILLBOARD_H), material);
  mesh.name = "agenda-billboard";

  function draw(lines: readonly string[]): void {
    if (!c2d) return;
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    c2d.fillStyle = "#fff8e7";
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.lineWidth = 10;
    c2d.strokeStyle = "#20182b";
    c2d.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
    c2d.fillStyle = "#20182b";
    c2d.font = "900 34px Arial, sans-serif";
    c2d.fillText("TODAY'S AGENDA", 26, 56);
    c2d.strokeStyle = "#20182b";
    c2d.lineWidth = 3;
    c2d.beginPath();
    c2d.moveTo(26, 70);
    c2d.lineTo(canvas.width - 26, 70);
    c2d.stroke();
    c2d.font = "700 22px Arial, sans-serif";
    if (lines.length === 0) {
      c2d.fillText("Click ⌘K → “My agenda”", 26, 120);
    } else {
      lines.slice(0, 5).forEach((line, i) => c2d.fillText(line.length > 34 ? `${line.slice(0, 33)}…` : line, 26, 112 + i * 36));
    }
    texture.needsUpdate = true;
  }

  draw([]);
  return { mesh, draw };
}

function agendaLines(res: AgendaResult): string[] {
  if (!res.ok) return [res.permissionDenied ? "Calendar access not allowed" : "Calendar unavailable"];
  if (!res.today.length) return ["Nothing on the calendar today"];
  return res.today.map((e) => `${formatTime(e.start)}  ${e.title}`);
}

async function renderAgendaPanel(el: HTMLElement, ctx: ClientContext, billboard: Billboard | null): Promise<void> {
  el.innerHTML = `<div class="agenda-loading">Loading today's calendar…</div>`;
  const res = await ctx.api.getJson<AgendaResult>("/api/agenda", 10_000);
  if (!res) {
    el.innerHTML = `<div class="agenda-error">Couldn't reach the world server.</div>`;
    return;
  }
  billboard?.draw(agendaLines(res));
  if (!res.ok) {
    el.innerHTML = res.permissionDenied
      ? `<div class="agenda-error">Allow Calendar access for Terminal/Node in System Settings → Privacy &amp; Security → Calendars, then try again.</div>`
      : `<div class="agenda-error">${escapeHtml(res.error ?? "Calendar unavailable")}</div>`;
    return;
  }
  if (!res.today.length) {
    el.innerHTML = `<div class="agenda-empty">Nothing on the calendar today.</div>`;
    return;
  }
  const rows = res.today
    .map((e) => `<li><span class="agenda-time">${escapeHtml(formatTime(e.start))}</span><span class="agenda-title">${escapeHtml(e.title)}</span></li>`)
    .join("");
  const next = res.next ? `<div class="agenda-next">Next: ${escapeHtml(res.next.title)} in ${res.next.inMinutes} min</div>` : "";
  el.innerHTML = `<ul class="agenda-list">${rows}</ul>${next}`;
}

let billboard: Billboard | null = null;

/** The "courier" feature hides the billboard while you fly: it faces the camera, so a chase-cam fills with it. */
export function setAgendaBillboardVisible(on: boolean): void {
  if (billboard) billboard.mesh.visible = on;
}

export const agendaFeature: ClientFeature = {
  id: "agenda",
  mount(ctx) {
    billboard = buildBillboard();
    const top = ctx.cityPosition("harness");
    if (top) {
      // Planted just past the tower top, facing outward — a landmark, not an obstacle.
      billboard.mesh.position.copy(top).multiplyScalar(1.08);
      billboard.mesh.lookAt(0, 0, 0);
      billboard.mesh.rotateY(Math.PI);
      ctx.scene.add(billboard.mesh);
    }
  },
  onFrame(_dt, ctx) {
    // Always face the camera, like a real billboard (and the moon's face).
    billboard?.mesh.lookAt(ctx.camera.position);
  },
  paletteCommands(ctx) {
    return [
      {
        id: "my-agenda",
        title: "My agenda",
        meta: "today's Calendar.app events",
        keywords: ["calendar", "schedule", "today", "meetings"],
        kind: "agenda",
        run: () => ctx.openPanel("agenda"),
      },
    ];
  },
  panels: [
    {
      id: "agenda",
      title: "My agenda",
      render(el, ctx) {
        void renderAgendaPanel(el, ctx, billboard);
      },
    },
  ],
};
