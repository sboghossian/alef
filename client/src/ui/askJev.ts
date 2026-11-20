import type { RecallResult, RecallWebHit } from "../../../shared/features/recall";
import { isJevTrips, jevTripsLine } from "../../../shared/features/webtrips";
import type { WebSearchResult } from "../../../shared/features/websearch";
import type { AskJevResult, WorldAgent } from "../../../shared/types";
import { askJev, getJson, recall, recallOpen, webSearch } from "../api";
import { escapeHtml, relativeTime } from "./fuzzy";
import { agentTitle } from "../../../shared/display";

export interface AskJevWidget {
  /** Persistent element; the Jev panel mounts it at the top. */
  el: HTMLElement;
  ask(question: string): Promise<void>;
  focus(): void;
}

export interface AskJevDeps {
  agent(id: string): WorldAgent | undefined;
  onPick(agentId: string): void;
  onThinking(on: boolean): void;
  /** Fires once per ask(), after both sections have rendered (fire-and-forget — e.g.
   *  the "voice" feature uses this to speak the answer back for a voice-originated
   *  question; a typed/palette question is silent, that feature decides which). */
  onAnswered?(question: string, res: AskJevResult): void;
}

/** Question box -> POST /api/ask-jev -> up to 3 agents with probability bars, plus a
 *  second "From your notes" section from POST /api/recall (BM25 over Alex's
 *  private vault/memory corpus — see shared/features/recall.ts). Note content is
 *  never sent anywhere beyond this box: only the question text leaves the browser.
 *  A third "From the web" section is opt-in per question (a button): only a click
 *  sends the question to Firecrawl + Jev (shared/features/websearch.ts). Jev is the only
 *  one Alef sends onto the web, and every search is kept: "Jev found before" shows kept
 *  finds that match a new question (no web call), and the trips line counts them. */
