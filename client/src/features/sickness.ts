// "sickness" (the Clinic): minions get sick, and now you can see it. The server's detectors
// (server/features/sickness.ts) record leaked keys, broken builds and steering pages per session;
// this feature shows them in four places, all observe-only until you click:
//   - the agent panel: one chip per case ("sick: broken build - npm test, since 14:05");
//   - a status-bar chip "🩺 N sick", shown only while some case is sick;
//   - the Clinic panel (that chip, or the palette's "Clinic"): cases grouped by lineage, then kind,
//     with first/last seen, occurrences, sessions and source, plus the vault count and the one
//     computed insurance line. Per sick case, two buttons:
//       "Doctor: draft a fix"  prefills the prompt box (fillDispatchBox) with a code-written note;
//                              nothing is sent, Alex presses Dispatch;
//       "Mark treated"         POST /api/sickness/:id/treated, labelled 📣 reported by you;
//   - the Feed: one "system" item per new sick case or heal seen after page load, none for history;
//   - the planet (vision wave 4): clinicView() / onClinicChange() feed the 🏥 Clinic building in the
//     System Quarter and the marks on sick houses (system-places.ts), from the snapshot's
//     "sickness.open" until the full list lands, then from the live list (SickAgents).
// Cases come from GET /api/sickness (on every snapshot, i.e. boot and reconnect, and when the
// Clinic opens) and the "cases" WS pushes. Every string from a case is rendered with textContent.

import "./sickness.css";
import { agentTitle } from "../../../shared/display";
import {
  SICKNESS_OPEN_KEY,
  parseSicknessCases,
  parseSicknessInsurance,
  parseSicknessResponse,
  parseSicknessTreatResult,
  parseSicknessVault,
  type SicknessCase,
  type SicknessInsuranceResponse,
  type SicknessResponse,
  type SicknessState,
  type SicknessTreatResult,
  type SicknessVaultResponse,
} from "../../../shared/features/sickness";
import { log } from "../log";
import { runAction, type ActionResultLike } from "../ui/action";
import { fillDispatchBox } from "../ui/dispatch";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import {
  casesForAgent,
  caseMetaLine,
  chipText,
  clinicCounts,
  clinicEvents,
  clinicToday,
  clinicFeedItem,
  countsLine,
  doctorPrompt,
  FEED_SLACK_MS,
  groupCases,
  insuranceLine,
  isSickCase,
  KIND_NAME,
  kindGroupLine,
  mergeCases,
  relatedCases,
  REPORTED_BY_YOU,
  scanLine,
  SickAgents,
  STATE_NAME,
  statusChipText,
  timeLabel,
  VAULT_CALL,
  vaultLine,
  vaultNote,
  type ClinicView,
  type LineageGroup,
} from "./sickness-lib";

const PANEL_ID = "clinic";
const SLOT = "fx-sickness";
const CHIP_ID = "hud-f-sickness-chip";
const AGENT_MAX = 4;
const VAULT_TIMEOUT_MS = 90_000;

const pageLoadAt = Date.now();
let cases = new Map<string, SicknessCase>();
let lastResponse: SicknessResponse | null = null;
/** Case states seen this page load; null until the first full list seeds it (see clinicEvents). */
let seen: Map<string, SicknessState> | null = null;
let chipEl: HTMLElement | null = null;
let panelEl: HTMLElement | null = null;
let vault: SicknessVaultResponse | null = null;
let vaultFailed = false;
let insurance: SicknessInsuranceResponse | null = null;
let historyOpen = false;
/** Cases with a request in flight: their buttons stay disabled across re-renders. */
const busy = new Set<string>();
/** The last outcome line per case, so a re-render (every WS push) keeps showing it. */
const outcomes = new Map<string, { text: string; error: boolean }>();
/** The row elements on screen now, for runAction's getters. */
let rows = new Map<string, { status: HTMLElement; doctor?: HTMLButtonElement; treat?: HTMLButtonElement }>();
/** Sick sessions for the planet (the Clinic building and the house marks). */
const sickAgents = new SickAgents();
const clinicListeners = new Set<() => void>();

/** What the planet shows about sickness now. Computed on every call, never a cached copy. */
export function clinicView(nowMs = Date.now()): ClinicView {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  return {
    counts: lastResponse ? clinicCounts(cases.values()) : null,
    sick: sickAgents.entries,
    source: sickAgents.source,
    today: lastResponse ? clinicToday(cases.values(), midnight.getTime()) : null,
  };
}

