// P4a — "Game feel: world life & feedback" (round 10). The headline ask: the planet is never
// still, every agent's state reads at a glance like units in an RTS, finishing work gets
// celebrated, and waiting agents come to you. This file is the thin ClientFeature that wires the
// sub-modules into the store and the frame loop; the real work lives in:
//   life.ts          — state -> creature animation (item 1), day/night + birds (item 5), arrivals (item 6)
//   celebrate.ts      — DONE!/SHIPPED!/subagent-done payoffs + confetti + the retire puff (item 3)
//   call-for-you.ts   — the house pulse, speech bubble, "!" pip and off-screen arrows (item 4)
//   stations-props.ts — the tool-station markers at every live agent's lot (item 2)
//   game-feel-lib.ts  — every pure mapping/rate-limit the above use, unit tested
//
// P4b's quality.ts (already landed) scales this feature's effects by render tier and owns the
// "Quality" Settings row; this feature registers its ready-made hudButton and each sub-module
// reads qualityController.tier() itself where it gates a particle count.

import "./game-feel.css";
import { sceneParts } from "../../scene/scene-bus";
import { prefersReducedMotion } from "../../ui/kit";
import type { ClientFeature } from "../registry";
import { buildCallForYou, type CallForYou } from "./call-for-you";
import { buildCelebrate, type Celebrate } from "./celebrate";
import { buildLife, type Life } from "./life";
import { qualityHudButton } from "./quality";
import { buildStationProps, type StationProps } from "./stations-props";

interface Mounted {
  life: Life;
  celebrate: Celebrate;
  callForYou: CallForYou;
  stationProps: StationProps;
}

let mounted: Mounted | null = null;

export const gameFeelFeature: ClientFeature = {
  id: "game-feel",
  mount(ctx) {
    sceneParts().agents?.setReducedMotion(prefersReducedMotion());

    const life = buildLife(ctx);
    const celebrate = buildCelebrate(ctx);
    const callForYou = buildCallForYou(ctx);
    const stationProps = buildStationProps(ctx);
    mounted = { life, celebrate, callForYou, stationProps };

    ctx.store.onAgents(() => {
      life.markAgentsDirty();
      stationProps.markDirty();
    });
    ctx.store.onAgentsRemoved(() => {
      life.markAgentsDirty();
      stationProps.markDirty();
    });
    ctx.store.onActivity((activities) => {
      celebrate.onActivity(activities);
      stationProps.onActivity(activities, ctx.elapsed());
    });
  },
  onFrame(_dt, ctx) {
    if (!mounted) return;
    const elapsed = ctx.elapsed();
    mounted.life.update(elapsed, ctx);
    mounted.celebrate.update(elapsed);
    mounted.callForYou.update(elapsed, ctx);
    mounted.stationProps.update(elapsed, ctx);
  },
  hudButtons: [qualityHudButton],
};
