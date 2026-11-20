// ✈️ Courier Run: the ride feature (features/courier) takes the camera. Leaving the view ends
// the ride (the hub restores the exact camera); ending the ride (Esc, the plane lands) brings
// the shell back to the previous view.

import type { AlefView, ViewContext } from "../shell/views";

let ctx: ViewContext | null = null;

export const courierView: AlefView = {
  id: "courier",
  emoji: "✈️",
  name: "Courier Run",
  hint: "Fly your plane: pick up parcels from working agents, deliver them to Harness City",
  usesPlanet: true,
  mount(_root, c) {
    ctx = c;
    if (!c.planet.startRide()) {
      c.toast("No plane can take off right now. Try again when an agent is flying.");
      window.setTimeout(() => c.showView("orbit"), 0);
    }
  },
  unmount() {
    ctx?.planet.endRide();
    ctx = null;
  },
};