/** Called after every change clinicView() can see (a snapshot, a full list, a push). */
export function onClinicChange(fn: () => void): () => void {
  clinicListeners.add(fn);
  return () => {
    clinicListeners.delete(fn);
  };
}

function clinicChanged(): void {
  for (const fn of clinicListeners) {
    try {
      fn();
    } catch (err) {
      log.warn("sickness", "a clinic listener threw", String(err));
    }
  }
}

function titleOf(ctx: ClientContext, sessionId: string): string | undefined {
  const a = ctx.store.agents.get(sessionId);
  return a ? agentTitle(a) || undefined : undefined;
}

// ── State in ─────────────────────────────────────────────────────────────────────────────────

/** A full list (GET) replaces what we hold and seeds / diffs the Feed; a WS push merges. A push
 *  that lands before the first full list is merged but never fires (the list decides history). */
function ingest(ctx: ClientContext, incoming: readonly SicknessCase[], full: boolean): void {
  cases = mergeCases(cases, incoming, full);
  if (full || seen !== null) {
    const r = clinicEvents(seen, incoming, pageLoadAt - FEED_SLACK_MS);
    seen = r.seen;
    if (r.events.length > 0) ctx.feed.push(r.events.map((e) => clinicFeedItem(e, titleOf(ctx, e.c.sessionId))));
  }
  sickAgents.cases(cases.values(), full);
  clinicChanged(); // the counts move with every list and push, even while the marks wait for a full list
  repaint(ctx);
}

