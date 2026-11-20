// 🩺 Health: a local score and checklist of "is my Alef setup whole and healthy" (round 10,
// P3), plus the "Start an agent" guided auto-setup card (council decision, prompt/dispatch
// box → "Add a guided auto-setup flow") and a first-run welcome banner. Two tabs: Checklist
// (this file) and Tidy up (P2's `renderCleanup`, mounted here through a guarded dynamic
// import since P2 may or may not have landed yet in this tree). The Fix queue (fix-queue.ts) sits
// at the top of the Checklist tab, and every issue gets "Draft a fix" (ui/draft-fix.ts).

import { displayIslandName } from "../../../shared/display";
import { healthFixPrompt } from "../../../shared/features/fixes";
import { renderCleanup } from "../features/cleanup";
import { setQualityTier } from "../features/game-feel/quality";
import {
  APPROVALS_INSTALL_LABEL,
  checkLine,
  computeScore,
  scoreTone,
  SNOOZE_DAYS,
  type ApprovalsHookInstallPlan,
  type ApprovalsHookInstallResult,
  type CheckDismissalsResponse,
  type CompletenessCheck,
  type CompletenessResponse,
  type DismissalKind,
  type HostLoad,
} from "../../../shared/features/completeness";
import { currentMedianFps } from "../features/completeness";
import { sceneParts } from "../scene/scene-bus";
import type { AlefView, ViewContext } from "../shell/views";
import { runAction } from "../ui/action";
import { draftFixButtonHtml, draftFixFromQueue } from "../ui/draft-fix";
import { escapeHtml } from "../ui/fuzzy";
import { viewHeader } from "../ui/view-header";
import { folderName, launchNeedsYou, launchSuccessText, trustRelaunchAction } from "../ui/launch-result";
import type { TrustBulkResult, TrustGrantResult, TrustTarget, TrustTargetsResponse } from "../../../shared/features/trust";
import {
  buildFpsCheck,
  bulkTrustFailureText,
  bulkTrustSuccessText,
  confidenceBadge,
  defaultStartAgentCity,
  dismissalText,
  FIX_STEPS,
  groupChecks,
  isFirstRun,
  issueCounts,
  issuesCaption,
  issuesList,
  presetTemplate,
  PRESETS,
  testsResultMessage,
  TESTS_RUN_TIMEOUT_MS,
  TESTS_RUNNING_LABEL,
  trustAllLabel,
  welcomeMessage,
  WELCOME_SEEN_KEY,
  WHY_IT_MATTERS,
  type PresetId,
  type TestsRunResultLike,
} from "./health-lib";
import { mountFixQueue, type FixQueueHandle } from "./fix-queue";
import "./health.css";

const POLL_MS = 30_000;

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
let checks: CompletenessCheck[] = [];
let activeTab: "checklist" | "tidy" = "checklist";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tidyCleanup: (() => void) | null = null;
let tidyMounted = false;
let selectedPreset: PresetId = PRESETS[0]!.id;
let lastAppliedTemplate = "";
let launching = false;
/** Health's "Launch targets Claude hasn't trusted" list (GET /api/trust/targets). */
let trustTargets: TrustTarget[] = [];
let fixQueue: FixQueueHandle | null = null;

/** Every untrusted district folder by name and path, then ONE "Trust these N folders" button for
 *  exactly that list (POST /api/trust/bulk), plus a Trust button per folder. */
function trustListHtml(): string {
  if (trustTargets.length === 0) return "";
  const rows = trustTargets
    .map(
      (t) => `<li class="hv-trust-row"><b class="hv-trust-name">${escapeHtml(folderName(t.cwd))}</b><code class="hv-trust-cwd" title="${escapeHtml(t.cwd)}">${escapeHtml(t.cwd)}</code>
        <button type="button" class="hv-trust" data-cwd="${escapeHtml(t.cwd)}">Trust</button></li>`,
    )
    .join("");
  return `<ul class="hv-trust-list" aria-label="Launch targets Claude hasn't trusted">${rows}</ul>
    <div class="hv-trust-bulk"><button type="button" class="hv-trust-all">${escapeHtml(trustAllLabel(trustTargets.length))}</button>
    <span class="hv-trust-bulk-note">The folders listed above, one by one: only each folder's trust key in ~/.claude.json changes.</span></div>`;
}

