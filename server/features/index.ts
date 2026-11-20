// The ONLY list of enabled server features. Adding a feature = one import + one array entry.
// Never edit server/index.ts to add a feature; see docs/FEATURES.md.

import { agendaFeature } from "./agenda.js";
import { agentStateFeature } from "./agent-state.js";
import { alumniFeature } from "./alumni.js";
import { archiveFeature } from "./archive.js";
import { artifactsFeature } from "./artifacts.js";
import { approvalsFeature } from "./approvals.js";
import { askJevFeature } from "./ask-jev.js";
import { atlasFeature } from "./atlas.js";
import { automationsFeature } from "./automations.js";
import { brainFeature } from "./brain.js";
import { careersFeature } from "./careers.js";
import { censusFeature } from "./census.js";
import { chatFeature } from "./chat.js";
import { cleanupFeature } from "./cleanup.js";
import { cliStationFeature } from "./cli-station.js";
import { codeFeature } from "./code.js";
import { completenessFeature } from "./completeness.js";
import { conflictsFeature } from "./conflicts.js";
import { councilFeature } from "./council.js";
import { controlFeature } from "./control.js";
import { feedFeature } from "./feed.js";
import { fixesFeature } from "./fixes.js";
import { healthKeeperFeature } from "./health-keeper.js";
import { forkFeature } from "./fork.js";
import { homeFeature } from "./home.js";
import { vaultFeature } from "./vault.js";
import { logsFeature } from "./logs.js";
import { loopsFeature } from "./loops.js";
import { macFeature } from "./mac.js";
import { memoryLayersFeature } from "./memory-layers.js";
import { metricsFeature } from "./metrics.js";
import { openEditorFeature } from "./open-editor.js";
import { outcomesFeature } from "./outcomes.js";
import { presidentFeature } from "./president.js";
import { projectPageFeature } from "./project-page.js";
import { projectsFeature } from "./projects.js";
import { quickPromptsFeature } from "./quick-prompts.js";
import { recallFeature } from "./recall/index.js";
import type { ServerFeature } from "./registry.js";
import { replayFeature } from "./replay.js";
import { residentFeature } from "./resident.js";
import { routerFeature } from "./router.js";
import { jobsFeature } from "./jobs.js";
import { subagentsFeature } from "./subagents/index.js";
import { systemFeature } from "./system.js";
import { routinesFeature } from "./routines.js";
import { shelfBoardFeature } from "./shelf-board.js";
import { shelfFeature } from "./shelf.js";
import { sicknessFeature } from "./sickness.js";
import { skillsFeature } from "./skills.js";
import { skyFeature } from "./sky.js";
import { talkFeature } from "./talk.js";
import { termFeature } from "./term.js";
import { todosFeature } from "./todos.js";
import { topicsFeature } from "./topics.js";
import { tripwiresFeature } from "./tripwires.js";
import { trustFeature } from "./trust.js";
import { ttsFeature } from "./tts.js";
import { usageFeature } from "./usage.js";
import { villageFeature } from "./village.js";
import { visionFeature } from "./vision.js";
import { neighboursFeature } from "./neighbours.js";
import { voiceBrainFeature } from "./voice-brain.js";
import { wakeRecallFeature } from "./wake-recall.js";
import { webSearchFeature } from "./websearch.js";
import { webTripsFeature } from "./webtrips.js";
import { workspaceFeature } from "./workspace.js";

export const serverFeatures: readonly ServerFeature[] = [
  askJevFeature,
  openEditorFeature,
  todosFeature,
  agentStateFeature,
  conflictsFeature,
  approvalsFeature,
  talkFeature,
  skyFeature,
  routinesFeature,
  replayFeature,
  ttsFeature,
  voiceBrainFeature,
  agendaFeature,
  recallFeature,
  webSearchFeature,
  quickPromptsFeature,
  subagentsFeature,
  // Round 7 (Alef backend)
  termFeature,
  controlFeature,
  codeFeature,
  brainFeature,
  shelfBoardFeature, // before shelfFeature: /api/shelf/board|pins|sections|seed win over /api/shelf/:agentId
  shelfFeature,
  artifactsFeature,
  automationsFeature,
  feedFeature,
  // Round 8 (ports from alex.bio/build)
  usageFeature,
  loopsFeature,
  forkFeature,
  skillsFeature,
  councilFeature,
  macFeature,
  metricsFeature,
  censusFeature, // vision-post census: sessions ever, sub-minions born, upgrades merged (read-only gh)
  // Wave 2 (round 10)
  cleanupFeature,
  completenessFeature,
  healthKeeperFeature, // nightly 04:30: stale tests → the Run-tests path, recompute, Feed "Health: N%", one Inbox item a day under 100
  chatFeature,
  routerFeature,
  presidentFeature,
  sicknessFeature,
  // Round 11
  topicsFeature,
  jobsFeature, // every minion's job (lawyer / hacker / learner / builder / gatherer) + the signal behind it; read-only
  // Round 11 C (memory layers): three memory buildings + the CLI station
  memoryLayersFeature,
  cliStationFeature,
  wakeRecallFeature, // Institute of Truth: which sessions read vault notes when they woke (transcript heads, read-only)
  residentFeature,
  villageFeature,
  neighboursFeature, // each session's first/last user or assistant line, for the agent panel's crew rows; read-only, in memory
  archiveFeature, // vault-only (pruned) sessions as fossils; read-only
  tripwiresFeature, // live sessions repeating a known lesson (observe + flag only)
  outcomesFeature, // a verdict per session (shipped / delivered / failed / …) from its transcript; writes only data/outcomes.json
  careersFeature, // the Tower: automation lineages as workers with careers, from outcomes' verdicts; writes only data/careers.json (on a confirmed click)
  logsFeature, // the whole town's log (server lines, action results, feed events); read-only
  trustFeature, // Claude Code folder trust: one key of ~/.claude.json, only on an explicit click
  alumniFeature, // the Hall: a legacy card per retired session (data/alumni.jsonl, append-only) + shipped/research read-only views
  workspaceFeature, // the Town square computed server-side every minute and broadcast (fenced) to Jev and the resident; writes only data/workspace-influence.jsonl
  visionFeature, // the vision ledger: the post's claims as data, re-checked by probes, with a computed % and its formula; read-only
  webTripsFeature, // off-planet: each house's web trips (transcripts, read-only) + Jev's kept trips (data/jev-web.jsonl); no web calls
  atlasFeature, // the 🗺️ Atlas view: skills, agents, routines and CLIs filed under 8 departments (bundle mention, pack, keyword, Jev), with autonomy evidence; read-only (+ open a leaf's file in the editor)
  projectsFeature, // the 📁 Projects view: districts + every ~/Documents/Code folder, with git facts, stack, category and stage; read-only
  projectPageFeature, // UX-3: one page per project (#/project/<key>): its city, Library entry and vault note joined; Home's pick-up cards
  systemFeature, // the 🧭 System view: one aggregator (/api/system) over the setup; every source has its own timeout; read-only
  vaultFeature, // the 🗄️ Vault sections of the Mind group: the vault's own hourly graph feed, aggregated server-side; read-only
  fixesFeature, // Health's Fix queue: failing checks, sickness, vault gaps, stale loops and abandoned sessions in one list, from the features above; writes only data/fixes.json
  homeFeature, // the 🏠 Home view: "What happened" facts from the features above + a Haiku summary of them (number-checked, cached, cost-capped); writes only data/home-digest.json
];
