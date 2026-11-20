import { describe, expect, it } from "vitest";
import type { ProjectPage } from "../../../shared/features/project-page";
import { groupOf, VIEW_GROUPS } from "../shell/groups";
import { brainNoteRoute, cardFacts, isProjectCardsResponse, matchWords, redactPage, resumeOffer, verdictText } from "./project-lib";

const NOW = Date.parse("2026-10-27T12:00:00Z");

function page(o: Partial<ProjectPage> = {}): ProjectPage {
  return {
    key: "agent-world",
    name: "agent-world",
    libraryId: "agent-world",
    cities: [{ id: "agent-world", name: "agent-world" }],
    stage: "building",
    stageReason: "a commit 2 days ago",
    category: "side",
    desc: "Alef",
    deploy: null,
    liveUrl: null,
    git: { remote: "sboghossian/agent-world", branch: "main", lastCommit: "2026-10-26T00:00:00Z", commits: 900 },
    path: "/Users/me/Documents/Code/agent-world",
    activityAt: "2026-10-27T10:00:00Z",
    sessions: [
      { id: "s1aaaaaa", title: "Ship PR 10", status: "dormant", lastActive: "2026-10-27T10:00:00Z", awaitingInput: false, outcome: "shipped", openTodos: 2 },
      { id: "s2bbbbbb", title: "Old work", status: "dormant", lastActive: "2026-10-20T10:00:00Z", awaitingInput: false, outcome: null, openTodos: 0 },
    ],
    sessionsTotal: 14,
    live: 0,
    todos: { open: 2, items: [{ sessionId: "s1aaaaaa", content: "write tests", status: "in_progress" }] },
    verdicts: [{ sessionId: "s1aaaaaa", title: "Ship PR 10", outcome: "shipped", reason: "sboghossian/agent-world#113 merged", at: "2026-10-27T10:00:00Z" }],
    spendUsd30d: 41.6,
    vault: { slug: "agent-world", path: "20-Projects/agent-world/_index.md", title: "project-agent-world (Alef)", status: "active", umbrella: "side-projects", summary: "Alef is the app name.", matchedBy: "code_path" },
    resume: { sessionId: "s1aaaaaa", title: "Ship PR 10", status: "dormant" },
    ...o,
  };
}

describe("card facts", () => {
  it("says the sessions, the newest verdict, open todos, spend and the last session", () => {
    expect(cardFacts(page(), NOW)).toEqual({
      sessions: "14 sessions",
      verdict: "🎓 shipped · sboghossian/agent-world#113 merged",
      todos: "2 open todos",
      spend: "$42 in 30 days",
      last: "last session today",
    });
  });

  it("leads with live sessions, and says nothing it doesn't know", () => {
    const f = cardFacts(page({ live: 1, verdicts: [], todos: { open: 0, items: [] }, spendUsd30d: null }), NOW);
    expect(f).toMatchObject({ sessions: "1 live · 14 sessions", verdict: null, todos: null, spend: null });
    expect(cardFacts(page({ sessions: [], sessionsTotal: 0 }), NOW)).toMatchObject({ sessions: "no sessions yet", last: null });
  });

  it("verdictText names a verdict with or without its reason", () => {
    expect(verdictText({ outcome: "failed", reason: null })).toBe("✗ failed");
    expect(verdictText({ outcome: "delivered", reason: "pushed" })).toBe("📦 delivered · pushed");
  });
});

describe("resume", () => {
  it("a dormant session is resumed (claude --resume); a live one opens its Room instead", () => {
    expect(resumeOffer(page())).toMatchObject({ kind: "resume", sessionId: "s1aaaaaa", label: "Resume" });
    expect(resumeOffer(page({ resume: { sessionId: "s9", title: "Running", status: "live" } }))).toMatchObject({ kind: "open", sessionId: "s9", label: "Open live session" });
    expect(resumeOffer(page({ resume: null }))).toBeNull();
  });
});

describe("links", () => {
  it("a vault note opens in Brain, never straight in Obsidian", () => {
    expect(brainNoteRoute("20-Projects/x/_index.md")).toEqual({ view: "brain", param: "20-Projects/x/_index.md" });
    expect(matchWords("alias")).toBe("matched by a brain_taxonomy alias");
    expect(matchWords(null)).toBe("opened by its vault slug");
  });

  it("the Project page lights Library in the Work group, with no button of its own", () => {
    expect(groupOf("project", VIEW_GROUPS)?.id).toBe("work");
    expect(VIEW_GROUPS.find((g) => g.id === "work")?.inside?.project).toBe("library");
  });
});

describe("redaction and validation", () => {
  it("?redact=1 swaps every name and free text, and keeps the counts", () => {
    const r = redactPage(page(), 2);
    expect(r).toMatchObject({ name: "project 2", desc: null, path: null, sessionsTotal: 14, spendUsd30d: 41.6, todos: { open: 2 } });
    expect(JSON.stringify(r)).not.toMatch(/Ship PR|Alef|write tests|sboghossian|agent-world#/);
    expect(r.git).toMatchObject({ remote: null, branch: null, commits: 900 });
  });

  it("accepts a cards answer and refuses a malformed one", () => {
    expect(isProjectCardsResponse({ ok: true, cards: [page()] })).toBe(true);
    expect(isProjectCardsResponse({ ok: true, cards: [] })).toBe(true);
    expect(isProjectCardsResponse({ ok: true, cards: [{ key: "x" }] })).toBe(false);
    expect(isProjectCardsResponse({ ok: false, error: "x" })).toBe(false);
    expect(isProjectCardsResponse(null)).toBe(false);
  });
});