function stateDot(state: CompletenessCheck["state"]): string {
  return { pass: "●", warn: "▲", fail: "✕", unknown: "?" }[state];
}

/** Per-check "Snooze 7 days" / "Won't fix" on a failing or warning check, or, once set aside, what
 *  it is and Undo (POST /api/completeness/:id/dismiss and /undismiss). Nothing for pass/unknown. */
function dismissControls(c: CompletenessCheck): string {
  const id = escapeHtml(c.id);
  if (c.dismissed) {
    return `<div class="hv-dismiss-row"><span class="hv-dismissed-note">${escapeHtml(dismissalText(c.dismissed))}</span>
      <button type="button" class="hv-undismiss" data-check="${id}">Undo</button></div>`;
  }
  if (c.state !== "fail" && c.state !== "warn") return "";
  return `<div class="hv-dismiss-row">
    <button type="button" class="hv-dismiss" data-check="${id}" data-kind="snooze" title="Unpin it from the Town square and the Inbox for ${SNOOZE_DAYS} days">Snooze ${SNOOZE_DAYS} days</button>
    <button type="button" class="hv-dismiss" data-check="${id}" data-kind="wont-fix" title="Unpin it until you undo this here">Won't fix</button>
  </div>`;
}

function checkRow(c: CompletenessCheck): string {
  const fixBtn = c.fixLabel && !c.dismissed ? `<button type="button" class="hv-fix" data-check="${escapeHtml(c.id)}">${escapeHtml(c.fixLabel)}</button>` : "";
  const why = c.why ? `<button type="button" class="hv-why" data-check="${escapeHtml(c.id)}">Why?</button><p class="hv-why-text" hidden>${escapeHtml(c.why)}</p>` : "";
  return `<li class="hv-check hv-${c.state}${c.dismissed ? " hv-dismissed" : ""}">
    <span class="hv-dot" aria-hidden="true">${stateDot(c.state)}</span>
    <div class="hv-check-body">
      <div class="hv-check-line">${escapeHtml(checkLine(c))}</div>
      ${why}
      ${c.dismissed ? dismissControls(c) : ""}
      ${c.id === "trust-targets" ? trustListHtml() : ""}
    </div>
    ${fixBtn}
  </li>`;
}

/** One row in the Issues list: what's wrong (label+detail, already real values), why it
 *  matters (a static architectural consequence), a confidence badge, and the fix — the same
 *  one-click button as the grouped checklist below when one exists (reusing `hv-fix`/
 *  `data-check` so the existing click handler fires it), else the exact manual steps.
 *  Nothing here auto-fixes anything new: it only surfaces what `handleFix` already does. */
