import { redactOn } from "./redact";
import * as THREE from "three";
import { agentTitle, displayIslandName } from "../../shared/display";
import type { ActivityStage, AgentActivity, JevDecision, ReactivateResult, WorldAgent } from "../../shared/types";
import { log } from "./log";
import { loadWorld } from "./net";
import { WorldStore } from "./state";
import { CITY_SURFACE, FRONT_DIR, PLANET_R, applyDistrictMergesToLayout, computeCityLayout } from "./layout";
import { isDistrictMergeRecordArray } from "../../shared/features/president";
import { isTopicsMap } from "../../shared/features/topics";
import { archiveSummary, onArchiveChange } from "./features/archive-state";
import { islandIdsWithAgents, visibleIslands } from "./features/archive-lib";
import { computeTopicLayout } from "./topic-layout";
import { setTopicsState } from "./features/topics-state";
import { createSceneRig, orbitDistanceFor, tiltFor } from "./scene/rig";
import { buildPlanet } from "./scene/planet";
import { buildCities } from "./scene/cities";
import { registerSceneParts } from "./scene/scene-bus";
import { buildAgents } from "./scene/agents";
import { buildMoon } from "./scene/moon";
import { PickRegistry, type Pick } from "./scene/pick";
import { toon } from "./scene/toon";
import { mountPanel, type TouchedFile } from "./ui/panel";
import { placementNote } from "./ui/placement-note";
import { mountTooltip } from "./ui/tooltip";
import { mountCityLabels, mountSpeechBubble } from "./ui/labels";
import { mountOffline } from "./ui/offline";
import { mountGlStatus } from "./ui/no-3d";
import { ActivityQueue } from "./activityQueue";
import { askJev, dispatch, getJson, openEditor, postJson, reactivate } from "./api";
import { createAskJev } from "./ui/askJev";
import { mountDispatchBar } from "./ui/dispatch";
import { mountToast } from "./ui/toast";
import { describeError } from "./ui/action";
import { openAgentIn, openOutcome, openPending, type OpenKind, type OpenUi } from "./ui/agent-open";
import { mountHelp } from "./ui/help";
import { mountShell, type Shell } from "./shell/shell";
import { ViewRegistry, type Selection } from "./shell/views";
import { wireFeedSources } from "./shell/feed-sources";
import { alefViews } from "./views";
import { approvalFailureText, decideApprovalResult } from "./features/approvals";
import { openSubagent } from "./features/subagents";
import { talkBindingCount } from "./features/talk";
import { startTour } from "./features/tour";
import { obsidianUrl } from "./views/brain-lib";
import { chromeMode, collapsible, prefersReducedMotion, setChromeMode, toggleHideAllChrome, type CollapsibleHandle, type CollapsibleOpts } from "./ui/kit";
import { mountFocusCard } from "./ui/focus";
import { NORMAL, chromeModeFor, enteredWaiting, focusedAgent, nextView, type ViewState } from "./ui/focus-lib";
import { agentStateOf, onAgentStates } from "./features/agent-state";
import { playFocusChime } from "./features/sound";
import { flyDuration, overshootEase } from "./features/game-feel/quality-lib";
import { clientFeatures } from "./features";
import { ClientFeatureHost, type ClientContext } from "./features/registry";
import { FeedStore } from "./shell/feed";
import { mountOverlays, type PipTarget } from "./ui/overlays";
import type { PaletteAction } from "./ui/palette";
import { buildRoom, type Room, type RoomHit } from "./scene/room";
import { buildPlaza } from "./scene/plaza";
import { createDiveLanding, diveRoute } from "./scene/dive";
import { activityScore, cityCardHtml, cityDisplayName, cityStats, mountCompass, mountExploring, type CityStats } from "./ui/world";

const ACTIVITY_STORE_KEY = "agent-world.activities";

function loadStoredActivities(): AgentActivity[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as AgentActivity[]).filter((a) => typeof a?.agentId === "string" && typeof a?.id === "string") : [];
  } catch {
    return [];
  }
}

function storeActivities(list: AgentActivity[]): void {
  try {
    localStorage.setItem(ACTIVITY_STORE_KEY, JSON.stringify(list.slice(-50)));
  } catch {
    /* private mode / quota: replay just won't have history */
  }
}

const BURST_WORD: Record<string, string> = { skill: "POW!", mcp: "ZAP!", hook: "BAM!", file: "POP!", repo: "BOOM!" };

