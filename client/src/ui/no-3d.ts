// The 3D view's state, and the banner when it is not drawing: WebGL could not start (the degraded
// 2D-only boot) or its context was lost at runtime. The banner lives inside #app, the planet
// container, so a non-planet view never shows it (body.alef-no-planet hides #app). While 3D is
// down, body.alef-no-3d hides the canvas and every planet-pinned overlay (shell.css).

import { log } from "../log";
import type { SceneRig } from "../scene/rig";
import { registerSceneParts } from "../scene/scene-bus";
import { no3dCopy, watchGlContext, type GlDown, type GlStatus } from "../scene/webgl";

export interface GlStatusHandle {
  /** False when WebGL never started, and while its context is lost: skip every 3D frame. */
  drawing(): boolean;
}

function mountBanner(container: HTMLElement): { show(status: GlDown): void; hide(): void } {
  const root = document.createElement("div");
  root.id = "alef-no3d";
  root.setAttribute("role", "status");
  root.hidden = true;
  const card = document.createElement("div");
  card.className = "offline-card";
  const burst = document.createElement("div");
  burst.className = "offline-burst";
  const title = document.createElement("h2");
  const reason = document.createElement("p");
  reason.className = "no3d-reason";
  const hint = document.createElement("p");
  hint.className = "no3d-hint";
  const reload = document.createElement("button");
  reload.id = "alef-no3d-reload";
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => location.reload());
  card.append(burst, title, reason, hint, reload);
  root.append(card);
  container.append(root);
  return {
    show(status) {
      const copy = no3dCopy(status);
      burst.textContent = copy.burst;
      title.textContent = copy.title;
      reason.textContent = copy.reason;
      hint.textContent = copy.hint;
      root.hidden = false;
      document.body.classList.add("alef-no-3d");
    },
    hide() {
      root.hidden = true;
      document.body.classList.remove("alef-no-3d");
    },
  };
}

/** Publishes the 3D state on the scene bus, shows / hides the banner, and watches for a lost context. */
export function mountGlStatus(container: HTMLElement, rig: Pick<SceneRig, "gl" | "glFailure">): GlStatusHandle {
  const banner = mountBanner(container);
  const set = (status: GlStatus): void => {
    registerSceneParts({ webgl: status });
    if (status.state === "on") banner.hide();
    else banner.show(status);
  };
  const gl = rig.gl;
  if (!gl) {
    log.warn("webgl", `3D off, booting 2D-only: ${rig.glFailure}`);
    set({ state: "off", reason: rig.glFailure });
    return { drawing: () => false };
  }
  set({ state: "on" });
  const watch = watchGlContext(gl.renderer.domElement, {
    lost: () => {
      log.warn("webgl", "WebGL context lost: 3D paused, everything else keeps running");
      set({ state: "lost" });
    },
    restored: () => {
      log.info("webgl", "WebGL context restored: 3D resumes");
      set({ state: "on" });
    },
  });
  return { drawing: () => !watch.isLost() };
}
