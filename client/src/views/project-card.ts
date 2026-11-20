// One project as a card (Home's "Pick up where you left off", capability #2) and the Resume
// button the Project page shares with it. Resume never invents a launch path: a dormant session
// goes through ui/agent-open.ts openAgentIn("reactivate"), the same claude --resume the palette's
// ⌘↵, the details panel and the Room use (it refuses a live session and a second click while one
// is opening, and toasts the outcome); a live one opens its Room instead. Untrusted text (names,
// titles, reasons) is set with textContent only.

import type { ProjectPage } from "../../../shared/features/project-page";
import { h } from "../features/fleet-overlay";
import type { ViewContext } from "../shell/views";
import { openAgentIn } from "../ui/agent-open";
import { brainNoteRoute, cardFacts, PROJECT_VIEW_ID, resumeOffer, type ResumeOffer } from "./project-lib";
import "./project.css";

/** Runs a Resume offer through the existing paths (see the header). */
export function runResume(ctx: Pick<ViewContext, "store" | "api" | "toast" | "showView">, offer: ResumeOffer, button?: HTMLButtonElement | null): void {
  if (!offer) return;
  if (offer.kind === "open") return ctx.showView("room", offer.sessionId);
  void openAgentIn({ agent: (id) => ctx.store.agents.get(id), reactivate: ctx.api.reactivate, openEditor: ctx.api.openEditor, toast: ctx.toast }, "reactivate", offer.sessionId, { button: button ?? null });
}

export function resumeButton(ctx: Pick<ViewContext, "store" | "api" | "toast" | "showView">, p: Pick<ProjectPage, "resume">, cls: string): HTMLButtonElement | null {
  const offer = resumeOffer(p);
  if (!offer) return null;
  const b = h("button", cls, offer.label);
  b.type = "button";
  b.title = offer.title;
  b.addEventListener("click", () => runResume(ctx, offer, b));
  return b;
}

/** A small action button. */
function act(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", "pc-act", label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/** Home's card: name (opens the page), sessions, the newest verdict, open todos, spend, and
 *  Resume · Vault note · Page. */
export function projectCard(ctx: ViewContext, p: ProjectPage, nowMs: number): HTMLElement {
  const f = cardFacts(p, nowMs);
  const card = h("article", "pc-card");
  const head = h("header", "pc-head");
  const name = h("button", "pc-name", p.name);
  name.type = "button";
  name.title = "Open this project's page";
  name.addEventListener("click", () => ctx.showView(PROJECT_VIEW_ID, p.key));
  head.append(name, h("span", "pc-sessions", f.sessions));
  card.append(head);
  card.append(h("p", `pc-verdict${f.verdict ? "" : " pc-none"}`, f.verdict ?? "No verdict yet"));
  const meta = [f.todos ?? "no open todos", f.spend, f.last].filter((x): x is string => x !== null);
  card.append(h("p", "pc-meta", meta.join(" · ")));
  const acts = h("div", "pc-acts");
  const resume = resumeButton(ctx, p, "pc-act pc-primary");
  if (resume) acts.append(resume);
  const vault = p.vault;
  if (vault) acts.append(act("Vault note", `Read ${vault.path} in Brain`, () => {
    const r = brainNoteRoute(vault.path);
    ctx.showView(r.view, r.param);
  }));
  acts.append(act("Page", "Sessions, todos, verdicts, spend and the vault note in one page", () => ctx.showView(PROJECT_VIEW_ID, p.key)));
  card.append(acts);
  return card;
}
