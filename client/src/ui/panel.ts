import { agentTitle, displayIslandName } from "../../../shared/display";
import type { KnownOutcome, OutcomeRecord, PrState } from "../../../shared/features/outcomes";
import type { Island, JevState, WorldAgent, WorldObject } from "../../../shared/types";
import { getJson } from "../api";
import { outcomeChip, outcomeOf } from "../features/outcomes";
import { escapeHtml, formatTokens, relativeTime } from "./fuzzy";

const PR_STATE_LABEL: Readonly<Record<PrState, string>> = {
  MERGED: "merged",
  OPEN: "open",
  CLOSED: "closed",
  unknown: "merge state unknown",
  unchecked: "not checked yet",
};

/** http(s) only: a PR or artifact link is one click away, so a stray javascript:/data: URL
 *  (however it got into a record) never becomes a clickable href. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function linkListItem(text: string, url: string): HTMLLIElement {
  const li = document.createElement("li");
  const a = document.createElement("a");
  const safe = safeHref(url);
  if (safe) {
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener";
  }
  a.textContent = text;
  li.appendChild(a);
  return li;
}

/** The Outcome row (round 2, graduation-badges): the headline chip always; PR links with their
 *  merge state, artifact links and the ending reason once the full record (GET /api/outcomes/:id)
 *  arrives. Built with createElement + textContent throughout, never innerHTML, so a hostile
 *  title, reason or repo name in the record can never become markup. */
export function buildOutcomeSection(known: KnownOutcome | null, record: OutcomeRecord | null): HTMLElement {
  const section = document.createElement("div");
  section.className = "panel-outcome";

  const chip = known ? outcomeChip(known) : null;
  const headline = document.createElement("div");
  // outcomeChip() returns null for both "active" (a live session; no 🎓/✗/etc chip on purpose)
  // and "unknown"/null (no evidence at all) — but those read very differently: a live session HAS
  // evidence (it's running now), so only a truly unknown/uncomputed session gets the grey
  // "no outcome evidence" headline (matching the Board's own OUTCOME_FILTER_LABEL.active).
  const label = chip ? `${chip.emoji} ${chip.label}` : known === "active" ? "active now" : "no outcome evidence";
  headline.className = chip || known === "active" ? "panel-outcome-chip" : "panel-outcome-chip panel-outcome-unknown";
  headline.textContent = label;
  section.appendChild(headline);

  if (record?.prs.length) {
    const ul = document.createElement("ul");
    ul.className = "panel-outcome-prs";
    for (const pr of record.prs) {
      const li = linkListItem(`${pr.repo}#${pr.number}`, pr.url);
      const state = document.createElement("span");
      state.className = "panel-outcome-pr-state";
      state.textContent = ` · ${PR_STATE_LABEL[pr.state]}`;
      li.appendChild(state);
      ul.appendChild(li);
    }
    section.appendChild(ul);
  }

  if (record?.artifacts.length) {
    const ul = document.createElement("ul");
    ul.className = "panel-outcome-artifacts";
    for (const url of record.artifacts) ul.appendChild(linkListItem(url, url));
    section.appendChild(ul);
  }

  const reasonText = record?.ending?.reason ?? record?.reason ?? null;
  if (reasonText) {
    const div = document.createElement("div");
    div.className = "panel-outcome-reason";
    div.textContent = reasonText;
    section.appendChild(div);
  }

  return section;
}

/** A GET /api/outcomes/:agentId response, cheaply sanity-checked (getJson casts, it doesn't
 *  validate) before it's trusted enough to render. */
function isOutcomeRecord(v: unknown): v is OutcomeRecord {
  return typeof v === "object" && v !== null && Array.isArray((v as { prs?: unknown }).prs) && Array.isArray((v as { artifacts?: unknown }).artifacts);
}

export interface TouchedFile {
  name: string;
  weight: number;
}

export interface PanelApi {
  /** `placementNote` (ui/placement-note.ts): why the city is not the cwd — a catch-all session re-homed onto a repo's
   *  island by its touched files (home-placement.ts) — e.g. "placed by touched files: repo-a". */
  showAgent(agent: WorldAgent, topFiles: TouchedFile[], placementNote?: string): void;
  /** `askSlot` (the Ask-Jev widget) is mounted at the top of the Jev panel. */
  showJev(jev: JevState, askSlot?: HTMLElement): void;
  showObject(obj: WorldObject): void;
  showCity(island: Island, liveCount: number, objectCount: number): void;
  /** Feature panels: a heading plus a body element the feature owns. */
  showCustom(title: string, body: HTMLElement): void;
  hide(): void;
  /** Live updates refresh the panel only while it is open (it is contextual: a click opens it). */
  isOpen(): boolean;
}

type OpenKind = "reactivate" | "editor";

