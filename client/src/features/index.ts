// The ONLY list of enabled client features. Adding a feature = one import + one array entry.
// Never edit main.ts to add a feature; see docs/FEATURES.md.

import { agendaFeature } from "./agenda";
import { agentStateFeature } from "./agent-state";
import { alumniFeature } from "./alumni";
import { artifactsFeature } from "./artifacts";
import { archiveFeature } from "./archive";
import { autoDistrictsFeature } from "./auto-districts";
import { careersFeature } from "./careers";
import { approvalsFeature } from "./approvals";
import { cleanupFeature } from "./cleanup";
import { completenessFeature } from "./completeness";
import { fixesFeature } from "./fixes";
import { conflictsFeature } from "./conflicts";
import { councilFeature } from "./council";
import { courierFeature } from "./courier/courier";
import { feedBridgeFeature } from "./feed-bridge";
import { forkFeature } from "./fork";
import { gameFeelFeature } from "./game-feel/game-feel";
import { healthKeeperFeature } from "./health-keeper";
import { inboxFeature } from "./inbox";
import { logsFeature } from "./logs";
import { loopsFeature } from "./loops";
import { macFeature } from "./mac";
import { orbitFiltersFeature } from "./orbit-filters";
import { outcomesFeature } from "./outcomes";
import { orbitSystemFeature } from "./orbit-system";
import { explainFeature } from "./explain";
import { systemPlacesFeature } from "./system-places";
import { tourFeature } from "./tour";
import { wakeRecallFeature } from "./wake-recall";
import { webTripsFeature } from "./webtrips";
import { orbitThemesFeature } from "./orbit-themes";
import { presidentFeature } from "./president";
import { topicsFeature } from "./topics";
import { tripwiresFeature } from "./tripwires";
import { quickPromptsFeature } from "./quick-prompts";
import { jobsFeature } from "./jobs";
import { canvasFeature } from "./canvas";
import { censusFeature } from "./census";
import { chatFeature } from "./chat/chat";
import { claudeFmFeature } from "./claude-fm/claude-fm";
import type { ClientFeature } from "./registry";
import { replayFeature } from "./replay";
import { residentFeature } from "./resident";
import { routinesFeature } from "./routines";
import { skillsFeature } from "./skills";
import { skyFeature } from "./sky";
import { sicknessFeature } from "./sickness";
import { soundFeature } from "./sound";
import { talkFeature } from "./talk";
import { todosFeature } from "./todos";
import { subagentsFeature } from "./subagents";
import { usageFeature } from "./usage";
import { villageFeature } from "./village-data";
import { neighboursFeature } from "./neighbours";
import { voiceFeature } from "./voice";
import { waitingNotifyFeature } from "./waiting-notify";

export const clientFeatures: readonly ClientFeature[] = [
  inboxFeature,
  healthKeeperFeature, // the Health keeper's nightly state → the Inbox's Health item
  todosFeature,
  agentStateFeature,
  conflictsFeature,
  approvalsFeature,
  talkFeature,
  skyFeature,
  routinesFeature,
  replayFeature,
  soundFeature,
  voiceFeature,
  waitingNotifyFeature,
  agendaFeature,
  quickPromptsFeature,
  courierFeature,
  subagentsFeature,
  canvasFeature,
  claudeFmFeature,
  villageFeature,
  neighboursFeature, // agent panel: co-workers (shared files), crew (same repo, same hours), trips, messages; read-only
  feedBridgeFeature, // server feed → tripwires into the Feed, routine runs for the Town square's workspace
  // Round 8 (ports from alex.bio/build)
  usageFeature,
  censusFeature,
  loopsFeature,
  forkFeature,
  jobsFeature, // a "Job" row under Role in the agent panel and the drone panel (server/features/jobs.ts)
  skillsFeature,
  councilFeature,
  wakeRecallFeature, // agent-panel line: did this session read from the Institute of Truth when it woke
  webTripsFeature, // agent-panel line: "N web trips · M hosts" this session made on its own (Alef only sends Jev out)
  cleanupFeature,
  completenessFeature,
  fixesFeature, // the Fix queue's open count: the Health chip's tooltip and Health's Fix queue section
  presidentFeature,
  sicknessFeature, // the Clinic: sick badges in the agent panel, a status chip while cases are open, the Doctor and Mark treated
  residentFeature,
  topicsFeature, // round 11: topic continent signs + borders
  tripwiresFeature, // a live session repeating a known lesson: Feed kind "tripwire" + agent-panel badge
  outcomesFeature, // each session's verdict (outcomeOf / onOutcomes) for the Board, panels and the Hall; agent panel: "Shipped together" (crews)
  careersFeature, // the 🏛 Tower panel: automation workers by department, their state and last 10 runs (Settings row + palette)
  archiveFeature, // vault-only (pruned) sessions as fossils: one instanced mesh
  autoDistrictsFeature, // Automated Runs sub-districts: a ring + callout per automation lot
  artifactsFeature, // every claude.ai artifact: boards on district towers + the Museum island, gallery modal with previews
  alumniFeature, // the 🎓 Hall panel: shipped/research sessions, retired workers, legacy cards (Settings row + palette)
  chatFeature,
  macFeature,
  logsFeature, // right-sidebar Logs tab: read-only, taps server/log.ts + feed.ts
  // Orbit (round 7 T) last: their onFrame must run after sky/drones reset visibility.
  orbitThemesFeature,
  orbitSystemFeature,
  systemPlacesFeature, explainFeature, tourFeature, // round 11 C: System Quarter + Explain + tour (after orbitSystem: its group hosts the quarter)
  orbitFiltersFeature,
  // Game feel (P4a, round 10) LAST: it must run after orbitFiltersFeature so its effects
  // respect filter visibility (a filtered-out agent never calls for you or celebrates).
  gameFeelFeature,
];