export function createAskJev(deps: AskJevDeps): AskJevWidget {
  const el = document.createElement("section");
  el.className = "ask-jev";
  el.innerHTML = `
    <form class="ask-form">
      <label for="ask-input">Ask Jev who worked on something</label>
      <div class="ask-row">
        <input id="ask-input" type="text" maxlength="500" autocomplete="off" placeholder="who worked on the pricing page?" />
        <button type="submit" class="comic-btn small">Ask</button>
      </div>
    </form>
    <div class="ask-trips"></div>
    <div class="ask-result" aria-live="polite"></div>
    <div class="ask-notes" aria-live="polite"></div>
    <div class="ask-kept" aria-live="polite"></div>
    <div class="ask-web" aria-live="polite"></div>
  `;
  const form = el.querySelector("form");
  const input = el.querySelector("input");
  const result = el.querySelector<HTMLElement>(".ask-result");
  const notes = el.querySelector<HTMLElement>(".ask-notes");
  const web = el.querySelector<HTMLElement>(".ask-web");
  const kept = el.querySelector<HTMLElement>(".ask-kept");
  const trips = el.querySelector<HTMLElement>(".ask-trips");
  if (!form || !input || !result || !notes || !web || !kept || !trips) throw new Error("ask-jev widget failed to build");

  let seq = 0;

  function render(question: string, res: AskJevResult): void {
    if (!res.ok) {
      result!.innerHTML = `<div class="ask-error">Jev could not answer: ${escapeHtml(res.error ?? "unknown error")}</div>`;
      return;
    }
    const source =
      res.source === "jev"
        ? `<span class="source jev">Jev · ${Math.round(res.confidence * 100)}% sure</span>`
        : `<span class="source keyword">keyword match (Jev unavailable)</span>`;
    const rows = res.matches
      .slice(0, 3)
      .map((m) => {
        const a = deps.agent(m.agentId);
        const title = a ? agentTitle(a) : m.agentId;
        const meta = a ? `${a.islandId} · ${a.status} · ${relativeTime(a.lastActive)}` : "not in this world";
        return `<li><button type="button" class="ask-match" data-agent="${escapeHtml(m.agentId)}">
            <span class="ask-title">${escapeHtml(title)}</span>
            <span class="ask-meta">${escapeHtml(meta)}</span>
            <span class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, m.probability)) * 100)}%"></i></span>
            <span class="ask-pct">${Math.round(m.probability * 100)}%</span>
          </button></li>`;
      })
      .join("");
    result!.innerHTML = `
      <div class="ask-q">“${escapeHtml(question)}”</div>
      ${source}
      ${rows ? `<ul class="ask-list">${rows}</ul>` : `<div class="ask-empty">Jev says: nobody fits that.</div>`}
    `;
    result!.querySelectorAll<HTMLButtonElement>(".ask-match").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.agent;
        if (id) deps.onPick(id);
      });
    });
  }

  function renderNotes(res: RecallResult): void {
    if (!res.ok || res.hits.length === 0) {
      notes!.innerHTML = "";
      return;
    }
    const rows = res.hits
      .slice(0, 3)
      .map((h, i) => {
        const snippet = h.snippet.length > 160 ? `${h.snippet.slice(0, 159)}…` : h.snippet;
        return `<li>
          <button type="button" class="note-hit" data-path="${escapeHtml(h.path)}" data-idx="${i}">
            <span class="note-title">${escapeHtml(h.title)}</span>
            <span class="note-snippet">${escapeHtml(snippet)}</span>
            <span class="note-path">${escapeHtml(h.path)}</span>
          </button>
        </li>`;
      })
      .join("");
    notes!.innerHTML = `<h5>From your notes</h5><ul class="note-list">${rows}</ul>`;
    notes!.querySelectorAll<HTMLButtonElement>(".note-hit").forEach((btn) => {
      btn.addEventListener("click", () => {
        void onNoteClick(btn);
      });
    });
  }

  /** Jev's earlier web finds for this question (kept in data/jev-web.jsonl; no web call). Web
   *  text: escaped, and linked only when it is an http(s) URL. */
  function renderKept(hits: readonly RecallWebHit[]): void {
    const rows = hits
      .slice(0, 3)
      .map((h) => {
        const body = `<span class="note-title">${escapeHtml(h.title)}</span>
            <span class="note-snippet">Jev searched “${escapeHtml(h.question)}” ${escapeHtml(relativeTime(h.at))}</span>
            <span class="note-path">${escapeHtml(h.url)}</span>`;
        return /^https?:\/\//i.test(h.url)
          ? `<li><a class="note-hit" href="${escapeHtml(h.url)}" target="_blank" rel="noopener noreferrer">${body}</a></li>`
          : `<li><div class="note-hit">${body}</div></li>`;
      })
      .join("");
    kept!.innerHTML = rows ? `<h5>Jev found before</h5><ul class="note-list">${rows}</ul>` : "";
  }

  /** "Jev's trips: 7 since 29 Sep, each one kept", from GET /api/webtrips/jev (the kept log). */
  function loadTrips(): void {
    void getJson<unknown>("/api/webtrips/jev", 8000).then((res) => {
      if (typeof res !== "object" || res === null || !("jev" in res) || !isJevTrips(res.jev)) return;
      trips!.textContent = `🌙 ${jevTripsLine(res.jev, (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}`;
    });
  }

  function offerWeb(question: string): void {
    web!.innerHTML = `<button type="button" class="comic-btn small web-go">Search the web</button>`;
    web!.querySelector<HTMLButtonElement>(".web-go")?.addEventListener("click", () => {
      void searchWeb(question);
    });
  }

  async function searchWeb(question: string): Promise<void> {
    const mine = seq;
    web!.innerHTML = `<h5>From the web</h5><div class="ask-thinking">Searching, Jev is ranking<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
    const res = await webSearch(question);
    if (mine !== seq) return; // a newer question superseded this one
    renderWeb(res);
  }

  function renderWeb(res: WebSearchResult): void {
    if (!res.ok) {
      web!.innerHTML = `<h5>From the web</h5><div class="ask-error">Web search failed: ${escapeHtml(res.error ?? "unknown error")}</div>`;
      return;
    }
    const rows = res.hits
      .map((h) => {
        const pct = h.rank === null ? "unranked" : `${Math.round(h.rank * 100)}%`;
        return `<li>
          <a class="note-hit" href="${escapeHtml(h.url)}" target="_blank" rel="noopener noreferrer">
            <span class="note-title">${escapeHtml(h.title)}</span>
            <span class="note-snippet">${escapeHtml(h.snippet)}</span>
            <span class="note-path">${escapeHtml(pct)} · ${escapeHtml(h.url)}</span>
          </a>
        </li>`;
      })
      .join("");
    const warn = res.weak ? `<div class="ask-empty">Nothing here really answers it. Try rephrasing.</div>` : "";
    const keptLine =
      res.kept === true ? "Kept: Jev will remember what it found here." : res.kept === false ? "This search could not be kept." : "";
    web!.innerHTML = `<h5>From the web</h5>${warn}${rows ? `<ul class="note-list">${rows}</ul>` : ""}<div class="ask-kept-note">${escapeHtml(keptLine)}</div>`;
    if (res.kept === true) loadTrips();
  }

  // Click: try to open the note in VS Code (server only allows this when the path is
  // inside a known agent's cwd); otherwise fall back to copying the path, since a
  // memory/vault path is usually outside any project the world knows about.
  async function onNoteClick(btn: HTMLButtonElement): Promise<void> {
    const path = btn.dataset.path;
    if (!path) return;
    const pathEl = btn.querySelector<HTMLElement>(".note-path");
    const original = pathEl?.textContent ?? path;
    const res = await recallOpen(path);
    if (res.ok) {
      if (pathEl) pathEl.textContent = "Opened in VS Code";
    } else {
      try {
        await navigator.clipboard.writeText(path);
        if (pathEl) pathEl.textContent = "Copied path";
      } catch {
        if (pathEl) pathEl.textContent = original; // clipboard unavailable — path was already visible
      }
    }
    if (pathEl) setTimeout(() => (pathEl.textContent = original), 2000);
  }

  async function ask(question: string): Promise<void> {
    const q = question.trim();
    input!.value = q;
    if (!q) {
      input!.focus();
      return;
    }
    const mine = ++seq;
    result!.innerHTML = `<div class="ask-thinking">Jev is thinking<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>`;
    notes!.innerHTML = "";
    kept!.innerHTML = "";
    web!.innerHTML = "";
    deps.onThinking(true);
    const [res, notesRes] = await Promise.all([askJev({ question: q }), recall(q)]);
    if (mine !== seq) return; // a newer question superseded this one
    deps.onThinking(false);
    render(q, res);
    renderNotes(notesRes);
    renderKept(notesRes.web ?? []);
    offerWeb(q);
    loadTrips();
    deps.onAnswered?.(q, res);
  }

  loadTrips();
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void ask(input.value);
  });

  return {
    el,
    ask,
    focus() {
      input.focus();
    },
  };
}
