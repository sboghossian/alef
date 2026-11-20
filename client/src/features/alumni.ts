// "alumni" (agent-city piece 6): the 🎓 Hall panel. Four read-only sections — Engineering bay
// (shipped/delivered sessions by repo), Research library, Emeriti (retired workers, from
// GET /api/careers) and Alumni (legacy cards for retired sessions, GET /api/alumni) — with
// week/month/all-time range chips. Every field here ultimately came from a transcript, a vault
// note or an API error line: untrusted text, rendered with textContent only (`h`).
//
// Panel id "alumni" is fixed: campus-landmarks opens the Hall by it.

import "./alumni.css";
import { ALUMNI_PANEL_ID, ALUMNI_RANGES, DEFAULT_ALUMNI_RANGE, emeritiOf, parseAlumniResponse, type AlumniRange, type AlumniResponse, type EngineeringRepo, type HallSession, type LegacyCard } from "../../../shared/features/alumni";
import { parseCareersResponse, type CareerWorker } from "../../../shared/features/careers";
import type { OutcomePr } from "../../../shared/features/outcomes";
import { relativeTime } from "../ui/fuzzy";
import { obsidianUrl } from "../views/brain-lib";
import { h } from "./fleet-overlay";
import { outcomeChip } from "./outcomes";
import type { ClientContext, ClientFeature, ClientPanel } from "./registry";

const PANEL_ID = ALUMNI_PANEL_ID;

const RANGE_LABEL: Record<AlumniRange, string> = { week: "Week", month: "Month", all: "All time" };

interface Host {
  el: HTMLElement;
  ctx: ClientContext;
}

let host: Host | null = null;
let range: AlumniRange = DEFAULT_ALUMNI_RANGE;
let data: AlumniResponse | null = null;
/** null = careers data unavailable (hide the section); [] = loaded, none retired. */
let emeriti: CareerWorker[] | null = null;
let loadToken = 0;

function link(text: string, url: string): HTMLElement | Text {
  if (!url.startsWith("https://")) return document.createTextNode(text);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

function linksRow(prs: readonly OutcomePr[], artifacts: readonly string[], vaultNote?: string | null): HTMLElement | null {
  if (prs.length === 0 && artifacts.length === 0 && !vaultNote) return null;
  const p = h("p", "al-links");
  for (const pr of prs) p.append(link(`${pr.repo}#${pr.number}${pr.state === "MERGED" ? " ✓" : ""}`, pr.url), document.createTextNode(" "));
  artifacts.forEach((url, i) => p.append(link(artifacts.length > 1 ? `artifact ${i + 1}` : "artifact", url), document.createTextNode(" ")));
  if (vaultNote) p.append(link("vault note", obsidianUrl(vaultNote)));
  return p;
}

function hallRow(s: HallSession, ctx: ClientContext): HTMLElement {
  const li = h("li", "al-row");
  const top = h("div", "al-row-top");
  const onPlanet = ctx.store.agents.has(s.sessionId);
  const name = onPlanet ? h("button", "al-name-btn", s.name) : h("span", "al-name", s.name);
  if (name instanceof HTMLButtonElement) {
    name.type = "button";
    name.title = "Fly there";
    name.addEventListener("click", () => ctx.flyTo(s.sessionId));
  }
  top.append(name);
  const chip = outcomeChip(s.outcome);
  if (chip) {
    const c = h("span", "al-chip", `${chip.emoji} ${chip.label}`);
    top.append(c);
  }
  li.append(top);
  if (s.reason) li.append(h("p", "al-reason", s.reason));
  li.append(h("p", "al-meta", `last active ${relativeTime(s.lastActive)}`));
  const links = linksRow(s.prs, s.artifacts);
  if (links) li.append(links);
  return li;
}

function cardRow(c: LegacyCard): HTMLElement {
  const li = h("li", "al-row al-card");
  const top = h("div", "al-row-top");
  top.append(h("span", "al-name", c.name));
  if (c.city) top.append(h("span", "al-city", c.city));
  const chip = outcomeChip(c.outcome);
  if (chip) top.append(h("span", "al-chip", `${chip.emoji} ${chip.label}`));
  li.append(top);
  if (c.reason) li.append(h("p", "al-reason", c.reason));
  const meta = [`retired ${relativeTime(c.retiredAt)}`, c.costUsd !== null ? `est. $${c.costUsd.toFixed(2)}` : null, c.tripwireLessons.length > 0 ? `tripped ${c.tripwireLessons.length} known lesson${c.tripwireLessons.length === 1 ? "" : "s"}` : null].filter((x): x is string => x !== null);
  li.append(h("p", "al-meta", meta.join(" · ")));
  const links = linksRow(c.prs, c.artifacts, c.vaultNote);
  if (links) li.append(links);
  return li;
}

function emeritusRow(w: CareerWorker): HTMLElement {
  const li = h("li", "al-row");
  const top = h("div", "al-row-top");
  top.append(h("span", "al-name", w.name ?? w.key));
  li.append(top, h("p", "al-meta", `${w.lifetime.total} run${w.lifetime.total === 1 ? "" : "s"} lifetime in ${w.department} · ${w.reason}`));
  return li;
}

function engineeringSection(bay: readonly EngineeringRepo[], ctx: ClientContext): HTMLElement | null {
  if (bay.length === 0) return null;
  const section = h("section", "al-section");
  section.append(h("h3", "al-h", `🛠 Engineering bay (${bay.reduce((n, r) => n + r.sessions.length, 0)})`));
  for (const repo of bay) {
    section.append(h("h4", "al-repo-h", `${repo.repo} (${repo.sessions.length})`));
    const ul = h("ul", "al-list");
    for (const s of repo.sessions) ul.append(hallRow(s, ctx));
    section.append(ul);
  }
  return section;
}

function researchSection(sessions: readonly HallSession[], ctx: ClientContext): HTMLElement | null {
  if (sessions.length === 0) return null;
  const section = h("section", "al-section");
  section.append(h("h3", "al-h", `📚 Research library (${sessions.length})`));
  const ul = h("ul", "al-list");
  for (const s of sessions) ul.append(hallRow(s, ctx));
  section.append(ul);
  return section;
}

function emeritiSection(workers: readonly CareerWorker[] | null): HTMLElement | null {
  if (workers === null || workers.length === 0) return null;
  const section = h("section", "al-section");
  section.append(h("h3", "al-h", `🏛 Emeriti (${workers.length})`));
  const ul = h("ul", "al-list");
  for (const w of workers) ul.append(emeritusRow(w));
  section.append(ul);
  return section;
}

function alumniSection(cards: readonly LegacyCard[]): HTMLElement {
  const section = h("section", "al-section");
  section.append(h("h3", "al-h", `🎓 Alumni (${cards.length})`));
  if (cards.length === 0) {
    section.append(h("p", "al-none", "No session has been retired in this range."));
    return section;
  }
  const ul = h("ul", "al-list");
  for (const c of cards) ul.append(cardRow(c));
  section.append(ul);
  return section;
}

function rangeChips(): HTMLElement {
  const wrap = h("div", "al-ranges");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Range");
  for (const r of ALUMNI_RANGES) {
    const btn = h("button", `al-range-btn${r === range ? " al-range-active" : ""}`, RANGE_LABEL[r]);
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(r === range));
    btn.addEventListener("click", () => {
      if (r === range) return;
      range = r;
      void load();
    });
    wrap.append(btn);
  }
  return wrap;
}