let refreshing: Promise<void> | null = null;
function refresh(ctx: ClientContext): Promise<void> {
  refreshing ??= (async () => {
    const parsed = parseSicknessResponse(await ctx.api.getJson<unknown>("/api/sickness"));
    if (parsed) {
      lastResponse = parsed;
      ingest(ctx, parsed.cases, true);
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function loadExtras(ctx: ClientContext): Promise<void> {
  const [v, i] = await Promise.all([ctx.api.getJson<unknown>("/api/sickness/vault", VAULT_TIMEOUT_MS), ctx.api.getJson<unknown>("/api/sickness/insurance")]);
  vault = parseSicknessVault(v) ?? vault;
  vaultFailed = vault === null;
  insurance = parseSicknessInsurance(i) ?? insurance;
  repaint(ctx);
}

// ── Paint ────────────────────────────────────────────────────────────────────────────────────

function repaint(ctx: ClientContext): void {
  const counts = clinicCounts(cases.values());
  chipEl ??= document.getElementById(CHIP_ID);
  if (chipEl) {
    const text = statusChipText(counts);
    chipEl.hidden = text === null;
    if (text) chipEl.textContent = text;
  }
  refreshAgentPanel(SLOT, renderAgentSlot);
  if (panelEl?.isConnected) renderClinic(panelEl, ctx);
}

function renderAgentSlot(agentId: string, slot: HTMLElement): void {
  slot.replaceChildren();
  const mine = casesForAgent(cases.values(), agentId);
  if (mine.length === 0) return;
  const now = Date.now();
  for (const c of mine.slice(0, AGENT_MAX)) {
    const chip = h("div", `sk-chip sk-${c.state}`, chipText(c, now));
    chip.title = `${c.label}\n${caseMetaLine(c, now)}`;
    slot.append(chip);
  }
  if (mine.length > AGENT_MAX) slot.append(h("div", "sk-more", `+${mine.length - AGENT_MAX} more in the Clinic (search "Clinic")`));
}

function statusOf(id: string): HTMLElement | null {
  return rows.get(id)?.status ?? null;
}

function setBusy(b: HTMLButtonElement | undefined, on: boolean): void {
  if (!b) return;
  b.disabled = on;
  if (on) b.setAttribute("aria-busy", "true");
}

function doctor(ctx: ClientContext, c: SicknessCase): void {
  if (busy.has(c.id)) return;
  busy.add(c.id);
  void runAction<ActionResultLike & { city?: string | null }>({
    label: "Doctor",
    pending: "Writing the doctor's note…",
    run: async () => {
      const cur = cases.get(c.id) ?? c; // the row may be older than the latest push
      const prompt = doctorPrompt(cur, relatedCases(cur, cases.values()));
      fillDispatchBox({ prompt, cityId: ctx.store.agents.get(cur.sessionId)?.islandId ?? null });
      const box = document.getElementById("dispatch-text");
      if (!(box instanceof HTMLTextAreaElement) || box.value !== prompt) return { ok: false, error: "the prompt box isn't on screen (press H to bring the panels back)" };
      const sel = document.getElementById("dispatch-city");
      const city = sel instanceof HTMLSelectElement ? (sel.selectedOptions[0]?.textContent ?? sel.value) : null;
      return { ok: true, city };
    },
    success: (r) => `The doctor's note is in the prompt box${r.city ? ` (city: ${r.city})` : ""}. Nothing was sent: read it, then press Dispatch.`,
    toast: ctx.toast,
    status: () => statusOf(c.id),
    button: () => rows.get(c.id)?.doctor ?? null,
    onOutcome: (text, error) => outcomes.set(c.id, { text, error }),
  }).finally(() => busy.delete(c.id));
}

function markTreated(ctx: ClientContext, c: SicknessCase): void {
  if (busy.has(c.id)) return;
  busy.add(c.id);
  void runAction<SicknessTreatResult>({
    label: "Mark treated",
    pending: "Recording your treatment…",
    run: async () => {
      const raw = await ctx.api.postJson<unknown>(`/api/sickness/${encodeURIComponent(c.id)}/treated`, {}, (error) => ({ ok: false, error }));
      const r = parseSicknessTreatResult(raw) ?? { ok: false, error: "the server's answer wasn't a treatment result" };
      if (r.ok && r.case) ingest(ctx, [r.case], false);
      return r;
    },
    success: (r) => (r.already ? "It was already marked treated." : `Marked treated (${REPORTED_BY_YOU}). Evidence newer than now reopens it.`),
    toast: ctx.toast,
    status: () => statusOf(c.id),
    button: () => rows.get(c.id)?.treat ?? null,
    onOutcome: (text, error) => outcomes.set(c.id, { text, error }),
  }).finally(() => busy.delete(c.id));
}

function caseRow(ctx: ClientContext, c: SicknessCase, now: number): HTMLElement {
  const li = h("li", `sk-case sk-${c.state}`);
  const head = h("div", "sk-case-head");
  head.append(h("span", `sk-state sk-${c.state}`, STATE_NAME[c.state]), h("span", "sk-label", c.label));
  li.append(head, h("div", "sk-meta", caseMetaLine(c, now)));
  const who = [titleOf(ctx, c.sessionId) ?? `session ${c.sessionId.slice(0, 8)} (not in the index)`, c.subagentId ? "via a subagent" : null, c.district].filter(Boolean).join(" · ");
  li.append(h("div", "sk-meta", who));
  if (c.treatment) {
    const reopened = isSickCase(c) ? " · reopened by newer evidence" : "";
    li.append(h("div", "sk-treated", `treated ${timeLabel(c.treatment.at, now)} · ${REPORTED_BY_YOU}${reopened}`));
  }
  const status = h("div", "sk-status");
  status.setAttribute("aria-live", "polite");
  const out = outcomes.get(c.id);
  if (out) {
    status.textContent = out.text;
    status.classList.toggle("error", out.error);
  }
  const row: { status: HTMLElement; doctor?: HTMLButtonElement; treat?: HTMLButtonElement } = { status };
  if (isSickCase(c)) {
    const actions = h("div", "sk-actions");
    const doc = h("button", "comic-btn small", "Doctor: draft a fix");
    doc.type = "button";
    doc.title = "Puts a fix prompt in the prompt box, written from this case. Nothing is sent: you press Dispatch.";
    doc.addEventListener("click", () => doctor(ctx, c));
    const treat = h("button", "comic-btn small secondary", "Mark treated");
    treat.type = "button";
    treat.title = "Records that you treated it (📣 reported by you: Alef can't see the fix). Newer evidence reopens it.";
    treat.addEventListener("click", () => markTreated(ctx, c));
    if (busy.has(c.id)) {
      setBusy(doc, true);
      setBusy(treat, true);
    }
    actions.append(doc, treat);
    li.append(actions);
    row.doctor = doc;
    row.treat = treat;
  }
  li.append(status);
  rows.set(c.id, row);
  return li;
}

function renderGroups(ctx: ClientContext, parent: HTMLElement, groups: LineageGroup[], now: number): void {
  for (const g of groups) {
    const box = h("div", "sk-lineage");
    box.append(h("h4", "sk-lineage-h", `${g.title} · ${g.cases} case${g.cases === 1 ? "" : "s"} · ${g.sessions} session${g.sessions === 1 ? "" : "s"}`));
    for (const k of g.kinds) {
      box.append(h("div", "sk-kind", kindGroupLine(k, now)));
      const list = h("ul", "sk-cases");
      list.setAttribute("aria-label", `${g.title}: ${KIND_NAME[k.kind]}`);
      for (const c of k.cases) list.append(caseRow(ctx, c, now));
      box.append(list);
    }
    parent.append(box);
  }
}

function renderClinic(el: HTMLElement, ctx: ClientContext): void {
  const now = Date.now();
  rows = new Map();
  const all = [...cases.values()];
  const counts = clinicCounts(all);
  const frag = document.createDocumentFragment();
  if (!lastResponse && all.length === 0) {
    frag.append(h("p", "sk-note", "Loading cases…"));
    el.replaceChildren(frag);
    return;
  }
  frag.append(h("p", "sk-counts", countsLine(counts)));
  if (lastResponse) {
    frag.append(h("p", "sk-note", scanLine(lastResponse.scan)));
    if (lastResponse.disabledKinds.length > 0) {
      frag.append(h("p", "sk-note", `Withheld: ${lastResponse.disabledKinds.map((k) => KIND_NAME[k]).join(", ")} (detected, but under 50% precision on a hand check, so not served).`));
    }
  }
  if (vault) {
    frag.append(h("p", "sk-vault", `${vaultLine(vault)} ${VAULT_CALL}`), h("p", "sk-note", vaultNote(vault, now)));
  } else {
    frag.append(h("p", "sk-note", vaultFailed ? "Vault count unavailable (the server didn't answer)." : "Counting vault notes…"));
  }
  if (insurance) frag.append(h("p", "sk-note", insuranceLine(insurance)));

  const sick = all.filter(isSickCase);
  frag.append(h("h3", "sk-section", `Sick now (${sick.length})`));
  if (sick.length === 0) frag.append(h("p", "sk-note", "No sick case."));
  else {
    const wrap = h("div", "sk-groups");
    renderGroups(ctx, wrap, groupCases(sick), now);
    frag.append(wrap);
  }
  const rest = all.filter((c) => !isSickCase(c));
  const details = h("details", "sk-history");
  details.open = historyOpen;
  const summary = h("summary", "sk-section", `History: treated and healed (${rest.length})`);
  details.append(summary);
  // Rows are built only while it is open: most cases are healed history, and a push re-renders.
  if (historyOpen) renderGroups(ctx, details, groupCases(rest), now);
  details.addEventListener("toggle", () => {
    if (historyOpen === details.open) return;
    historyOpen = details.open;
    details.replaceChildren(summary);
    if (historyOpen) renderGroups(ctx, details, groupCases([...cases.values()].filter((c) => !isSickCase(c))), Date.now());
  });
  frag.append(details);
  el.replaceChildren(frag);
}

// ── The feature ──────────────────────────────────────────────────────────────────────────────

export const sicknessFeature: ClientFeature = {
  id: "sickness",
  mount() {
    chipEl = document.getElementById(CHIP_ID);
    if (chipEl) chipEl.hidden = true;
    watchAgentPanel(SLOT, renderAgentSlot);
  },
  onSnapshot(world, ctx) {
    if (sickAgents.snapshot(world.extras?.[SICKNESS_OPEN_KEY])) clinicChanged();
    void refresh(ctx); // boot and every reconnect: the full list (pushes may have been missed)
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "cases") return;
    ingest(ctx, parseSicknessCases(p.cases), false);
  },
  paletteCommands(ctx) {
    return [
      {
        id: "clinic",
        title: "Clinic",
        meta: "Sick minions: leaked keys, broken builds; the Doctor drafts a fix",
        keywords: ["sick", "sickness", "doctor", "health", "leaked key", "broken build", "treated", "insurance", "vault keys"],
        run: () => ctx.openPanel(PANEL_ID),
      },
    ];
  },
  hudButtons: [
    {
      id: "chip",
      label: "🩺",
      title: "Clinic: sick cases (leaked keys, broken builds). Click for the list, the Doctor and Mark treated.",
      placement: "status",
      hidden: true,
      alert: "sick cases",
      onClick: (ctx) => ctx.openPanel(PANEL_ID),
    },
  ],
  panels: [
    {
      id: PANEL_ID,
      title: "Clinic",
      render(el, ctx) {
        panelEl = el;
        renderClinic(el, ctx);
        void refresh(ctx);
        void loadExtras(ctx);
      },
    },
  ],
};