export interface PanelOptions {
  onVisitRoom?: (agentId: string) => void;
  onFocus?: (agentId: string) => void;
  /** Reactivate / Open in VS Code (main.ts runs them through ui/agent-open.ts, like the palette and the
   *  Room). The panel re-renders on live updates, so `ui` holds getters for the nodes on screen now. */
  onAction?: (kind: OpenKind, agentId: string, ui: { status: () => HTMLElement | null; button: () => HTMLButtonElement | null }) => void;
  /** The pending text of a request still running for this agent (ui/agent-open.ts openPending). */
  pending?: (kind: OpenKind, agentId: string) => string | null;
  /** Its last finished request's outcome line, while fresh (ui/agent-open.ts openOutcome). */
  outcome?: (agentId: string) => { text: string; error: boolean } | null;
}

/** The Reactivate / Open in VS Code buttons and the status line. A request still running when the
 *  panel re-renders keeps its button busy and its pending text, so a second click can't look dead;
 *  a finished one keeps its outcome line. */
export function panelActionsHtml(
  isLive: boolean,
  pending: { reactivate: string | null; editor: string | null },
  outcome: { text: string; error: boolean } | null = null,
): string {
  const busy = 'disabled aria-busy="true"';
  const reactivate = isLive ? 'disabled title="already live"' : pending.reactivate ? busy : "";
  const line = pending.reactivate ?? pending.editor;
  const shown = line ?? outcome?.text ?? "";
  const cls = line === null && outcome?.error ? ' class="error"' : "";
  return `
        <div class="panel-actions">
          <button id="reactivate-btn" class="comic-btn" ${reactivate}>Reactivate</button>
          <button id="editor-btn" class="comic-btn secondary" type="button" ${pending.editor ? busy : ""}>Open in VS Code</button>
        </div>
        <button id="focus-btn" class="comic-btn wide" type="button" title="Hide everything else and follow this agent (F)">Focus on this agent <kbd>F</kbd></button>
        <button id="room-btn" class="comic-btn secondary wide" type="button">Visit its room</button>
        <div id="reactivate-status" role="status"${cls}>${escapeHtml(shown)}</div>`;
}