function issueRow(c: CompletenessCheck): string {
  const why = WHY_IT_MATTERS[c.id];
  const steps = FIX_STEPS[c.id];
  const fix = c.fixLabel
    ? `<button type="button" class="hv-fix hv-issue-fix" data-check="${escapeHtml(c.id)}">${escapeHtml(c.fixLabel)}</button>`
    : steps
      ? `<ol class="hv-issue-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
      : `<p class="hv-issue-nofix">No fix to offer yet — nothing here is safe to automate.</p>`;
  if (c.dismissed) {
    return `<li class="hv-issue hv-${c.state} hv-dismissed">
    <span class="hv-dot" aria-hidden="true">${stateDot(c.state)}</span>
    <div class="hv-issue-body">
      <div class="hv-check-line">${escapeHtml(checkLine(c))}</div>
      ${dismissControls(c)}
    </div>
  </li>`;
  }
  return `<li class="hv-issue hv-${c.state}">
    <span class="hv-dot" aria-hidden="true">${stateDot(c.state)}</span>
    <div class="hv-issue-body">
      <div class="hv-check-line">${escapeHtml(checkLine(c))}</div>
      ${why ? `<p class="hv-issue-why"><b>Why it matters:</b> ${escapeHtml(why)}</p>` : ""}
      ${c.why ? `<p class="hv-issue-evidence"><b>Evidence:</b> ${escapeHtml(c.why)}</p>` : ""}
      <span class="hv-confidence">${confidenceBadge(c)}</span>
      <div class="hv-issue-fixwrap">${c.id === "trust-targets" && trustTargets.length ? trustListHtml() : fix}</div>
      ${c.id === "fps" ? "" : `<div class="hv-draft-row">${draftFixButtonHtml({ check: c.id })}</div>`}
      ${dismissControls(c)}
    </div>
  </li>`;
}

function renderChecklist(): void {
  const host = root?.querySelector<HTMLElement>(".hv-checklist");
  if (!host) return;
  const score = computeScore(checks);
  const tone = scoreTone(score);
  const counts = issueCounts(checks);
  const groups = groupChecks(checks);
  const issues = issuesList(checks);
  host.innerHTML = `
    <div class="hv-ring-row">
      <div class="hv-ring hv-ring-${tone}" style="--pct:${score}">
        <div class="hv-ring-hole"><span class="hv-ring-pct">${score}%</span></div>
      </div>
      <div class="hv-ring-caption">${escapeHtml(issuesCaption(counts))}</div>
    </div>
    <section class="hv-issues-section">
      <h3 class="hv-group-h">Issues${counts.toFix ? ` <span class="hv-issues-count" title="To fix: the same number as the ring">${counts.toFix}</span>` : ""}</h3>
      ${issues.length ? `<ul class="hv-issues-list">${issues.map(issueRow).join("")}</ul>` : `<p class="hv-issues-empty">Nothing failing, warning or unmeasured right now.</p>`}
    </section>
    ${groups
      .map(
        (g) => `<section class="hv-group">
          <h3 class="hv-group-h">${escapeHtml(g.label)}</h3>
          <ul class="hv-group-list">${g.checks.map(checkRow).join("")}</ul>
        </section>`,
      )
      .join("")}
  `;
}

async function fetchAndRender(): Promise<void> {
  if (!ctx) return;
  const [res, targets, health] = await Promise.all([
    ctx.api.getJson<CompletenessResponse>("/api/completeness"),
    ctx.api.getJson<TrustTargetsResponse>("/api/trust/targets"),
    ctx.api.getJson<{ ok: boolean; host?: HostLoad }>("/api/health"),
  ]);
  trustTargets = targets?.ok ? targets.untrusted : [];
  const server = res?.ok ? res.checks : [];
  checks = [...server, buildFpsCheck(currentMedianFps(), sceneParts().webgl, health?.host ?? null)];
  // An open install preview is being read: the 30 s poll must not wipe it (Install/Cancel re-render).
  if (root?.querySelector(".hv-install")) return;
  renderChecklist();
  void fixQueue?.refresh();
}

// ── fix actions ───────────────────────────────────────────────────────────

async function copyCommand(cmd: string, btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(cmd);
    btn.textContent = "Copied!";
  } catch {
    ctx?.toast(`Copy this: ${cmd}`, "info");
  }
  setTimeout(() => {
    btn.textContent = original;
  }, 1500);
}

function lowerQuality(): void {
  setQualityTier(2);
  ctx?.toast("Quality lowered.");
}

async function handleFix(check: CompletenessCheck, btn: HTMLButtonElement): Promise<void> {
  const c = ctx;
  if (!c) return;
  switch (check.id) {
    case "tests": {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = TESTS_RUNNING_LABEL;
      const result = await c.api.postJson<TestsRunResultLike>("/api/completeness/tests/run", {}, (error) => ({ ok: false, error }), TESTS_RUN_TIMEOUT_MS);
      btn.disabled = false;
      btn.textContent = label;
      c.toast(testsResultMessage(result), result.ok ? "info" : "error");
      await fetchAndRender();
      return;
    }
    case "approvals-hook": {
      if (check.state === "fail" || check.fixLabel === APPROVALS_INSTALL_LABEL) {
        await previewApprovalsInstall(c, btn);
        return;
      }
      const result = await c.api.postJson<{ ok: boolean; message: string }>(`/api/completeness/approvals-hook/fix`, {}, (error) => ({ ok: false, message: error }));
      c.toast(result.message, result.ok ? "info" : "error");
      await fetchAndRender();
      return;
    }
    case "tmux":
      await copyCommand("brew install tmux", btn);
      return;
    case "terminal-pty":
      await copyCommand("npm_config_build_from_source=true npm rebuild node-pty", btn);
      return;
    case "routines":
      c.showView("routines"); // Setup › Routines (UX-9)
      return;
    case "indexes":
      btn.disabled = true;
      await c.api.getJson("/api/brain/search?q=a");
      btn.disabled = false;
      c.toast("Warming the brain index…");
      return;
    case "tidy":
    case "dead-tmux":
      setTab("tidy");
      return;
    case "fps":
      lowerQuality();
      return;
    default:
      return;
  }
}

// ── approvals hook: Install (preview diff) → Install ──────────────────────

function diffHtml(plan: ApprovalsHookInstallPlan): string {
  const lines = plan.diff.map((l) => `<span class="hv-diff-${l.kind === "+" ? "add" : l.kind === "-" ? "del" : "ctx"}">${escapeHtml(`${l.kind} ${l.text}`)}</span>`).join("\n");
  return `<div class="hv-install" role="group" aria-label="Approvals hook install preview">
    <p class="hv-install-note">${escapeHtml(plan.message)} <code>${escapeHtml(plan.settingsPath)}</code></p>
    ${plan.diff.length ? `<pre class="hv-diff">${lines}</pre>` : ""}
    ${plan.status === "ready" ? `<div class="hv-install-actions"><button type="button" class="hv-install-confirm">Install</button><button type="button" class="hv-install-cancel">Cancel</button></div>` : `<div class="hv-install-actions"><button type="button" class="hv-install-cancel">Close</button></div>`}
  </div>`;
}

/** Step one: GET the diff (writes nothing) and show it under the button. */
async function previewApprovalsInstall(c: ViewContext, btn: HTMLButtonElement): Promise<void> {
  const host = btn.parentElement;
  if (!host) return;
  btn.disabled = true;
  const plan = await c.api.getJson<ApprovalsHookInstallPlan>("/api/completeness/approvals-hook/install");
  btn.disabled = false;
  if (!plan) {
    c.toast("Couldn't read the install preview.", "error");
    return;
  }
  host.querySelector(".hv-install")?.remove();
  btn.insertAdjacentHTML("afterend", diffHtml(plan));
}

/** Step two, only on the Install click: POST with confirm (the server re-plans, backs up, writes). */
async function confirmApprovalsInstall(c: ViewContext, btn: HTMLButtonElement): Promise<void> {
  await runAction<ApprovalsHookInstallResult>({
    label: "Install the approvals hook",
    run: () => c.api.postJson<ApprovalsHookInstallResult>("/api/completeness/approvals-hook/install", { confirm: true }, (error) => ({ ok: false, status: "error", message: error, backupPath: null, error })),
    success: (r) => r.message,
    toast: c.toast,
    button: btn,
  });
  root?.querySelectorAll(".hv-install").forEach((el) => el.remove());
  await fetchAndRender();
}

// ── Snooze 7 days / Won't fix / Undo ──────────────────────────────────────

async function setDismissal(c: ViewContext, id: string, kind: DismissalKind | null, btn: HTMLButtonElement): Promise<void> {
  const label = kind === "snooze" ? `Snooze ${SNOOZE_DAYS} days` : kind === "wont-fix" ? "Won't fix" : "Undo";
  await runAction<CheckDismissalsResponse>({
    label,
    run: () =>
      c.api.postJson<CheckDismissalsResponse>(
        `/api/completeness/${encodeURIComponent(id)}/${kind ? "dismiss" : "undismiss"}`,
        kind ? { kind, days: SNOOZE_DAYS } : {},
        (error) => ({ ok: false, dismissals: {}, error }),
      ),
    success: () => (kind === "snooze" ? `Snoozed for ${SNOOZE_DAYS} days: unpinned from the Town square and the Inbox.` : kind === "wont-fix" ? "Marked won't fix: unpinned until you undo it here." : "Back on the list."),
    toast: c.toast,
    button: btn,
  });
  await fetchAndRender();
}

/** Trust one launch target: POST /api/trust, which writes only projects[<folder>].hasTrustDialogAccepted
 *  in ~/.claude.json (server/features/trust-lib.ts), then re-reads the checklist. */
async function trustFolder(c: ViewContext, cwd: string, btn: HTMLButtonElement): Promise<void> {
  const folder = folderName(cwd);
  await runAction<TrustGrantResult>({
    label: `Trust ${folder}`,
    run: () => c.api.postJson<TrustGrantResult>("/api/trust", { cwd }, (error) => ({ ok: false, error })),
    success: (r) => (r.alreadyTrusted ? `Claude already trusted ${folder}.` : `Trusted ${folder}: launches there start without the trust dialog.`),
    toast: c.toast,
    button: btn,
  });
  await fetchAndRender();
}

/** "Trust these N folders": POST /api/trust/bulk with exactly the folders on screen. The server
 *  refuses any path not in its own current list and reports each folder's outcome. */
async function trustAll(c: ViewContext, btn: HTMLButtonElement): Promise<void> {
  const paths = trustTargets.map((t) => t.cwd);
  if (paths.length === 0) return;
  await runAction<TrustBulkResult>({
    label: trustAllLabel(paths.length),
    run: () => c.api.postJson<TrustBulkResult>("/api/trust/bulk", { paths, confirm: true }, (error) => ({ ok: false, results: [], trusted: 0, already: 0, refused: 0, error })),
    success: bulkTrustSuccessText,
    failure: bulkTrustFailureText,
    toast: c.toast,
    button: btn,
  });
  await fetchAndRender();
}

function onChecklistClick(ev: Event): void {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;
  const whyBtn = target.closest<HTMLButtonElement>(".hv-why");
  if (whyBtn) {
    const text = whyBtn.nextElementSibling;
    if (text instanceof HTMLElement) text.hidden = !text.hidden;
    return;
  }
  const trustAllBtn = target.closest<HTMLButtonElement>(".hv-trust-all");
  if (trustAllBtn && ctx && !trustAllBtn.disabled) {
    void trustAll(ctx, trustAllBtn);
    return;
  }
  const trustBtn = target.closest<HTMLButtonElement>(".hv-trust");
  if (trustBtn?.dataset.cwd && ctx && !trustBtn.disabled) {
    void trustFolder(ctx, trustBtn.dataset.cwd, trustBtn);
    return;
  }
  const installBtn = target.closest<HTMLButtonElement>(".hv-install-confirm");
  if (installBtn && ctx && !installBtn.disabled) {
    void confirmApprovalsInstall(ctx, installBtn);
    return;
  }
  const cancelBtn = target.closest<HTMLButtonElement>(".hv-install-cancel");
  if (cancelBtn) {
    cancelBtn.closest(".hv-install")?.remove();
    renderChecklist();
    return;
  }
  const draftBtn = target.closest<HTMLButtonElement>(".fx-draft");
  if (draftBtn?.dataset.check && ctx && !draftBtn.disabled) {
    const c = checks.find((x) => x.id === draftBtn.dataset.check);
    // Health checks are Alef's own setup: the queue's health:<id> row knows Alef's own district.
    if (c) void draftFixFromQueue(ctx, `health:${c.id}`, { prompt: healthFixPrompt(c), fixId: `health:${c.id}` }, draftBtn);
    return;
  }
  const dismissBtn = target.closest<HTMLButtonElement>(".hv-dismiss, .hv-undismiss");
  if (dismissBtn?.dataset.check && ctx && !dismissBtn.disabled) {
    const kind = dismissBtn.dataset.kind === "snooze" || dismissBtn.dataset.kind === "wont-fix" ? dismissBtn.dataset.kind : null;
    void setDismissal(ctx, dismissBtn.dataset.check, kind, dismissBtn);
    return;
  }
  const fixBtn = target.closest<HTMLButtonElement>(".hv-fix");
  if (fixBtn) {
    const id = fixBtn.dataset.check;
    const check = checks.find((c) => c.id === id);
    if (check) void handleFix(check, fixBtn);
  }
}

// ── "Start an agent" (guided auto-setup) ────────────────────────────────

function cityOptions(c: ViewContext): { id: string; name: string; path: string; agentCount: number; lastActive: string }[] {
  return [...c.store.islands.values()]
    .filter((i) => i.id !== "harness")
    .map((i) => ({ id: i.id, name: i.name, path: i.path, agentCount: i.agentCount, lastActive: i.lastActive }));
}

function renderStartAgent(host: HTMLElement, c: ViewContext): void {
  const cities = cityOptions(c);
  const defaultCity = defaultStartAgentCity(cities) ?? cities[0]?.id ?? "";
  host.innerHTML = `
    <h3 class="hv-start-h">🚀 Start an agent</h3>
    <p class="hv-start-sub">Pick a city and a preset, edit the prompt if you like, then Launch. This uses the same dispatch Alef already has — nothing runs until you click.</p>
    ${
      cities.length === 0
        ? `<p class="hv-start-empty">No project cities yet — run <code>claude</code> in a project directory first.</p>`
        : `<label class="hv-start-city-row">City
        <select class="hv-start-city">${cities.map((city) => `<option value="${escapeHtml(city.id)}" ${city.id === defaultCity ? "selected" : ""}>${escapeHtml(displayIslandName(city))}</option>`).join("")}</select>
      </label>
      <div class="hv-presets ch-seg" role="group" aria-label="Preset">
        ${PRESETS.map((p) => `<button type="button" class="hv-preset" data-preset="${p.id}" aria-pressed="${p.id === selectedPreset}">${escapeHtml(p.label)}</button>`).join("")}
      </div>
      <textarea class="hv-start-text" rows="4" aria-label="Prompt"></textarea>
      <div class="hv-start-actions">
        <button type="button" class="hv-launch">Launch</button>
        <span class="hv-start-status" role="status"></span>
      </div>`
    }
  `;
  if (cities.length === 0) return;

  const citySelect = host.querySelector<HTMLSelectElement>(".hv-start-city")!;
  const textarea = host.querySelector<HTMLTextAreaElement>(".hv-start-text")!;
  const launchBtn = host.querySelector<HTMLButtonElement>(".hv-launch")!;
  const statusEl = host.querySelector<HTMLElement>(".hv-start-status")!;

  const cityName = (): string => {
    const found = cities.find((city) => city.id === citySelect.value);
    return found ? displayIslandName(found) : citySelect.value;
  };
  const applyTemplate = (): void => {
    lastAppliedTemplate = presetTemplate(selectedPreset, cityName());
    textarea.value = lastAppliedTemplate;
  };
  applyTemplate();

  host.querySelectorAll<HTMLButtonElement>(".hv-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedPreset = (btn.dataset.preset ?? PRESETS[0]!.id) as PresetId;
      host.querySelectorAll(".hv-preset").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      applyTemplate();
      textarea.focus();
    });
  });

  citySelect.addEventListener("change", () => {
    // Only refill if the user hasn't diverged from the template we last set — never clobber
    // an edit they made on purpose.
    if (textarea.value === lastAppliedTemplate) applyTemplate();
  });

  launchBtn.addEventListener("click", () => {
    // runAction disables the button while the request runs; `launching` also covers a re-render.
    if (launching) return;
    launching = true;
    statusEl.className = "hv-start-status";
    const city = cityName();
    void runAction({
      label: "Launch",
      pending: "Starting it in tmux…",
      run: () => c.api.dispatch({ islandId: citySelect.value, prompt: textarea.value }),
      success: (r) => launchSuccessText(r, `Started in ${city}`),
      successKind: (r) => (launchNeedsYou(r) ? "error" : "info"),
      action: (r) => trustRelaunchAction(c.api, c.toast, r),
      toast: c.toast,
      status: statusEl,
      button: launchBtn,
    }).then((res) => {
      launching = false;
      statusEl.className = `hv-start-status ${res.ok ? "hv-ok" : "hv-err"}`;
    });
  });
}

// ── first-run welcome ────────────────────────────────────────────────────

function renderWelcome(host: HTMLElement, c: ViewContext): void {
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(WELCOME_SEEN_KEY);
  } catch {
    return;
  }
  if (!isFirstRun(seen)) return;
  const agents = c.store.agents;
  const cities = [...c.store.islands.values()].filter((i) => i.id !== "harness").length;
  const live = [...agents.values()].filter((a) => a.status === "live").length;
  host.innerHTML = `<p>${escapeHtml(welcomeMessage(cities, agents.size, live))}</p>`;
  host.hidden = false;
  try {
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
  } catch {
    // private window / blocked storage: the banner still showed this once, that's enough
  }
}

// ── Tidy tab: P2's renderCleanup, guarded (P2 may not have landed yet) ─────

function mountTidy(host: HTMLElement, c: ViewContext): void {
  if (tidyMounted) return;
  tidyMounted = true;
  tidyCleanup = renderCleanup(host, c);
}

function setTab(tab: "checklist" | "tidy"): void {
  activeTab = tab;
  if (!root) return;
  root.querySelectorAll<HTMLElement>(".hv-tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", String(on));
  });
  root.querySelectorAll<HTMLElement>(".hv-panel").forEach((p) => {
    p.hidden = p.dataset.panel !== tab;
  });
  if (tab === "tidy" && ctx) {
    const host = root.querySelector<HTMLElement>("#hv-tidy-host");
    if (host) mountTidy(host, ctx);
  }
}

export const healthView: AlefView = {
  id: "health",
  emoji: "🩺",
  name: "Health",
  hint: "Alef's own setup — score, checklist and tidy up",
  usesPlanet: false,
  mount(r, c) {
    ctx = c;
    root = r;
    checks = [];
    tidyMounted = false;
    tidyCleanup = null;
    r.innerHTML = `<div class="health-view">
      ${viewHeader(
        "Health",
        "Alef's own setup: score, checklist and tidy up",
        `<div class="hv-tabs ch-seg" role="tablist">
          <button type="button" class="hv-tab" data-tab="checklist" role="tab" aria-selected="true">Checklist</button>
          <button type="button" class="hv-tab" data-tab="tidy" role="tab" aria-selected="false">Tidy up</button>
        </div>`,
        { icon: "health", className: "hv-head" },
      )}
      <div class="hv-welcome" hidden></div>
      <div class="hv-panel" data-panel="checklist">
        <section class="hv-fixq"></section>
        <section class="hv-start"></section>
        <div class="hv-checklist"></div>
      </div>
      <div class="hv-panel" data-panel="tidy" hidden><div id="hv-tidy-host"></div></div>
    </div>`;

    renderWelcome(r.querySelector<HTMLElement>(".hv-welcome")!, c);
    renderStartAgent(r.querySelector<HTMLElement>(".hv-start")!, c);
    fixQueue = mountFixQueue(r.querySelector<HTMLElement>(".hv-fixq")!, c);
    r.querySelector<HTMLElement>(".hv-checklist")?.addEventListener("click", onChecklistClick);
    r.querySelector<HTMLElement>(".hv-tabs")?.addEventListener("click", (ev) => {
      const btn = ev.target instanceof HTMLElement ? ev.target.closest<HTMLButtonElement>(".hv-tab") : null;
      if (btn?.dataset.tab === "checklist" || btn?.dataset.tab === "tidy") setTab(btn.dataset.tab);
    });

    void fetchAndRender();
    pollTimer = setInterval(() => void fetchAndRender(), POLL_MS);

    const route = c.route();
    if (route.param === "start") {
      setTab("checklist");
      r.querySelector<HTMLElement>(".hv-start")?.scrollIntoView({ block: "start" });
      r.querySelector<HTMLTextAreaElement>(".hv-start-text")?.focus();
    }
  },
  unmount() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    tidyCleanup?.();
    tidyCleanup = null;
    fixQueue?.destroy();
    fixQueue = null;
    ctx = null;
    root = null;
  },
  onParam(param) {
    if (param === "start" && root) {
      setTab("checklist");
      root.querySelector<HTMLElement>(".hv-start")?.scrollIntoView({ block: "start" });
      root.querySelector<HTMLTextAreaElement>(".hv-start-text")?.focus();
    }
  },
};
