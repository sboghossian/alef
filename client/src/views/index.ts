// The ONLY list of Alef views. Order = the top-bar switcher order. Adding a view = one import +
// one array entry; wave 2 replaces its comingSoon(...) line. See docs/VIEWS.md.

import type { AlefView } from "../shell/views";
import { boardView } from "./board";
import { brainView } from "./brain";
import { canvasView } from "./canvas";
import { capabilitiesView } from "./capabilities";
import { codeView } from "./code";
import { courierView } from "./courier";
import { districtView } from "./district";
import { healthView } from "./health";
import { homeView } from "./home";
import { libraryView } from "./library";
import { orbitView } from "./orbit";
import { projectView } from "./project";
import { roomView } from "./room";
import { routinesView } from "./routines";
import { systemView } from "./system";
import { vaultView } from "./vault";
import { voiceView } from "./voice";

// Home is first: the first registered view is the default route and the fallback for unknown ones.
export const alefViews: readonly AlefView[] = [
  homeView,
  orbitView,
  districtView,
  roomView,
  courierView,
  canvasView,
  boardView,
  voiceView,
  codeView,
  brainView,
  capabilitiesView,
  systemView,
  healthView,
  libraryView,
  vaultView,
  routinesView,
  projectView,
];