export function mountPanel(opts: PanelOptions = {}): PanelApi {
  const panel = document.getElementById("panel");
  const content = document.getElementById("panel-content");
  const closeBtn = document.getElementById("panel-close");
  if (!panel || !content || !closeBtn) throw new Error("panel DOM elements missing from index.html");

  // body.panel-open hides the other right-side widgets (ticker, compass): one thing on the right at a time.
  // body.alef-panel-forced: a panel someone explicitly opened (a palette command, a Settings button,
  // Jev's answer) shows even over the Room, which otherwise hides the contextual panel (room.css).
  const setOpen = (open: boolean, forced = false): void => {
    panel.hidden = !open;
    document.body.classList.toggle("panel-open", open);
    document.body.classList.toggle("alef-panel-forced", open && forced);
  };
  closeBtn.addEventListener("click", () => setOpen(false));

  // Narrowed by the throw above; `function` declarations are hoisted out of
  // that control-flow scope, so a non-null assertion documents the invariant.
  function open(forced = false): void {
    setOpen(true, forced);
  }

  let rememberedAskSlot: HTMLElement | undefined;

  return {
    showAgent(agent, topFiles, placementNote) {
      // Feature plugins watch #panel-content and read this to add their own sections.
      content.dataset.agentId = agent.id;
      const isLive = agent.status === "live";
      const tokens = typeof agent.tokens === "number" ? formatTokens(agent.tokens) : "unknown";
      content.innerHTML = `
        ${agent.awaitingInput === true ? `<div class="awaiting-flag">Waiting for you!</div>` : ""}
        <h2>${escapeHtml(agentTitle(agent))}</h2>
        <dl>
          <dt>City</dt><dd>${escapeHtml(agent.islandId)}</dd>
          <dt>cwd</dt><dd class="mono">${escapeHtml(agent.cwd)}</dd>
          ${placementNote ? `<dt>Placement</dt><dd>${escapeHtml(placementNote)}</dd>` : ""}
          <dt>Role</dt><dd>${escapeHtml(agent.role)}</dd>
          <dt>Status</dt><dd>${isLive ? "live" : "dormant"}</dd>
          <dt>Started</dt><dd>${relativeTime(agent.startedAt)}</dd>
          <dt>Last active</dt><dd>${relativeTime(agent.lastActive)}</dd>
          <dt>Messages</dt><dd>${agent.messageCount}</dd>
          <dt>Tokens</dt><dd>${tokens}</dd>
          <dt>Model</dt><dd>${escapeHtml(agent.model ?? "unknown")}</dd>
        </dl>
        <h3>Outcome</h3>
        <div id="panel-outcome-host"></div>
        <h3>Top touched files</h3>
        <ul class="file-list">
          ${
            topFiles.length
              ? topFiles.map((f) => `<li>${escapeHtml(f.name)} <span>${f.weight}</span></li>`).join("")
              : "<li>none recorded</li>"
          }
        </ul>
        ${panelActionsHtml(
          isLive,
          { reactivate: opts.pending?.("reactivate", agent.id) ?? null, editor: opts.pending?.("editor", agent.id) ?? null },
          opts.outcome?.(agent.id) ?? null,
        )}
      `;
      // Looked up on every use: a live update re-renders the panel, and a request that outlasts it
      // must write its outcome into the nodes on screen then, for this agent only.
      const here = (id: string): HTMLElement | null => (content.dataset.agentId === agent.id ? document.getElementById(id) : null);
      const button = (id: string): HTMLButtonElement | null => {
        const b = here(id);
        return b instanceof HTMLButtonElement ? b : null;
      };
      const ui = (id: string) => ({ status: () => here("reactivate-status"), button: () => button(id) });
      button("reactivate-btn")?.addEventListener("click", () => opts.onAction?.("reactivate", agent.id, ui("reactivate-btn")));
      document.getElementById("room-btn")?.addEventListener("click", () => opts.onVisitRoom?.(agent.id));
      document.getElementById("focus-btn")?.addEventListener("click", () => opts.onFocus?.(agent.id));
      button("editor-btn")?.addEventListener("click", () => opts.onAction?.("editor", agent.id, ui("editor-btn")));
      // The headline chip is immediate (the compact map is already in memory); PR links, artifact
      // links and the ending reason need the full record, fetched only when there is a known
      // verdict worth detailing (an "unknown"/uncomputed session has none to fetch).
      const known = outcomeOf(agent.id);
      here("panel-outcome-host")?.appendChild(buildOutcomeSection(known, null));
      if (known) {
        void getJson<unknown>(`/api/outcomes/${encodeURIComponent(agent.id)}`).then((res) => {
          const host = here("panel-outcome-host");
          if (host && isOutcomeRecord(res)) host.replaceChildren(buildOutcomeSection(known, res));
        });
      }
      open();
    },

    showJev(jev, askSlotArg) {
      delete content.dataset.agentId;
      // Re-renders on every live decision; keep the Ask widget (and its results) mounted.
      const askSlot = askSlotArg ?? rememberedAskSlot;
      rememberedAskSlot = askSlot;
      content.innerHTML = `
        <h2>Jev, the moon</h2>
        <div id="ask-slot"></div>
        <dl>
          <dt>Status</dt><dd><span class="dot ${jev.status}"></span>${jev.status}</dd>
          <dt>Last tick</dt><dd>${jev.lastTickAt ? relativeTime(jev.lastTickAt) : "never"}</dd>
        </dl>
        <h3>Recent decisions</h3>
        <ul class="decision-list">
          ${jev.decisions
            .slice(0, 12)
            .map(
              (d) => `
            <li>
              <div class="decision-summary">${escapeHtml(d.summary)}</div>
              <div class="decision-meta">${escapeHtml(d.source)} · ${Math.round(d.confidence * 100)}% · ${relativeTime(d.at)}</div>
              <div class="decision-bars">
                ${Object.entries(d.probabilities)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 4)
                  .map(
                    ([k, v]) => `
                  <div class="bar-row">
                    <span title="${escapeHtml(k)}">${escapeHtml(k)}</span>
                    <div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div>
                  </div>`,
                  )
                  .join("")}
              </div>
            </li>`,
            )
            .join("")}
        </ul>
      `;
      if (askSlot) document.getElementById("ask-slot")?.replaceWith(askSlot);
      open(true);
    },

    showObject(obj) {
      delete content.dataset.agentId;
      content.innerHTML = `
        <h2>${escapeHtml(obj.name)}</h2>
        <dl>
          <dt>Kind</dt><dd>${escapeHtml(obj.kind)}</dd>
          <dt>City</dt><dd>${escapeHtml(obj.islandId)}</dd>
          <dt>Usage</dt><dd>${obj.usage}</dd>
          <dt>Growth</dt><dd>${Math.round(obj.growth * 100)}%</dd>
        </dl>
      `;
      open();
    },

    showCity(island, liveCount, objectCount) {
      delete content.dataset.agentId;
      const isHarness = island.id === "harness";
      content.innerHTML = `
        <h2>${escapeHtml(isHarness ? "Harness City" : displayIslandName(island))}</h2>
        <dl>
          ${isHarness ? "" : `<dt>Path</dt><dd class="mono">${escapeHtml(island.path)}</dd>`}
          <dt>Agents</dt><dd>${island.agentCount}</dd>
          <dt>Live now</dt><dd>${liveCount}</dd>
          <dt>${isHarness ? "Skills, hooks, MCPs" : "Files"}</dt><dd>${objectCount}</dd>
          ${isHarness ? "" : `<dt>Last active</dt><dd>${relativeTime(island.lastActive)}</dd>`}
        </dl>
      `;
      open();
    },

    showCustom(title, body) {
      delete content.dataset.agentId;
      content.innerHTML = `<h2>${escapeHtml(title)}</h2>`;
      content.appendChild(body);
      open(true);
    },

    hide() {
      setOpen(false);
    },

    isOpen: () => !panel.hidden,
  };
}