// Hub file: new features go in client/src/features/<id>.ts, not here (docs/FEATURES.md).
async function main(): Promise<void> {
  if (redactOn()) document.body.classList.add("alef-redact");
  const container = document.getElementById("app");
  if (!container) throw new Error("#app missing from index.html");
  const params = new URLSearchParams(location.search);

  // WebGL may be missing or lost: the shell below never depends on it (ui/no-3d.ts, scene/webgl.ts).
  const rig = createSceneRig(container);
  const { scene, camera, gl, controls, timer, applyFlyoverTilt } = rig;
  const canvas = rig.surface;
  const glStatus = mountGlStatus(container, rig);
  const store = new WorldStore();
  const tooltip = mountTooltip();
  // The Alef shell (top bar, sidebars, status bar, views) is built right before the features mount.
  let shell: Shell | null = null;
  const toast = mountToast();
  const panel = mountPanel({
    onVisitRoom: (id) => shell?.showView("room", id),
    onFocus: (id) => focusOn(id),
    onAction: (kind, id, ui) => void openIn(kind, id, ui),
    pending: openPending,
    outcome: openOutcome,
  });
  const helpUi = mountHelp(() => shell?.openRightTab("help"));
  const reducedMotion = prefersReducedMotion();

  const dataSource = await loadWorld(mountOffline());
  store.loadSnapshot(dataSource.world);

  // ---- layout: one city per island on the sphere ----
  // Every island gets laid out, built and positioned, even one that exists only because a file
  // was touched there (0 sessions) — geometry is a one-time thing at boot (see the district-merge
  // comment below) and never rebuilds, so an island's position must never depend on something
  // that can change later (a fossil scan finishing, an agent arriving). What CAN change later is
  // handled below: refreshCityVisibility toggles the city + its labels + file lots in place.
  const islands = [...store.islands.values()];
  const objects = [...store.objects.values()];
  const fileLots = new Map<string, number>();
  const lots = new Map<string, number>();
  for (const o of objects) {
    const isHarnessObj = o.kind === "skill" || o.kind === "hook" || o.kind === "mcp";
    if (o.kind === "file" || isHarnessObj) {
      const key = isHarnessObj ? "harness" : o.islandId;
      lots.set(key, (lots.get(key) ?? 0) + 1);
      if (o.kind === "file") fileLots.set(o.islandId, (fileLots.get(o.islandId) ?? 0) + 1);
    }
  }
  for (const a of store.agents.values()) lots.set(a.islandId, (lots.get(a.islandId) ?? 0) + 1);
  // Round 11: topic continents (server/features/topics.ts) when the server sent a map, else one city per folder.
  const topicsExtra = dataSource.world.extras?.["topics.map"];
  const topicLayout = isTopicsMap(topicsExtra) ? computeTopicLayout(islands, lots, topicsExtra, [...store.agents.values()]) : null;
  const layout = topicLayout?.layout ?? computeCityLayout(islands, lots);
  // Round 10: Jev-proposed, Alex-approved district merges are display-only. City geometry
  // is laid out once here at load, so the approved mapping has to be read from this very first
  // snapshot's extras (see server/features/president.ts) — never fetched separately.
  const districtMergesExtra = dataSource.world.extras?.["president.merges"];
  const districtMerges = isDistrictMergeRecordArray(districtMergesExtra) ? districtMergesExtra : [];
  applyDistrictMergesToLayout(layout, districtMerges);

  const pick = new PickRegistry();
  const planet = buildPlanet([...layout.values()]);
  scene.add(planet.group);
  if (topicLayout && isTopicsMap(topicsExtra)) setTopicsState({ map: topicsExtra, layout: topicLayout, groundHeight: (d) => planet.groundHeight(d) });

  const agentIsland = (id: string): string | undefined => store.agents.get(id)?.islandId;
  const roadPairs: [string, string][] = [];
  for (const e of store.edges) {
    if (e.kind !== "visited") continue;
    const a = agentIsland(e.from);
    const b = agentIsland(e.to) ?? (store.islands.has(e.to) ? e.to : undefined);
    if (a && b && a !== b) roadPairs.push([a, b]);
  }
  const liveIslands = new Set([...store.agents.values()].filter((a) => a.status === "live").map((a) => a.islandId));

  const cities = buildCities({ islands, objects, layout, roadPairs, groundHeight: planet.groundHeight, liveIslands, pick });
  scene.add(cities.group);

  const agentsVisual = buildAgents({ agents: [...store.agents.values()], layout, fileLots, pick, homeKey: topicLayout?.homeKey });
  scene.add(agentsVisual.group);

  const moon = buildMoon();
  moon.setStatus(store.jev.status);
  scene.add(moon.group);
  pick.register(moon.body, () => ({ kind: "jev", id: "jev" }));

  const harnessLayout = layout.get("harness");
  const plaza = harnessLayout ? buildPlaza(harnessLayout, pick) : null;
  if (plaza) scene.add(plaza.group);
  if (plaza && gl) {
    const size = gl.renderer.getDrawingBufferSize(new THREE.Vector2());
    plaza.setResolution(size.x, size.y);
    window.addEventListener("resize", () => {
      const sz = gl.renderer.getDrawingBufferSize(new THREE.Vector2());
      plaza.setResolution(sz.x, sz.y);
    });
  }

  // Selection marker: a bouncing comic arrow.
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.6, 4).rotateX(Math.PI), toon(0xff4d8d));
  marker.visible = false;
  scene.add(marker);

  // ---- labels ----
  const maxAgents = Math.max(1, ...islands.map((i) => i.agentCount));
  const harnessCount = objects.filter((o) => o.islandId === "harness").length;
  const labels = mountCityLabels(
    islands.flatMap((i) => {
      const anchor = cities.towerTop(i.id);
      if (!anchor) return [];
      const capital = i.id === "harness";
      return [
        {
          id: i.id,
          text: capital ? "★ Harness City" : displayIslandName(i),
          count: capital ? `${harnessCount}` : `${i.agentCount}`,
          anchor: anchor.clone().multiplyScalar(1.01),
          weight: capital ? 1 : Math.sqrt(i.agentCount / maxAgents),
          capital,
        },
      ];
    }),
    (id) => flyToCity(id),
    (id, rect) => showCityCard(id, rect),
  );
  const bubble = mountSpeechBubble();

  // ---- district visibility: which already-built cities actually show ----
  // Geometry above is a one-time thing at boot (positions never change), but which of those
  // cities are DRAWN can and does change afterwards: an agent can start or finish (upsertAgents
  // never touches store.islands, so agentCount there goes stale — visibleIslands is fed the live
  // agents map instead), and the archive summary can still be loading (server/features/archive.ts's
  // vault scan is async; a fresh boot briefly has no "archive.summary" extra at all). visibleIslands
  // fails OPEN while the summary is unknown, so a fossil-only island (e.g. aleph, 66 fossils) is
  // never dropped by that race — it just stays visible until the real answer comes in, at which
  // point this recomputes and hides it in place if it truly has nothing. No relayout, ever: only
  // the tower/crown/file-lot instances and the label toggle between shown and zero-scale/hidden.
  function computeVisibleIslandIds(): Set<string> {
    const agentIslandIds = islandIdsWithAgents([...store.agents.values()]);
    return new Set(visibleIslands(islands, agentIslandIds, archiveSummary()).map((i) => i.id));
  }
  let lastAgentIslands = "";
  function refreshCityVisibility(): void {
    lastAgentIslands = [...islandIdsWithAgents([...store.agents.values()])].sort().join("\n");
    const visible = computeVisibleIslandIds();
    cities.setVisibleIslands(visible);
    labels.setHidden(new Set(islands.filter((i) => !visible.has(i.id)).map((i) => i.id)));
  }
  refreshCityVisibility();
  store.onSnapshot(refreshCityVisibility);
  // Agent upserts are frequent (status, tokens): only recompute when the set of islands that have
  // agents actually changed. Removals can empty an island, so they always recompute.
  store.onAgents(() => {
    if ([...islandIdsWithAgents([...store.agents.values()])].sort().join("\n") !== lastAgentIslands) refreshCityVisibility();
  });
  store.onAgentsRemoved(() => refreshCityVisibility());
  onArchiveChange(refreshCityVisibility);

  // ---- interaction layer: Ask Jev, dispatch, overlays (search, inbox, feed, status bar: the Alef shell) ----
  const recentCity =
    islands.filter((i) => i.id !== "harness").sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive))[0]?.id ?? "";
  const ask = createAskJev({
    agent: (id) => store.agents.get(id),
    onPick: (id) => selectAgentAndFly(id),
    onThinking: (on) => {
      moon.setThinking(on);
      if (on) bubble.say("Hmm… let me think", moon.position, timer.getElapsed() + 30);
      else bubble.say("Got it!", moon.position, timer.getElapsed() + 1.5);
    },
    // The "voice" feature (if enabled) speaks the answer back; a typed/palette
    // question stays silent. Routed through moon.body.userData so this hub file
    // doesn't need to import or know about individual client features.
    onAnswered: (question, res) => {
      const onJevAnswer = (moon.body.userData as { onJevAnswer?: (q: string, r: typeof res) => void }).onJevAnswer;
      onJevAnswer?.(question, res);
    },
  });
  // Same pattern, the other direction: features open the Jev panel (and optionally ask
  // a question) without a new ClientContext field — see docs/FEATURES.md's note that a
  // genuinely new hub API is fine as long as it's its own small, separate change.
  moon.body.userData.openAsk = (query?: string): void => {
    selectPick({ kind: "jev", id: "jev" });
    if (query) void ask.ask(query);
    else ask.focus();
  };
  const dispatchBar = mountDispatchBar({
    islands,
    defaultCity: recentCity,
    toast,
    onDispatched: (res) => {
      agentsVisual.spawnDispatchCar(res.islandId, timer.getElapsed());
      const top = cities.towerTop(res.islandId);
      if (top) overlays.burst("DISPATCHED!", top, "dispatch");
      const city = layout.get(res.islandId);
      if (city) flyToDir(city.dir, PLANET_R + 30);
    },
  });
  const overlays = mountOverlays((id) => selectAgentAndFly(id));

  // ---- round 3: now exploring, compass, city cards (districts + board: the Orbit / Board views) ----
  let statsByCity: Map<string, CityStats> = cityStats([...store.agents.values()]);
  const cityNameOf = (id: string): string => {
    const i = store.islands.get(id);
    return i ? cityDisplayName(i) : id;
  };
  const exploring = mountExploring();
  const compass = mountCompass();
  const harnessCounts = (): [string, number][] =>
    (["skill", "hook", "mcp"] as const).map((k) => [k === "mcp" ? "MCPs" : `${k}s`, objects.filter((o) => o.kind === k).length]);
  const cityCard = document.getElementById("city-card");
  function showCityCard(id: string | null, rect: DOMRect | null): void {
    if (!cityCard) return;
    const island = id ? store.islands.get(id) : undefined;
    if (!island || !rect) {
      cityCard.hidden = true;
      return;
    }
    cityCard.innerHTML = cityCardHtml(island, statsByCity.get(island.id), island.id === "harness" ? harnessCounts() : []);
    cityCard.hidden = false;
    const x = Math.min(Math.max(rect.left + rect.width / 2, 110), window.innerWidth - 110);
    cityCard.style.transform = `translate(${Math.round(x)}px, ${Math.round(rect.bottom + 10)}px) translate(-50%, 0)`;
  }
  function refreshCityStats(): void {
    statsByCity = cityStats([...store.agents.values()]);
  }
  refreshCityStats();
  let selectedCityForDispatch = recentCity;

  // Reactivate / Open in VS Code, from the palette and the details panel (the Room's dock uses the
  // same ui/agent-open.ts): a toast for every click (a burst over the house is invisible off-planet).
  function openIn(kind: OpenKind, id: string, ui?: OpenUi): Promise<ReactivateResult | null> {
    return openAgentIn({ agent: (a) => store.agents.get(a), reactivate, openEditor, toast }, kind, id, ui);
  }

  function runPaletteAction(a: PaletteAction): void {
    switch (a.type) {
      case "city":
        // Off-planet (Board, Canvas, Code, Brain, Health, the Room) a fly-to changes nothing you can
        // see, so a district opens its District view; the harness has none, so say what it is.
        if (shell?.current()?.usesPlanet !== true || shell.coversPlanet()) {
          if (a.id === "harness") toast("Harness City holds your skills, hooks and MCP servers. Open the Orbit view to fly there.");
          else shell?.showView("district", a.id);
        } else flyToCity(a.id);
        break;
      case "agent":
        selectAgentAndFly(a.id);
        break;
      case "object": {
        const obj = store.objects.get(a.id);
        const top = cities.objectTop(a.id) ?? (obj ? cities.towerTop(obj.islandId) : undefined);
        selectPick({ kind: "object", id: a.id });
        if (top) flyToDir(top, PLANET_R + 30);
        break;
      }
      case "reactivate":
      case "editor": {
        selectAgentAndFly(a.id);
        const kind = a.type;
        void openIn(kind, a.id).then((res) => {
          const top = res ? agentsVisual.houseTopOf(a.id) : undefined;
          if (res && top) overlays.burst(res.ok ? (kind === "reactivate" ? "WAKE UP!" : "OPEN!") : "OOPS!", top, "dispatch");
        });
        break;
      }
      case "ask":
        selectPick({ kind: "jev", id: "jev" });
        void ask.ask(a.query);
        break;
      case "dispatch":
        dispatchBar.prefill(a.query, a.islandId);
        break;
      case "command":
        features.runCommand(a.id);
        break;
      case "view":
        shell?.showView(a.view, a.param, { focusView: true });
        break;
      case "note":
        // The Vault sections' note links do exactly this: hand the note to Obsidian.
        window.location.assign(obsidianUrl(a.path));
        break;
    }
  }

  // ---- feature plugins (client/src/features/index.ts is the enabled list) ----
  const feedStore = new FeedStore();
  const ctx: ClientContext = {
    scene,
    camera,
    store,
    elapsed: () => timer.getElapsed(),
    flyTo: (id) => {
      if (store.agents.has(id)) selectAgentAndFly(id);
      else if (store.islands.has(id)) flyToCity(id);
    },
    diveToRoom: (id) => diveToRoom(id),
    openPanel: (panelId) => {
      const p = features.panel(panelId);
      if (!p) {
        log.warn("main", `openPanel: no feature panel "${panelId}"`);
        return;
      }
      const el = document.createElement("div");
      p.render(el, ctx);
      selected = null;
      panel.showCustom(p.title, el);
    },
    hasPanel: (panelId) => features.panel(panelId) !== undefined,
    openPalette: (query) => shell?.focusSearch(query),
    toast,
    api: { getJson, postJson, reactivate, openEditor, dispatch, askJev },
    cityPosition: (cityId) => cities.towerTop(cityId),
    agentPosition: (agentId) => agentsVisual.houseTopOf(agentId),
    surfacePoint: (dir, lift = 0) => {
      const n = dir.clone().normalize();
      return n.multiplyScalar(PLANET_R + planet.groundHeight(n) + lift);
    },
    labels: {
      say: (text, anchor, seconds = 4) => bubble.say(text, anchor, timer.getElapsed() + seconds),
      burst: (text, anchor) => overlays.burst(text, anchor),
    },
    endRide: () => {
      if (mode === "ride") setMode("orbit");
    },
    feed: feedStore,
    openRightTab: (tab) => shell?.openRightTab(tab),
    showView: (id, param) => shell?.showView(id, param ?? null),
    activeView: () => shell?.activeView() ?? "orbit",
  };
  const features = new ClientFeatureHost(clientFeatures, ctx);
  // ---- the Alef shell: views, sidebars, feed, status bar (client/src/shell, docs/VIEWS.md) ----
  const setSelection = (sel: Selection | null): void => {
    const onPlanet = shell?.current()?.usesPlanet === true;
    if (!sel) {
      selected = null;
      panel.hide();
      shell?.selected(null);
    } else if (sel.kind === "agent") {
      if (onPlanet) selectAgentAndFly(sel.id);
      else selectPick({ kind: "agent", id: sel.id });
    } else if (sel.kind === "city") {
      if (onPlanet) flyToCity(sel.id);
      else selectPick({ kind: "city", id: sel.id });
    } else if (sel.kind === "object") {
      if (onPlanet) runPaletteAction({ type: "object", id: sel.id });
      else selectPick({ kind: "object", id: sel.id });
    } else if (sel.kind === "subagent") {
      openSubagent(ctx, sel.id);
      shell?.selected(sel);
    } else if (sel.kind === "system") selectPick({ kind: "system", id: sel.id });
    else selectPick({ kind: "jev", id: "jev" });
  };
  shell = mountShell({
    registry: new ViewRegistry(alefViews),
    store,
    feed: feedStore,
    ctx,
    planet: {
      flyToAgent: (id) => selectAgentAndFly(id),
      flyToCity: (id) => flyToCity(id),
      enterRoom: (id) => enterRoom(id),
      exitRoom: () => exitRoom(),
      roomAgent: () => roomAgentId ?? pendingRoom?.agentId ?? null,
      startRide: () => {
        setMode("plane");
        return mode !== "orbit";
      },
      endRide: () => {
        if (mode !== "orbit") setMode("orbit");
      },
    },
    selection: { get: () => (selected ? { kind: selected.kind, id: selected.id } : null), set: setSelection },
    search: {
      data: {
        islands: () => islands,
        agents: () => [...store.agents.values()],
        objects: () => [...store.objects.values()],
        dispatchCity: () => selectedCityForDispatch,
        commands: () => features.paletteCommands(),
      },
      run: (action: PaletteAction) => runPaletteAction(action),
      exists: (a: PaletteAction) =>
        a.type === "city" ? store.islands.has(a.id) : a.type === "object" ? store.objects.has(a.id) : a.type === "command" ? true : "id" in a ? store.agents.has(a.id) : true,
    },
    featureButtons: features.hudButtons(),
    renderRoutines: (el) => features.panel("routines")?.render(el, ctx),
    // Throws on a refusal, so the Feed row stays open and shows why (shell/feed-hold.ts).
    decide: async (id, action) => {
      const r = await decideApprovalResult(ctx, id, action);
      if (!r.ok) {
        toast(approvalFailureText(r.error), "error");
        throw new Error(describeError(r.error));
      }
    },
    pickFeed: (item) => {
      if (item.agentId && store.agents.has(item.agentId)) setSelection({ kind: "agent", id: item.agentId });
      else if (item.cityId && store.islands.has(item.cityId)) setSelection({ kind: "city", id: item.cityId });
    },
    pickAgent: (id) => setSelection({ kind: "agent", id }),
    pickCity: (id) => setSelection({ kind: "city", id }),
    talkSessions: () => talkBindingCount(),
    onViewChanged: (v, prev) => {
      tooltip.hide();
      // The details panel is contextual: it belongs to the click that opened it, not to the next view.
      if (prev && prev.id !== v.id) panel.hide();
      if (view.mode !== "normal" && prev) applyView(NORMAL); // agent focus / zen belong to the view they started in
      if (!v.usesPlanet) {
        fly = null;
        exploring.hide();
        if (cityCard) cityCard.hidden = true;
      }
    },
    welcome: () => helpUi.welcome.open(document.getElementById("welcome-ok")),
    tour: () => startTour(),
  });
  wireFeedSources(ctx, feedStore);
  features.mount(dataSource.world);

  function refreshAwaiting(): void {
    const agents = [...store.agents.values()];
    overlays.setAwaiting(
      agents
        .filter((a) => a.awaitingInput === true)
        .flatMap((a) => {
          const anchor = agentsVisual.houseTopOf(a.id);
          return anchor ? [{ agentId: a.id, anchor }] : [];
        }),
    );
  }

  // Latest stage per live agent (drives the Hook→Brain→Plan→Reason→Tool pips).
  const stageOf = new Map<string, { stage: ActivityStage; at: number }>();
  function refreshPips(): void {
    const pips: PipTarget[] = [];
    const cutoff = Date.now() - 15 * 60_000;
    for (const [agentId, st] of stageOf) {
      const agent = store.agents.get(agentId);
      const anchor = agentsVisual.houseTopOf(agentId);
      if (!agent || agent.status !== "live" || !anchor || st.at < cutoff) continue;
      pips.push({ agentId, anchor: anchor.clone().multiplyScalar(1.004), stage: st.stage, at: st.at });
    }
    overlays.setPips(pips);
  }

  const activityQueue = new ActivityQueue();
  function ingestActivities(list: AgentActivity[], animate: boolean): void {
    for (const a of list) {
      const at = Date.parse(a.at);
      if (animate && a.stage === "brain" && plaza) {
        const island = store.agents.get(a.agentId)?.islandId;
        const tower = island ? cities.towerTop(island) : undefined;
        if (island && tower) {
          plaza.brainHit(island, tower, timer.getElapsed());
          overlays.burst("RECALL!", plaza.brainTop);
        }
      }
      const prev = stageOf.get(a.agentId);
      if (!prev || at >= prev.at) stageOf.set(a.agentId, { stage: a.stage, at: Number.isFinite(at) ? at : Date.now() });
    }
    if (animate) activityQueue.push(list.filter((a) => a.targetObjectId));
    refreshPips();
  }

  function animateActivity(a: AgentActivity, elapsed: number): void {
    const objId = a.targetObjectId;
    if (!objId) return;
    const kind = store.objects.get(objId)?.kind ?? objId.split(":")[0] ?? "file";
    const top = cities.objectTop(objId);
    if (!top) return;
    const harnessKind = kind === "skill" || kind === "mcp" || kind === "hook";
    if (harnessKind && agentsVisual.startTrip(a.agentId, objId, top)) return; // burst fires on arrival
    cities.bounce(objId, elapsed);
    overlays.burst(BURST_WORD[kind] ?? "POP!", top);
  }
  agentsVisual.onArrive((_agentId, objId) => {
    const top = cities.objectTop(objId);
    cities.bounce(objId, timer.getElapsed());
    const kind = store.objects.get(objId)?.kind ?? objId.split(":")[0] ?? "skill";
    if (top) overlays.burst(BURST_WORD[kind] ?? "POW!", top);
  });


  // ---- selection ----
  let selected: Pick | null = null;

  function topTouchedFiles(agentId: string): TouchedFile[] {
    return store.edges
      .filter((e) => e.from === agentId && e.kind === "touched")
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map((e) => ({ name: store.objects.get(e.to)?.name ?? e.to, weight: e.weight }));
  }

  function placementNoteFor(agent: WorldAgent): string | undefined {
    return placementNote(agent, store.islands.values());
  }

  function selectedPosition(): THREE.Vector3 | undefined {
    if (!selected) return undefined;
    if (selected.kind === "agent") return agentsVisual.positionOf(selected.id);
    if (selected.kind === "object") return cities.objectTop(selected.id) ?? cities.towerTop(store.objects.get(selected.id)?.islandId ?? "");
    if (selected.kind === "city") return cities.towerTop(selected.id);
    return undefined;
  }

  function selectPick(p: Pick): void {
    selected = p;
    shell?.selected({ kind: p.kind, id: p.id });
    if (p.kind === "agent") {
      const agent = store.agents.get(p.id);
      if (agent) panel.showAgent(agent, topTouchedFiles(p.id), placementNoteFor(agent));
    } else if (p.kind === "jev") {
      panel.showJev(store.jev, ask.el);
    } else if (p.kind === "city") {
      const island = store.islands.get(p.id);
      if (island) {
        const live = [...store.agents.values()].filter((a) => a.islandId === p.id && a.status === "live").length;
        const objs = objects.filter((o) => o.islandId === p.id).length;
        panel.showCity(island, live, objs);
      }
    } else {
      const obj = store.objects.get(p.id);
      if (obj) panel.showObject(obj);
    }
  }

  // ---- camera: orbit, fly-to, ride-a-plane ----
  // "ride" = a feature (features/courier) owns the camera; the hub saves and restores the view.
  type Mode = "orbit" | "plane" | "ride";
  let mode: Mode = "orbit";
  let userInteracted = false;
  controls.autoRotate = !reducedMotion;
  controls.autoRotateSpeed = 0.35;

  interface Fly {
    fromDir: THREE.Vector3;
    toDir: THREE.Vector3;
    fromDist: number;
    toDist: number;
    t0: number;
    duration: number;
    /** A 6% overshoot-and-settle on the distance only, for a fly that lands on an agent. */
    overshoot: boolean;
    /** elapsed-time a drag/wheel interrupted this fly; set, updateFly blends off the flight
     *  path over CANCEL_BLEND_S instead of letting it keep winning against the user's input. */
    cancelAt?: number;
  }
  let fly: Fly | null = null;
  const CANCEL_BLEND_S = 0.25;

  function flyToDir(dir: THREE.Vector3, distance: number, opts?: { overshoot?: boolean }): void {
    if (mode !== "orbit") setMode("orbit");
    // Before creating the new flight: let a genuinely in-progress one (if any) know it's being
    // superseded. stopAutoRotate() tags fly.cancelAt, but we discard that object below anyway,
    // so this only matters when stopAutoRotate() is reached from a real drag/wheel event.
    stopAutoRotate();
    const tilted = dir.clone().normalize();
    const fromDir = camera.position.clone().normalize();
    fly = {
      fromDir,
      toDir: tilted,
      fromDist: camera.position.length(),
      toDist: distance,
      t0: timer.getElapsed(),
      // Reduced motion: jump straight there (one frame) instead of a snappy swoop.
      duration: reducedMotion ? 0.001 : flyDuration(fromDir.angleTo(tilted)),
      overshoot: !reducedMotion && opts?.overshoot === true,
    };
  }

  function updateFly(elapsed: number): void {
    if (!fly) return;
    if (fly.cancelAt !== undefined && elapsed - fly.cancelAt >= CANCEL_BLEND_S) {
      fly = null;
      return;
    }
    const t = Math.min(1, (elapsed - fly.t0) / fly.duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const q = new THREE.Quaternion().setFromUnitVectors(fly.fromDir, fly.toDir);
    const dir = fly.fromDir.clone().applyQuaternion(new THREE.Quaternion().slerp(q, e));
    // Pull out a little mid-flight so long hops read as a hop.
    const hop = reducedMotion ? 0 : Math.sin(Math.PI * e) * fly.fromDir.angleTo(fly.toDir) * 18;
    // Arrival overshoot rides its own curve on distance only; direction keeps the ease above.
    const distT = fly.overshoot ? overshootEase(t) : e;
    const target = dir.multiplyScalar(THREE.MathUtils.lerp(fly.fromDist, fly.toDist, distT) + hop);
    if (fly.cancelAt !== undefined) {
      // A drag/wheel mid-flight cancels smoothly: blend off the flight path over 0.25s instead
      // of snapping when the input the fly was silently overriding suddenly applies at once.
      const blend = (elapsed - fly.cancelAt) / CANCEL_BLEND_S;
      camera.position.lerp(target, 1 - blend);
    } else {
      camera.position.copy(target);
      if (t >= 1) fly = null;
    }
  }

  function selectAgentAndFly(id: string): void {
    const agent = store.agents.get(id);
    if (!agent) return;
    selectPick({ kind: "agent", id });
    dispatchBar.setCity(agent.islandId);
    if (agent.islandId !== "harness") selectedCityForDispatch = agent.islandId;
    const house = agentsVisual.houseTopOf(id);
    const city = layout.get(agent.islandId);
    if (house) flyToDir(house, PLANET_R + 30, { overshoot: true });
    else if (city) flyToDir(city.dir, PLANET_R + 28, { overshoot: true });
  }

  // Inbox → Room: swoop down through the house so you see WHICH one, then open its Room view.
  // With 3D off or lost there is no swoop to see, and nothing would land it (scene/dive.ts).
  const dive = createDiveLanding();
  function diveToRoom(id: string): void {
    if (!store.agents.has(id)) return;
    const house = agentsVisual.houseTopOf(id);
    const route = diveRoute({ view: shell?.current() ?? null, hasHouse: house !== undefined, reducedMotion, drawing: glStatus.drawing() });
    if (!house || route === "direct") {
      shell?.showView("room", id, { focusView: true });
      return;
    }
    selectPick({ kind: "agent", id });
    flyToDir(house, PLANET_R + 2);
    if (fly) fly.duration = 1.2;
    dive.park(id, timer.getElapsed() + 1.15);
  }
  function landDive(elapsed: number, drawing: boolean): void {
    const id = dive.take(elapsed, drawing);
    if (id) shell?.showView("room", id, { focusView: true });
  }

  function flyToCity(id: string): void {
    // The "Now exploring" card replaces the city panel here.
    selected = { kind: "city", id };
    shell?.selected({ kind: "city", id });
    panel.hide();
    dispatchBar.setCity(id);
    if (id !== "harness") selectedCityForDispatch = id;
    const island = store.islands.get(id);
    if (island) {
      const files = [...store.objects.values()]
        .filter((o) => o.islandId === id && o.kind === "file")
        .sort((a, b) => b.usage - a.usage)
        .slice(0, 3)
        .map((o) => o.name);
      const extra: [string, number][] = id === "harness" ? harnessCounts() : [];
      exploring.show(island, statsByCity.get(id), files, extra);
    }
    const city = layout.get(id);
    if (city) {
      // Land "south" of the city so the flyover tilt frames it at 3/4 instead of straight down.
      const h = 16 + city.radius * 2.2;
      const t = tiltFor(h);
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(city.dir, -city.dir.y).normalize();
      const dir = city.dir.clone().multiplyScalar(PLANET_R).addScaledVector(north, -h * 1.05 * t).normalize();
      flyToDir(dir, PLANET_R + h);
    }
  }

  function stopAutoRotate(): void {
    userInteracted = true;
    controls.autoRotate = false;
    lastInputElapsed = timer.getElapsed();
    // A real drag/wheel (not this function's own call from flyToDir, which discards `fly` right
    // after) interrupts an in-progress flight: updateFly blends it off over CANCEL_BLEND_S.
    if (fly && fly.cancelAt === undefined) fly.cancelAt = timer.getElapsed();
  }

  // ---- idle camera: after IDLE_AFTER_S with no input on Orbit, a slow breathing dolly (±2%
  // distance) and a gentle drift toward the busiest city. Any input (stopAutoRotate above) or a
  // fly resets the clock at once. Called from animate()'s orbit branch. ----
  const IDLE_AFTER_S = 20;
  const IDLE_BREATHE_AMPLITUDE = 0.02;
  const IDLE_BREATHE_PERIOD_S = 14;
  const IDLE_DRIFT_RAD_S = 0.02;
  let lastInputElapsed = 0;
  let idleBaseDistance: number | null = null;

  function busiestCityDir(): THREE.Vector3 | null {
    const top = islands
      .filter((i) => i.id !== "harness")
      .sort((a, b) => activityScore(statsByCity.get(b.id)) - activityScore(statsByCity.get(a.id)))[0];
    return (top && layout.get(top.id)?.dir) ?? null;
  }

  function applyIdleCamera(elapsed: number, dt: number): void {
    const idleFor = elapsed - lastInputElapsed;
    if (idleFor < IDLE_AFTER_S) {
      idleBaseDistance = null;
      return;
    }
    if (idleBaseDistance === null) idleBaseDistance = camera.position.length();
    const breathe = 1 + Math.sin(((idleFor - IDLE_AFTER_S) / IDLE_BREATHE_PERIOD_S) * Math.PI * 2) * IDLE_BREATHE_AMPLITUDE;
    const dir = camera.position.clone().normalize();
    const target = busiestCityDir();
    if (target) {
      const angle = dir.angleTo(target);
      if (angle > 1e-4) {
        const q = new THREE.Quaternion().setFromUnitVectors(dir, target);
        dir.applyQuaternion(new THREE.Quaternion().slerp(q, Math.min(1, (IDLE_DRIFT_RAD_S * dt) / angle)));
      }
    }
    camera.position.copy(dir).multiplyScalar(idleBaseDistance * breathe);
  }

  let savedView: { pos: THREE.Vector3; quat: THREE.Quaternion; up: THREE.Vector3; target: THREE.Vector3 } | null = null;
  function setMode(want: Mode): void {
    const next: Mode = want === "plane" && features.hasRide() ? "ride" : want;
    if (next === "plane" && agentsVisual.flyingPlanes().length === 0) return;
    if (next === mode && next === "ride") return;
    const prev = mode;
    if (prev === "ride") features.ride("stop");
    mode = next;
    if (next === "ride") {
      fly = null;
      savedView = { pos: camera.position.clone(), quat: camera.quaternion.clone(), up: camera.up.clone(), target: controls.target.clone() };
      controls.enabled = false;
      if (!features.ride("start")) setMode("orbit");
      return;
    }
    if (prev === "ride" && savedView) {
      // Back to exactly the view the ride started from.
      camera.position.copy(savedView.pos);
      camera.quaternion.copy(savedView.quat);
      camera.up.copy(savedView.up);
      controls.target.copy(savedView.target);
      savedView = null;
      controls.enabled = next === "orbit";
      rideEnded();
      return;
    }
    snapRide = next === "plane";
    controls.enabled = next === "orbit";
    if (prev !== "orbit" && next === "orbit") rideEnded();
    if (next === "orbit") {
      camera.up.set(0, 1, 0);
      const dir = camera.position.clone().normalize();
      camera.position.copy(dir).multiplyScalar(Math.max(camera.position.length(), PLANET_R + 24));
    }
  }
  /** The ride ended on its own (Esc, no plane left, ctx.endRide): leave the Courier view too. */
  function rideEnded(): void {
    if (shell && !shell.isSwitching() && shell.activeView() === "courier") shell.back();
  }
  window.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      shell?.handleKey(ev);
      return;
    }
    const t = ev.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (ev.key === "Escape" && (helpUi.escape() || shell?.closeHelp())) return;
    if (ev.key === "Escape" && mode === "ride" && shell?.activeView() !== "courier") {
      setMode("orbit");
      return;
    }
    if (helpUi.welcome.isOpen()) return;
    if (ev.key === "Escape") {
      // Close the topmost thing only: feature overlays (approval card, automations, canvas selection),
      // then the side panel on a planet view, then the view itself (back to the previous one).
      if (features.escape()) return;
      const forced = document.body.classList.contains("alef-panel-forced"); // shown over the Room: Esc closes it first
      if (document.getElementById("panel")?.hidden === false && ((shell?.current()?.usesPlanet && shell.activeView() !== "room") || forced)) panel.hide();
      else if (shell?.escape()) return;
      else panel.hide();
      return;
    }
    shell?.handleKey(ev);
  });

  const rideOffset = new THREE.Vector3();
  const rideLook = new THREE.Vector3();
  let snapRide = false;
  function updateRide(dt: number): void {
    const plane = agentsVisual.flyingPlanes()[0];
    if (!plane) {
      setMode("orbit");
      return;
    }
    const up = plane.pos.clone().normalize();
    rideOffset.copy(plane.pos).addScaledVector(plane.forward, -9).addScaledVector(up, 4.2);
    if (snapRide) camera.position.copy(rideOffset);
    else camera.position.lerp(rideOffset, 1 - Math.exp(-dt * 5));
    snapRide = false;
    rideLook.copy(plane.pos).addScaledVector(plane.forward, 10).addScaledVector(up, -6);
    camera.up.copy(up);
    camera.lookAt(rideLook);
  }

  // Debug views for screenshots: ?cam=close (flyover above the front city), ?cam=plane.
  const camParam = params.get("cam");
  if (camParam === "close") {
    const front = [...layout.values()].find((c) => c.rank === 0);
    const dir = (front?.dir ?? FRONT_DIR).clone();
    // Sit a little "south" of the city so the tilted view looks across it.
    const south = new THREE.Vector3(0, -1, 0).addScaledVector(dir, dir.y).normalize();
    const offset = ((front?.radius ?? 6) + 11) / CITY_SURFACE;
    camera.position.copy(dir.addScaledVector(south, offset).normalize()).multiplyScalar(CITY_SURFACE + 7);
    stopAutoRotate();
  } else {
    camera.position.copy(FRONT_DIR).multiplyScalar(orbitDistanceFor(camera));
  }
  if (camParam === "plane") setMode("plane");

  // ---- LEGACY agent room (dive through the roof into scene/room.ts): UNREACHABLE. ----
  // Nothing calls ctx.planet.enterRoom, so `room` and `roomAgentId` stay null and #room-hud never
  // shows. The Room people use is views/room.ts (the Room tab, "Visit its room", a house click); its
  // dock actions live in views/room-actions.ts. Don't fix the Room here.
  let room: Room | null = null;
  let roomAgentId: string | null = null;
  let pendingRoom: { agentId: string; at: number } | null = null;
  const fade = document.getElementById("fade");
  const roomHud = document.getElementById("room-hud");
  const roomTitle = document.getElementById("room-title");
  const roomMeta = document.getElementById("room-meta");
  const roomStatus = document.getElementById("room-status");
  const roomBtnLabel = document.getElementById("room-btn-label");

  window.addEventListener("resize", () => room?.resize(container!.clientWidth / container!.clientHeight));

  function crossfade(midway: () => void): void {
    if (!fade) {
      midway();
      return;
    }
    fade.classList.add("on");
    window.setTimeout(() => {
      midway();
      window.setTimeout(() => fade.classList.remove("on"), 60);
    }, 260);
  }

  function roomSkills(agentId: string): string[] {
    const names = store.edges
      .filter((e) => e.from === agentId && e.kind === "uses")
      .sort((a, b) => b.weight - a.weight)
      .map((e) => store.objects.get(e.to))
      .filter((o): o is NonNullable<typeof o> => o !== undefined && o.kind === "skill")
      .map((o) => o.name);
    return [...new Set(names)];
  }

  function enterRoom(agentId: string): void {
    const agent = store.agents.get(agentId);
    const house = agentsVisual.houseTopOf(agentId);
    if (!agent || !house) return;
    selected = { kind: "agent", id: agentId };
    panel.hide();
    flyToDir(house, PLANET_R + 6);
    if (fly && !reducedMotion) fly.duration = 0.9;
    pendingRoom = { agentId, at: timer.getElapsed() + 0.85 };
  }

  function openRoomNow(agentId: string): void {
    const agent = store.agents.get(agentId);
    if (!agent) return;
    crossfade(() => {
      room?.dispose();
      const island = store.islands.get(agent.islandId);
      room = buildRoom(
        canvas,
        {
          agent,
          cityName: agent.islandId === "harness" ? "Harness City" : island?.name === "/" ? "root" : (island?.name ?? agent.islandId),
          cityColor: cities.crownColor(agent.islandId),
          files: topTouchedFiles(agentId),
          skills: roomSkills(agentId),
          activities: store.activities.filter((a) => a.agentId === agentId),
        },
        container!.clientWidth / container!.clientHeight,
      );
      roomAgentId = agentId;
      controls.enabled = false;
      document.body.classList.add("in-room");
      if (roomHud) roomHud.hidden = false;
      if (roomTitle) roomTitle.textContent = agentTitle(agent);
      if (roomMeta) roomMeta.textContent = `${agent.islandId} · ${agent.status} · last active ${new Date(agent.lastActive).toLocaleString()}`;
      if (roomStatus) roomStatus.textContent = "";
      if (roomBtnLabel) {
        roomBtnLabel.textContent = agent.status === "live" ? "Already live" : "Reactivate";
        roomBtnLabel.classList.toggle("muted", agent.status === "live");
      }
      tooltip.hide();
    });
  }

  function exitRoom(): void {
    if (!room || !roomAgentId) return;
    const house = agentsVisual.houseTopOf(roomAgentId);
    crossfade(() => {
      room?.dispose();
      room = null;
      roomAgentId = null;
      document.body.classList.remove("in-room");
      if (roomHud) roomHud.hidden = true;
      controls.enabled = mode === "orbit";
      if (house) camera.position.copy(house).normalize().multiplyScalar(PLANET_R + 16);
      tooltip.hide();
    });
  }
  document.getElementById("room-back")?.addEventListener("click", exitRoom);
  document.getElementById("room-editor")?.addEventListener("click", () => {
    if (roomAgentId) void roomAction("editor");
  });
  roomBtnLabel?.addEventListener("click", () => {
    if (roomAgentId) void roomAction("reactivate");
  });

  async function roomAction(kind: "editor" | "reactivate"): Promise<void> {
    const id = roomAgentId; // always null: see LEGACY above
    if (id && store.agents.has(id)) await openIn(kind, id, { status: roomStatus });
  }

  function roomHitLabel(h: RoomHit): string {
    if (h.kind === "file") return `${h.name} · click to open the project in VS Code`;
    if (h.kind === "skill") return `skill: ${h.name}`;
    if (h.kind === "reactivate") return "Reactivate this agent";
    return "Live activity";
  }

  function roomNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  // ---- pointer ----
  const ndc = new THREE.Vector2();
  const down = { x: 0, y: 0 };
  function pickAt(clientX: number, clientY: number): Pick | null {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    return pick.pick(ndc, camera, PLANET_R + 0.4);
  }
  function labelFor(p: Pick): string {
    if (p.kind === "agent") {
      const a = store.agents.get(p.id);
      return a ? `${a.status === "live" ? "Driving" : "Asleep"} · ${agentTitle(a)}` : p.id;
    }
    if (p.kind === "jev") return "Jev, the moon that decides";
    if (p.kind === "city") {
      if (p.id === "harness") return "Harness City";
      const isl = store.islands.get(p.id);
      return isl ? displayIslandName(isl) : p.id;
    }
    const o = store.objects.get(p.id);
    return o ? `${o.kind}: ${o.name}` : p.id;
  }
  let lastHover = 0;
  canvas.addEventListener("pointermove", (ev) => {
    const now = performance.now();
    if (now - lastHover < 50 || ev.buttons) return;
    lastHover = now;
    if (room) {
      const h = room.hit(roomNdc(ev.clientX, ev.clientY));
      if (h) tooltip.show(roomHitLabel(h), ev.clientX, ev.clientY);
      else tooltip.hide();
      canvas.style.cursor = h && h.kind !== "monitor" && h.kind !== "skill" ? "pointer" : "grab";
      return;
    }
    const p = pickAt(ev.clientX, ev.clientY);
    if (p) {
      tooltip.show(labelFor(p), ev.clientX, ev.clientY);
      canvas.style.cursor = "pointer";
    } else {
      tooltip.hide();
      canvas.style.cursor = "grab";
    }
  });
  canvas.addEventListener("pointerdown", (ev) => {
    down.x = ev.clientX;
    down.y = ev.clientY;
    stopAutoRotate();
  });
  canvas.addEventListener("wheel", stopAutoRotate, { passive: true });
  canvas.addEventListener("click", (ev) => {
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) return;
    if (room) {
      const h = room.hit(roomNdc(ev.clientX, ev.clientY));
      if (h?.kind === "file") void roomAction("editor");
      if (h?.kind === "reactivate") void roomAction("reactivate");
      return;
    }
    const p = pickAt(ev.clientX, ev.clientY);
    if (p?.kind === "agent") shell?.showView("room", p.id);
    else if (p) selectPick(p);
  });

  // ---- live updates ----
  store.onAgentsRemoved((ids) => {
    agentsVisual.hide(new Set(ids));
    if (selected?.kind === "agent" && ids.includes(selected.id)) {
      selected = null;
      panel.hide();
      shell?.selected(null);
    }
  });
  store.onAgents((agents) => {
    for (const a of agents) agentsVisual.upsert(a);
    if (selected?.kind === "agent" && panel.isOpen()) {
      const agent = store.agents.get(selected.id);
      if (agent && agents.some((a) => a.id === agent.id)) panel.showAgent(agent, topTouchedFiles(agent.id), placementNoteFor(agent));
    }
    refreshAwaiting();
    refreshPips();
    refreshCityStats();
  });
  store.onActivity((fresh) => {
    if (room && roomAgentId && fresh.some((a) => a.agentId === roomAgentId)) {
      room.setActivities(store.activities.filter((a) => a.agentId === roomAgentId));
    }
    ingestActivities(fresh, true);
    storeActivities(store.activities);
  });
  refreshAwaiting();
  // Automated Runs sub-districts move houses after boot: re-anchor "!" bubbles and pips on the new house tops.
  agentsVisual.onHousesMoved(() => {
    refreshAwaiting();
    refreshPips();
  });
  store.onObjects((objs) => {
    for (const o of objs) cities.setGrowthTarget(o);
    if (selected?.kind === "object" && panel.isOpen()) {
      const obj = store.objects.get(selected.id);
      if (obj) panel.showObject(obj);
    }
  });
  store.onObjectsRemoved((ids) => {
    if (selected?.kind === "object" && ids.includes(selected.id)) {
      selected = null;
      panel.hide();
      shell?.selected(null);
    }
  });

  function decisionTargets(decision: JevDecision): THREE.Vector3[] {
    const islandIds = new Set<string>();
    for (const s of decision.subjects) {
      const island = store.agents.get(s)?.islandId ?? store.objects.get(s)?.islandId ?? (store.islands.has(s) ? s : undefined);
      if (island) islandIds.add(island);
    }
    return [...islandIds].map((id) => cities.towerTop(id)).filter((p): p is THREE.Vector3 => p !== undefined);
  }
  function playDecision(decision: JevDecision): void {
    const elapsed = timer.getElapsed();
    const targets = decisionTargets(decision);
    moon.zap(targets, elapsed);
    bubble.say(decision.summary, moon.position, elapsed + 4);
    bubble.zapAt(targets, elapsed + 1.6);
    plaza?.splash(elapsed);
  }
  store.onDecision((decision, status) => {
    moon.setStatus(status);
    playDecision(decision);
    if (selected?.kind === "jev" && panel.isOpen()) panel.showJev(store.jev);
  });
  // ?zap=1 replays the newest decision every 3s (for screenshots).
  const debugZap = params.has("zap") ? store.jev.decisions[0] : undefined;
  let lastDebugZap = -10;

  dataSource.onMessage((msg) => {
    switch (msg.type) {
      case "snapshot":
        // Geometry is laid out once; a mid-session snapshot refreshes data only.
        log.warn("main", "received a mid-session snapshot; data updated, geometry unchanged");
        store.loadSnapshot(msg.world);
        features.snapshot(msg.world);
        break;
      case "agents":
        store.upsertAgents(msg.agents);
        break;
      case "objects":
        store.upsertObjects(msg.objects);
        break;
      case "objectsRemoved":
        store.removeObjects(msg.ids);
        break;
      case "edges":
        store.setEdges(msg.edges);
        break;
      case "decision":
        store.addDecision(msg.decision, msg.jevStatus);
        break;
      case "activity":
        store.addActivities(msg.activities);
        break;
      case "stats":
        store.setStats(msg.stats);
        break;
      case "agentsRemoved":
        store.removeAgents(msg.ids);
        break;
      case "feature":
        features.message(msg);
        break;
    }
  });

  // ?activity=replay re-plays the last real activities (this browser's ring buffer, else what the
  // server has pushed so far) every 7s, for screenshots. Never invents lines.
  const replay = params.get("activity") === "replay";
  if (params.has("slowfx")) document.body.classList.add("slowfx");
  let lastReplay = -Infinity;
  const stored = loadStoredActivities();
  const replaySource = (): AgentActivity[] => {
    const seen = new Set<string>();
    return [...stored, ...store.activities]
      .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
      .filter((a) => store.agents.has(a.agentId))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  };
  if (stored.length) ingestActivities(stored.filter((a) => store.agents.has(a.agentId)).slice(-6), false);
  // Other debug hooks for screenshots: ?palette=<query>, ?askjev=<question>, ?select=jev.
  // ?room=<agentId|live|recent> opens that agent's room (screenshots): routed by the shell.
  const roomParam = params.get("room");
  if (roomParam === "live" || roomParam === "recent") {
    const pickId = [...store.agents.values()]
      .filter((a) => roomParam === "recent" || a.status === "live")
      .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive))[0]?.id;
    if (pickId) history.replaceState(null, "", `${location.pathname}${location.search}#/room/${encodeURIComponent(pickId)}`);
  }
  const paletteParam = params.get("palette");
  // The debug hook lost its only use when the palette moved into the shell (round 7): restored.
  if (paletteParam !== null) shell?.focusSearch(paletteParam);
  const askParam = params.get("askjev");
  if (askParam) {
    selectPick({ kind: "jev", id: "jev" });
    void ask.ask(askParam);
  } else if (params.get("select") === "jev") {
    selectPick({ kind: "jev", id: "jev" });
  }
  store.onSnapshot(() => refreshAwaiting());

  let lastPinned = -10;
  let compassCities: { dir: THREE.Vector3; kind: "capital" | "live" | "awaiting" | "city" }[] = [];
  const exploreParam = params.get("explore");
  if (exploreParam) flyToCity(exploreParam === "top" ? (islands.filter((i) => i.id !== "harness").sort((a, b) => activityScore(statsByCity.get(b.id)) - activityScore(statsByCity.get(a.id)))[0]?.id ?? "harness") : exploreParam);

  // ---- round 5 E: collapsible chrome (E1), focus mode (E2), zen mode (E3) ----
  // One block, so the parallel courier/ride work in this file never collides with it.
  // Every surface goes through kit's collapsible(); H/F/Z only change the chrome *mode*,
  // which never overwrites the per-surface choices remembered in localStorage.
  const fold = (id: string, elId: string, opts: CollapsibleOpts): CollapsibleHandle | null => {
    const el = document.getElementById(elId);
    return el ? collapsible(el, id, opts) : null;
  };
  const inlineHead = (elId: string, sel?: string): HTMLElement | null => {
    const el = document.getElementById(elId);
    return sel ? (el?.querySelector<HTMLElement>(sel) ?? null) : el;
  };
  // Top bar, sidebars and status bar belong to the Alef shell (rails, H, focus); these float.
  fold("compass", "compass-box", { pillLabel: "Compass", icon: "🧭", corner: "br" });
  fold("replay", "replay-badge", { pillLabel: "Replay", icon: "⏪", corner: "tc", header: inlineHead("replay-badge") });
  // The prompt box (docked above the status bar) and the details panel (the one contextual
  // sidebar, docked at the main area's right edge) are shell chrome: no collapse-to-pill.

  let view: ViewState = NORMAL;
  let hiddenBeforeView = false;
  let savedCam: { pos: THREE.Vector3; quat: THREE.Quaternion; up: THREE.Vector3; target: THREE.Vector3; autoRotate: boolean; enabled: boolean } | null = null;
  let hoverAgent: { id: string; at: number } | null = null;
  let focusTheta = 0;
  let zenTheta = 0;
  let focusStateSeen: string | undefined;
  const viewLook = new THREE.Vector3();
  const focusCard = mountFocusCard(ctx, { cityName: cityNameOf, onExit: () => applyView(nextView(view, { type: "escape" })) });
  const focusDim = document.createElement("div");
  focusDim.id = "focus-dim";
  focusDim.hidden = true;
  const zenHint = document.createElement("div");
  zenHint.id = "zen-hint";
  zenHint.hidden = true;
  zenHint.textContent = "Zen mode · any key or click to come back";
  document.body.append(focusDim, zenHint);

  function lookPointNow(): THREE.Vector3 {
    return camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(camera.position.length()).add(camera.position);
  }

  function tangentBasis(n: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const ref = Math.abs(n.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(ref, n).normalize();
    return [t1, new THREE.Vector3().crossVectors(n, t1).normalize()];
  }

  function applyView(next: ViewState): void {
    if (next === view) return;
    const prev = view;
    if (prev.mode === "normal" && next.mode !== "normal") {
      hiddenBeforeView = chromeMode() === "hidden";
      savedCam = { pos: camera.position.clone(), quat: camera.quaternion.clone(), up: camera.up.clone(), target: controls.target.clone(), autoRotate: controls.autoRotate, enabled: controls.enabled };
      fly = null;
      controls.enabled = false;
      tooltip.hide();
    }
    view = next;
    setChromeMode(chromeModeFor(next, hiddenBeforeView));
    viewLook.copy(lookPointNow());
    if (next.mode === "focus") {
      const switched = prev.mode !== "focus" || prev.agentId !== next.agentId;
      const house = agentsVisual.houseTopOf(next.agentId);
      if (switched && house) {
        const n = house.clone().normalize();
        const [t1, t2] = tangentBasis(n);
        const off = camera.position.clone().sub(house);
        focusTheta = Math.atan2(off.dot(t2), off.dot(t1));
      }
      if (switched) focusStateSeen = agentStateOf(next.agentId);
      focusCard.show(next.agentId);
    } else focusCard.hide();
    focusDim.hidden = next.mode !== "focus";
    if (next.mode !== "focus") camera.clearViewOffset();
    if (next.mode === "zen") {
      zenTheta = Math.atan2(camera.position.x, camera.position.z);
      zenHint.hidden = false;
      zenHint.classList.remove("zen-fade");
      void zenHint.offsetWidth; // restart the 3s fade
      zenHint.classList.add("zen-fade");
    } else zenHint.hidden = true;
    if (next.mode === "normal" && savedCam) {
      // Back to exactly where you were.
      camera.position.copy(savedCam.pos);
      camera.quaternion.copy(savedCam.quat);
      camera.up.copy(savedCam.up);
      controls.target.copy(savedCam.target);
      controls.autoRotate = savedCam.autoRotate;
      controls.enabled = savedCam.enabled && mode === "orbit";
      savedCam = null;
      fly = null;
    }
  }

  function focusTarget(): string | null {
    const hovered = hoverAgent && performance.now() - hoverAgent.at < 1500 ? hoverAgent.id : null;
    return hovered ?? (selected?.kind === "agent" ? selected.id : null);
  }

  /** F, the panel's "Focus" button and the room's "Focus" button all land here. */
  function focusOn(agentId: string | null): void {
    if (mode !== "orbit" && view.mode === "normal") return; // the courier run owns the camera
    if (room || shell?.activeView() === "room") {
      const id = agentId ?? roomAgentId;
      shell?.showView("orbit");
      if (id) window.setTimeout(() => applyView(nextView(view, { type: "focus", target: id })), 340);
      return;
    }
    const next = nextView(view, { type: "focus", target: agentId });
    if (next === view && view.mode === "normal") toast("Select or hover over an agent's house first, then press F.");
    applyView(next);
  }

  /** Focus / zen own the camera; returns false in normal view (the hub's orbit/ride then runs). */
  function viewCamera(dt: number): boolean {
    if (view.mode === "normal") return false;
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 2.4);
    if (view.mode === "focus") {
      const house = agentsVisual.houseTopOf(view.agentId);
      if (!house) {
        applyView(nextView(view, { type: "gone", agentId: view.agentId }));
        return false;
      }
      const n = house.clone().normalize();
      const [t1, t2] = tangentBasis(n);
      if (!reducedMotion) focusTheta += dt * 0.12; // a gentle orbit around the house
      const goal = house.clone().addScaledVector(n, 7).addScaledVector(t1, Math.cos(focusTheta) * 11).addScaledVector(t2, Math.sin(focusTheta) * 11);
      camera.position.lerp(goal, k);
      if (camera.position.length() < PLANET_R + 4) camera.position.setLength(PLANET_R + 4);
      camera.up.lerp(n, k).normalize();
      viewLook.lerp(house, k);
      camera.lookAt(viewLook);
      // Keep the house clear of the focus card: shift the view left (desktop) or up (phone).
      const card = focusCard.el.getBoundingClientRect();
      const phone = w() <= 520;
      camera.setViewOffset(w(), h(), phone ? 0 : Math.round((card.width + 16) / 2), phone ? Math.round(card.height / 2) : 0, w(), h());
      camera.updateMatrixWorld();
      const p = house.clone().project(camera);
      focusDim.style.setProperty("--fx", `${Math.round((p.x * 0.5 + 0.5) * w())}px`);
      focusDim.style.setProperty("--fy", `${Math.round((-p.y * 0.5 + 0.5) * h())}px`);
      return true;
    }
    // Zen: a slow, high, cinematic lap around the whole planet.
    if (!reducedMotion) zenTheta += dt * 0.05;
    const el = 0.3;
    const dist = orbitDistanceFor(camera) * 1.06;
    const goal = new THREE.Vector3(Math.cos(el) * Math.sin(zenTheta), Math.sin(el), Math.cos(el) * Math.cos(zenTheta)).multiplyScalar(dist);
    camera.position.lerp(goal, reducedMotion ? 1 : 1 - Math.exp(-dt * 0.9));
    if (camera.position.length() < PLANET_R + 6) camera.position.setLength(PLANET_R + 6);
    camera.up.lerp(new THREE.Vector3(0, 1, 0), k).normalize();
    viewLook.lerp(new THREE.Vector3(), k);
    camera.lookAt(viewLook);
    return true;
  }

  // Soft chime (sound toggle respected) when the focused agent starts waiting for you.
  onAgentStates(() => {
    const id = focusedAgent(view);
    if (!id) return;
    const next = agentStateOf(id);
    if (enteredWaiting(focusStateSeen, next)) {
      playFocusChime();
      const top = agentsVisual.houseTopOf(id);
      if (top) overlays.burst("YOUR TURN!", top);
    }
    focusStateSeen = next;
  });
  store.onAgents(() => {
    const id = focusedAgent(view);
    if (id && !store.agents.has(id)) applyView(nextView(view, { type: "gone", agentId: id }));
  });
  // A permission request: zen steps aside so the card shows; focus on someone else gets a nudge.
  window.addEventListener("aw:approval", (ev) => {
    const agentId = ev instanceof CustomEvent && typeof ev.detail === "string" ? ev.detail : "";
    if (view.mode === "zen") applyView(nextView(view, { type: "approval" }));
    if (view.mode === "focus" && agentId !== view.agentId) {
      const other = store.agents.get(agentId);
      toast(`${other ? agentTitle(other) : "Another agent"} needs your permission. Press F to leave focus.`);
    }
  });

  const isTyping = (t: EventTarget | null): boolean =>
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
  // Capture phase: runs before the hub's keydown, so zen can swallow every key and Esc
  // leaves focus before it would close anything else.
  window.addEventListener(
    "keydown",
    (ev) => {
      if (view.mode === "zen") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (!ev.repeat) applyView(nextView(view, { type: "wake" }));
        return;
      }
      if (isTyping(ev.target)) {
        if (ev.key === "Escape" && view.mode === "focus" && ev.target instanceof HTMLElement && focusCard.el.contains(ev.target)) ev.target.blur();
        return;
      }
      if (helpUi.welcome.isOpen() || document.querySelector(".ui-backdrop:not([hidden])")) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "Escape" && shell?.genericFocus()) {
        ev.stopImmediatePropagation();
        shell.setFocus(false);
        return;
      }
      if (view.mode === "focus" && ev.key === "Escape") {
        ev.stopImmediatePropagation();
        applyView(nextView(view, { type: "escape" }));
        return;
      }
      if (view.mode === "focus" && shell?.viewForKey(ev.key)) applyView(NORMAL); // then the shell switches view
      const key = ev.key.toLowerCase();
      if (key !== "h" && key !== "f" && key !== "z") return;
      ev.stopImmediatePropagation();
      if (key === "h") {
        if (view.mode === "normal" && !shell?.genericFocus()) toggleHideAllChrome();
      } else if (key === "f") {
        // Orbit + an agent under the cursor / selected: the camera locks on it. Anywhere else:
        // focus mode for the whole view (the shell hides its chrome, the view drops its noise).
        const target = focusTarget();
        if (shell?.genericFocus()) shell.setFocus(false);
        else if (view.mode === "focus" || (shell?.activeView() === "orbit" && target)) focusOn(target);
        else shell?.setFocus(true);
      } else if (shell && shell.activeView() !== "orbit" && view.mode === "normal") {
        // Zen is a slow lap of the planet: go back to Orbit first.
        shell.showView("orbit");
        window.setTimeout(() => applyView(nextView(view, { type: "zen" })), 50);
      } else if (mode === "orbit" || view.mode !== "normal") applyView(nextView(view, { type: "zen" }));
    },
    true,
  );

  let lastHoverPick = 0;
  canvas.addEventListener("pointermove", (ev) => {
    const now = performance.now();
    if (now - lastHoverPick < 80 || ev.buttons || room) return;
    lastHoverPick = now;
    const p = pickAt(ev.clientX, ev.clientY);
    if (p?.kind === "agent") hoverAgent = { id: p.id, at: now };
    else if (hoverAgent && now - hoverAgent.at > 300) hoverAgent = null;
  });
  // Zen: any click comes back (and the click does nothing else). Focus: a house click switches focus.
  let swallowClick = false;
  window.addEventListener(
    "pointerdown",
    (ev) => {
      if (view.mode !== "zen") return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      swallowClick = true;
      applyView(nextView(view, { type: "wake" }));
    },
    true,
  );
  window.addEventListener(
    "click",
    (ev) => {
      if (swallowClick) {
        swallowClick = false;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
      if (view.mode !== "focus" || ev.target !== canvas) return;
      ev.stopImmediatePropagation();
      const p = pickAt(ev.clientX, ev.clientY);
      if (p?.kind === "agent" && p.id !== view.agentId) applyView(nextView(view, { type: "focus", target: p.id }));
    },
    true,
  );
  document.getElementById("room-focus")?.addEventListener("click", () => focusOn(roomAgentId));
  const focusParam = params.get("focus");
  if (focusParam) {
    const id =
      focusParam === "live" || focusParam === "recent"
        ? [...store.agents.values()]
            .filter((a) => focusParam === "recent" || a.status === "live")
            .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive))[0]?.id
        : focusParam;
    if (id) window.setTimeout(() => focusOn(id), 300);
  }
  if (params.get("zen") === "1") window.setTimeout(() => applyView(nextView(view, { type: "zen" })), 300);
  if (params.get("chrome") === "hidden") toggleHideAllChrome();
  // ---- end round 5 E ----

  // ---- loop ----
  const w = (): number => container.clientWidth;
  const h = (): number => container.clientHeight;

  /** The 3D canvas is full-screen behind the shell: shift the view so the planet sits in the
   *  middle of the main area (between the sidebars), not the middle of the window. */
  function centerInMainArea(): void {
    const ins = shell?.insets();
    if (!ins) return;
    const dx = Math.round((ins.left - ins.right) / 2);
    const dy = Math.round((ins.top - ins.bottom) / 2);
    const v = camera.view;
    if (dx === 0 && dy === 0) {
      if (v?.enabled) camera.clearViewOffset();
      return;
    }
    if (v?.enabled && v.offsetX === -dx && v.offsetY === -dy && v.fullWidth === w() && v.fullHeight === h()) return;
    camera.setViewOffset(w(), h(), -dx, -dy, w(), h());
  }

  // Rolling frame stats for adaptive quality / the Health view (scene bus, every 0.5s).
  const frameMs: number[] = [];
  let lastFrameAt = 0;
  let lastStatsAt = 0;
  function recordFrame(now: number): void {
    if (lastFrameAt) frameMs.push(now - lastFrameAt);
    lastFrameAt = now;
    if (frameMs.length > 600) frameMs.splice(0, frameMs.length - 600);
    if (now - lastStatsAt < 500 || frameMs.length < 10) return;
    lastStatsAt = now;
    let sum = 0;
    let n = 0;
    for (let i = frameMs.length - 1; i >= 0 && sum < 1000; i--, n++) sum += frameMs[i] ?? 0;
    const sorted = frameMs.slice().sort((a, b) => a - b);
    registerSceneParts({ frameStats: { fps: sum > 0 ? (n * 1000) / sum : 0, p95ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0 } });
  }

  function animate(now: number): void {
    const drawing = glStatus.drawing();
    if (drawing) recordFrame(now);
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    const elapsed = timer.getElapsed();
    // No WebGL, or its context is lost: the shell and the clock keep running, nothing 3D does, and
    // no frame stats are written (nothing is drawn, so there is no frame rate to report).
    if (!gl || !drawing) {
      // A swoop in flight when the context went: open its Room now, not on a restore later.
      landDive(elapsed, drawing);
      requestAnimationFrame(animate);
      return;
    }
    shell?.frame(dt);
    // A non-planet view (Board, Canvas, Code…) covers the planet: skip the 3D frame.
    if (shell?.pausesPlanet()) {
      requestAnimationFrame(animate);
      return;
    }

    if (debugZap && elapsed - lastDebugZap > 3) {
      playDecision(debugZap);
      lastDebugZap = elapsed;
    }
    const act = activityQueue.take(performance.now());
    if (act) animateActivity(act, elapsed);
    if (replay && performance.now() - lastReplay > 7000) {
      lastReplay = performance.now();
      const pool = replaySource();
      // Always include the latest lines that hit a building so a replay shows a trip / burst.
      const targeted = pool.filter((x) => x.targetObjectId).slice(-3);
      const batch = [...new Map([...pool.slice(-6), ...targeted].map((x) => [x.id, x])).values()];
      if (batch.length) ingestActivities(batch, true);
    }
    landDive(elapsed, drawing);
    if (pendingRoom && elapsed >= pendingRoom.at) {
      const id = pendingRoom.agentId;
      pendingRoom = null;
      openRoomNow(id);
    }
    if (room) {
      room.update(dt, elapsed);
      gl.post.render({ scene: room.scene, camera: room.camera });
      if (roomBtnLabel) {
        const p = room.buttonAnchor.clone().project(room.camera);
        roomBtnLabel.style.transform = `translate(${Math.round((p.x * 0.5 + 0.5) * w())}px, ${Math.round((-p.y * 0.5 + 0.5) * h())}px) translate(-50%, -100%)`;
      }
      requestAnimationFrame(animate);
      return;
    }
    planet.update(dt);
    cities.update(dt, elapsed);
    agentsVisual.update(dt, elapsed);
    moon.update(dt, elapsed, camera);
    plaza?.update(dt, elapsed);

    if (viewCamera(dt)) {
      // round 5 E: focus / zen own the camera this frame
    } else if (mode === "orbit") {
      updateFly(elapsed);
      if (!userInteracted) {
        controls.autoRotate = !reducedMotion;
        // Until the first interaction, keep the whole globe framed (viewport may settle late on phones).
        if (!fly) camera.position.setLength(orbitDistanceFor(camera));
      }
      if (!fly && !reducedMotion) applyIdleCamera(elapsed, dt);
      controls.update(dt);
      applyFlyoverTilt();
      centerInMainArea();
    } else if (mode === "ride") {
      if (!features.ride("frame", dt)) setMode("orbit");
    } else {
      updateRide(dt);
    }

    const sel = selectedPosition();
    marker.visible = sel !== undefined;
    if (sel) {
      const up = sel.clone().normalize();
      marker.position.copy(sel).addScaledVector(up, 1.6 + Math.abs(Math.sin(elapsed * 4)) * 0.8);
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    }

    // lookAt() refreshes the world matrix *before* rotating, so after the flyover tilt the
    // inverse still points at the planet centre: refresh it before projecting DOM overlays.
    camera.updateMatrixWorld();
    labels.update(camera, w(), h());
    overlays.update(camera, w(), h());
    compass.update(camera, compassCities);
    if (elapsed - lastPinned > 1) {
      lastPinned = elapsed;
      // Zoomed out on a wide screen: pin mini stat lines under the ~6 busiest cities.
      const far = camera.position.length() > PLANET_R * 2.4 && w() > 900;
      const pinned = new Map<string, string>();
      if (far) {
        const top = islands
          .filter((i) => i.id !== "harness")
          .sort((a, b) => activityScore(statsByCity.get(b.id)) - activityScore(statsByCity.get(a.id)))
          .slice(0, 6);
        for (const i of top) {
          const st = statsByCity.get(i.id);
          if (!st || (st.live === 0 && st.activeToday === 0 && st.awaiting === 0)) continue;
          const parts = [st.awaiting ? `${st.awaiting} waiting` : "", st.live ? `${st.live} live` : "", st.activeToday ? `${st.activeToday} today` : ""].filter(Boolean);
          pinned.set(i.id, parts.join(" · "));
        }
      }
      labels.setPinned(pinned);
      compassCities = islands.flatMap((i) => {
        const c = layout.get(i.id);
        if (!c) return [];
        const st = statsByCity.get(i.id);
        const kind: "capital" | "live" | "awaiting" | "city" = i.id === "harness" ? "capital" : st?.awaiting ? "awaiting" : st?.live ? "live" : "city";
        return [{ dir: c.dir, kind }];
      });
    }
    bubble.update(camera, w(), h(), elapsed);
    features.frame(dt);
    // The Room paints over the whole canvas: skip the planet's own picture, keep its hooks.
    if (shell?.coversPlanet()) gl.post.runHooksOnly();
    else gl.post.render();

    requestAnimationFrame(animate);
  }
  shell.start();
  requestAnimationFrame(animate);
  helpUi.maybeWelcome();
  log.info("main", `Alef ready (${layout.size} cities, view ${shell.activeView()})`);
}

main().catch((err) => {
  log.error("main", "fatal startup error", err);
  const fatal = document.getElementById("fatal");
  if (!fatal) return;
  if (!/WebGL/i.test(String(err))) {
    const reason = document.getElementById("fatal-reason");
    if (reason) reason.textContent = "Something broke while building the world. Reload to try again.";
  }
  document.getElementById("fatal-reload")?.addEventListener("click", () => location.reload());
  fatal.hidden = false;
});