function draw(): void {
  const hst = host;
  if (!hst || !data) return;
  const d = data;
  const wrap = h("div", "al-panel");
  wrap.append(rangeChips());
  const sections = [engineeringSection(d.engineeringBay, hst.ctx), researchSection(d.researchLibrary, hst.ctx), emeritiSection(emeriti), alumniSection(d.cards)].filter((s): s is HTMLElement => s !== null);
  if (sections.length === 0) wrap.append(h("p", "al-none", "Nothing to show yet in this range."));
  wrap.append(...sections);
  hst.el.replaceChildren(wrap);
}

async function load(): Promise<void> {
  const hst = host;
  if (!hst) return;
  const token = ++loadToken;
  hst.el.replaceChildren(h("p", "al-sub", "Loading the Hall…"));
  const [rawAlumni, rawCareers] = await Promise.all([hst.ctx.api.getJson<unknown>(`/api/alumni?range=${range}`, 15_000), hst.ctx.api.getJson<unknown>("/api/careers", 15_000)]);
  if (host !== hst || token !== loadToken) return; // reopened, or the range changed again, while this was in flight
  const parsedAlumni = parseAlumniResponse(rawAlumni);
  if (!parsedAlumni) {
    hst.el.replaceChildren(h("p", "al-sub", "Couldn't load the Hall from the world server."));
    return;
  }
  data = parsedAlumni;
  emeriti = emeritiOf(parseCareersResponse(rawCareers));
  draw();
}

function renderPanel(el: HTMLElement, ctx: ClientContext): void {
  host = { el, ctx };
  data = null;
  emeriti = null;
  void load();
}

const hallPanel: ClientPanel = { id: PANEL_ID, title: "🎓 Hall", render: renderPanel };

export const alumniFeature: ClientFeature = {
  id: "alumni",
  paletteCommands: (ctx) => [{ id: "open", title: "Hall…", kind: "panel", keywords: ["hall", "alumni", "graduates", "retired", "legacy"], run: () => ctx.openPanel(PANEL_ID) }],
  hudButtons: [{ id: "open", label: "🎓", title: "Hall: shipped work, research, retired workers and legacy cards", text: "Hall", placement: "menu", onClick: (ctx) => ctx.openPanel(PANEL_ID) }],
  panels: [hallPanel],
};
