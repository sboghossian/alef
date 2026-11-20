import { describe, expect, it } from "vitest";
import {
  buildRouterJevBody,
  candidateId,
  classifyModelRules,
  clampWhy,
  createRateLimiter,
  isScoreAnswer,
  pickTools,
  summarizeRouteCards,
  toolCandidates,
  toolId,
  TOOL_RELEVANCE_FLOOR,
  parseRouterJevAnswers,
  pickNotes,
  pickDispatch,
  skillCandidates,
  QUESTION_BANK,
  ASK_FLOOR,
  MAX_ASK_OUT,
  MAX_SKILL_CANDIDATES,
  mergeCandidates,
  titleFromPath,
  graphWave,
  vaultRelative,
  MAX_WAVE,
  type GraphNode,
  type NoteCandidate,
} from "../features/router-lib.js";

/** The dispatch questions every batched call carries, whatever the candidates. */
const DISPATCH_KEYS = ["history", "web", "deliver", "size"];

describe("classifyModelRules", () => {
  it("picks haiku for a mechanical rename", () => {
    const r = classifyModelRules("rename all foo to bar");
    expect(r.model).toBe("haiku");
    expect(r.why).toContain("rename");
  });

  it("picks opus for architecture/security work", () => {
    const r = classifyModelRules("design the auth architecture");
    expect(r.model).toBe("opus");
  });

  it("picks sonnet for UI work with no strong signal", () => {
    const r = classifyModelRules("fix the button color");
    expect(r.model).toBe("sonnet");
  });

  it("defaults to sonnet on an empty or signal-free prompt", () => {
    expect(classifyModelRules("").model).toBe("sonnet");
    expect(classifyModelRules("please help me with this thing").model).toBe("sonnet");
  });

  it("is case-insensitive and matches whole words only (auth != author)", () => {
    expect(classifyModelRules("RENAME the variable").model).toBe("haiku");
    expect(classifyModelRules("credit the author of this quote").model).toBe("sonnet"); // "author" must not fire "auth"
    expect(classifyModelRules("review the auth flow").model).toBe("opus");
  });

  it("prefers haiku over opus when both kinds of keyword appear", () => {
    // narrow/mechanical trigger checked first, per router-lib.ts's documented ordering
    const r = classifyModelRules("rename the security module's files");
    expect(r.model).toBe("haiku");
  });

  it("picks fable for drafting and extraction work", () => {
    expect(classifyModelRules("draft the NDA for the the region engagement").model).toBe("fable");
    expect(classifyModelRules("write a blog post about MENA court rules").model).toBe("fable");
    expect(classifyModelRules("redline their term sheet").model).toBe("fable");
    expect(classifyModelRules("build the document extraction step").model).toBe("fable");
    expect(classifyModelRules("write a legal memo on tenancy").why).toContain("drafting/extraction");
  });

  it("keeps fable's triggers off engineering vocabulary", () => {
    // The two words most likely to drag ordinary code work onto the dearest writing tier,
    // which is why router-lib.ts leaves them out of FABLE_PHRASES on purpose.
    expect(classifyModelRules("update the wire contract in shared/types.ts").model).toBe("sonnet");
    expect(classifyModelRules("fix the WHERE clause in that query").model).toBe("sonnet");
    expect(classifyModelRules("what is on the agenda today").model).toBe("sonnet"); // "agenda" must not fire "nda"
  });

  it("prefers haiku over fable, and fable over opus, when triggers collide", () => {
    expect(classifyModelRules("find all the NDA templates").model).toBe("haiku");
    expect(classifyModelRules("redline the security architecture doc").model).toBe("fable");
  });
});

describe("buildRouterJevBody", () => {
  it("always asks the model question, and one score question per candidate", () => {
    const candidates: NoteCandidate[] = [
      { path: "/a.md", title: "Note A", bm25Score: 2 },
      { path: "/b.md", title: "Note B", bm25Score: 1 },
    ];
    const body = buildRouterJevBody("fix the button color", candidates) as {
      model: string;
      state: { prompt: string; notes?: Array<{ id: string; title: string }> };
      questions: Record<string, unknown>;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.questions.model).toBeDefined();
    expect(body.questions[candidateId(0)]).toBeDefined();
    expect(body.questions[candidateId(1)]).toBeDefined();
    expect(body.state.notes?.[0]?.title).toBe("Note A");
  });

  it("omits per-note questions and the notes state when there are no candidates", () => {
    const body = buildRouterJevBody("fix the button color", []) as {
      state: { notes?: unknown };
      questions: Record<string, unknown>;
    };
    expect(body.state.notes).toBeUndefined();
    expect(Object.keys(body.questions)).toEqual(["model", ...DISPATCH_KEYS]);
  });

  it("truncates a very long prompt before it enters the batched call", () => {
    const body = buildRouterJevBody("x".repeat(5000), []) as { state: { prompt: string } };
    expect(body.state.prompt.length).toBeLessThanOrEqual(800);
  });
});

describe("isScoreAnswer", () => {
  it("accepts a well-shaped score answer", () => {
    expect(isScoreAnswer({ score: 0.5, confidence: 0.9, probabilities: { relevant: 0.8 } })).toBe(true);
  });
  it("rejects malformed shapes", () => {
    expect(isScoreAnswer(null)).toBe(false);
    expect(isScoreAnswer({ score: 0.5 })).toBe(false);
    expect(isScoreAnswer({ score: "x", confidence: 1, probabilities: {} })).toBe(false);
  });
});

describe("parseRouterJevAnswers", () => {
  it("parses a full valid response (model + every note answered)", () => {
    const raw = {
      answers: {
        model: { choice: "opus", probabilities: { opus: 0.8, sonnet: 0.15, haiku: 0.05 }, confidence: 0.8 },
        note_0: { score: 0.9, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.85 },
      },
    };
    const parsed = parseRouterJevAnswers(raw, 1);
    expect(parsed.model).toBe("opus");
    expect(parsed.modelWhy).toContain("opus");
    expect(parsed.noteRelevance.get(0)?.relevantProb).toBeCloseTo(0.9);
  });

  it("drops one bad per-note answer without failing the whole parse", () => {
    const raw = {
      answers: {
        model: { choice: "sonnet", probabilities: { opus: 0.1, sonnet: 0.8, haiku: 0.1 }, confidence: 0.7 },
        note_0: { score: 0.9, probabilities: { "1": 0.9 }, confidence: 0.8 },
        note_1: { garbage: true },
      },
    };
    const parsed = parseRouterJevAnswers(raw, 2);
    expect(parsed.noteRelevance.has(0)).toBe(true);
    expect(parsed.noteRelevance.has(1)).toBe(false);
  });

  it("throws on a missing model answer", () => {
    expect(() => parseRouterJevAnswers({ answers: {} }, 0)).toThrow();
  });

  it("throws on an unknown model choice", () => {
    const raw = { answers: { model: { choice: "gpt5", probabilities: { gpt5: 1 }, confidence: 0.9 } } };
    expect(() => parseRouterJevAnswers(raw, 0)).toThrow();
  });

  it("throws on a non-object response or a missing answers field", () => {
    expect(() => parseRouterJevAnswers(null, 0)).toThrow();
    expect(() => parseRouterJevAnswers({}, 0)).toThrow();
  });
});

describe("pickNotes", () => {
  const candidates: NoteCandidate[] = [
    { path: "/low.md", title: "Low", bm25Score: 0.5 },
    { path: "/high.md", title: "High", bm25Score: 3 },
    { path: "/mid.md", title: "Mid", bm25Score: 1.5 },
  ];

  it("returns [] for no candidates", () => {
    expect(pickNotes([], null)).toEqual([]);
  });

  it("rules mode (relevance null): keeps BM25 order, up to the cap, no floor cutoff", () => {
    const notes = pickNotes(candidates, null);
    expect(notes.map((n) => n.path)).toEqual(["/high.md", "/mid.md", "/low.md"]);
    expect(notes[0]?.why).toContain("BM25 match");
  });

  it("Jev mode: ranks by relevance probability, not BM25 order", () => {
    const relevance = new Map([
      [0, { relevantProb: 0.9, confidence: 0.8 }], // "Low" BM25-wise, most relevant to Jev
      [1, { relevantProb: 0.2, confidence: 0.8 }],
      [2, { relevantProb: 0.6, confidence: 0.8 }],
    ]);
    const notes = pickNotes(candidates, relevance);
    expect(notes[0]?.path).toBe("/low.md");
    expect(notes[0]?.why).toContain("Jev: relevant");
  });

  it("stops padding past 2 notes once relevance drops below the floor", () => {
    const relevance = new Map([
      [0, { relevantProb: 0.9, confidence: 0.8 }],
      [1, { relevantProb: 0.8, confidence: 0.8 }],
      [2, { relevantProb: 0.1, confidence: 0.8 }], // below NOTE_RELEVANCE_FLOOR
    ]);
    const notes = pickNotes(candidates, relevance);
    expect(notes.length).toBe(2);
  });

  it("ranks a candidate Jev didn't answer for below every scored one", () => {
    const relevance = new Map([[1, { relevantProb: 0.05, confidence: 0.5 }]]); // only "High" was answered
    const notes = pickNotes(candidates, relevance);
    expect(notes[0]?.path).toBe("/high.md"); // the only real signal wins even though its prob is low
  });

  it("never returns more than MAX_NOTES_OUT (4) even with many strong candidates", () => {
    const many: NoteCandidate[] = Array.from({ length: 10 }, (_, i) => ({ path: `/n${i}.md`, title: `N${i}`, bm25Score: 10 - i }));
    const relevance = new Map(many.map((_, i) => [i, { relevantProb: 0.9, confidence: 0.9 }]));
    expect(pickNotes(many, relevance).length).toBe(4);
  });
});

describe("clampWhy", () => {
  it("caps at 200 chars", () => {
    expect(clampWhy("x".repeat(500)).length).toBe(200);
  });
});

describe("createRateLimiter", () => {
  it("allows up to max per window, then refuses until the window rolls over", () => {
    let t = 0;
    const limiter = createRateLimiter(2, 1000, () => t);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    t = 1000; // window rolls over
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("treats 0 max as always-refused", () => {
    const limiter = createRateLimiter(0, 1000, () => 0);
    expect(limiter.tryAcquire()).toBe(false);
  });
});

describe("summarizeRouteCards", () => {
  const NOON = Date.parse("2026-10-26T12:00:00");
  const line = (o: Record<string, unknown>) => JSON.stringify({ ts: "2026-10-26T11:00:00.000Z", session: "s", cwd: "/x", confidence: 80, tools: [], ...o });

  it("counts decisions per tier, today, and the newest timestamp", () => {
    const text = [
      line({ model: "opus", source: "jev" }),
      line({ model: "haiku", source: "jev" }),
      line({ model: "haiku", source: "rules" }),
      line({ ts: "2026-10-20T09:00:00.000Z", model: "sonnet", source: "jev" }),
      line({ ts: "2026-10-26T11:30:00.000Z", model: "fable", source: "jev" }),
    ].join("\n");
    const r = summarizeRouteCards(text, NOON);
    expect(r.total).toBe(5);
    expect(r.byTier).toEqual({ opus: 1, fable: 1, sonnet: 1, haiku: 2 });
    expect(r.rules).toBe(1);
    expect(r.down).toBe(0);
    expect(r.lastAt).toBe("2026-10-26T11:30:00.000Z");
  });

  it("counts a null model as a prompt the hook could not route", () => {
    const r = summarizeRouteCards([line({ model: null, source: "down" }), line({ model: "opus", source: "jev" })].join("\n"), NOON);
    expect(r.down).toBe(1);
    expect(r.byTier.opus).toBe(1);
    expect(r.total).toBe(2);
  });

  it("reports every tier, including ones never picked", () => {
    const r = summarizeRouteCards(line({ model: "opus", source: "jev" }), NOON);
    // The Fable-shaped bug is only visible because a zero is reported rather than omitted.
    expect(Object.keys(r.byTier).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
    expect(r.byTier.fable).toBe(0);
  });

  it("skips a malformed or half-written line instead of failing", () => {
    const r = summarizeRouteCards([line({ model: "opus", source: "jev" }), '{"ts":"2026-10-26T11:0', "", "   ", "null"].join("\n"), NOON);
    expect(r.total).toBe(1);
    expect(r.byTier.opus).toBe(1);
  });

  it("is empty but valid for an empty log", () => {
    const r = summarizeRouteCards("", NOON);
    expect(r.total).toBe(0);
    expect(r.today).toBe(0);
    expect(r.lastAt).toBeNull();
    expect(r.byTier.opus).toBe(0);
  });

  it("only counts today's lines as today", () => {
    const old = Array.from({ length: 3 }, () => line({ ts: "2026-09-01T10:00:00.000Z", model: "sonnet", source: "jev" }));
    const r = summarizeRouteCards([...old, line({ model: "opus", source: "jev" })].join("\n"), NOON);
    expect(r.total).toBe(4);
    expect(r.today).toBe(1);
  });
});

describe("tool candidates and pruning", () => {
  const PROMPT = "check my linear tickets and email, then screenshot the deploy";

  it("proposes unique tools in table order, capped for the Jev call", () => {
    expect(toolCandidates(PROMPT)).toEqual(["Linear MCP", "spark CLI", "/browse", "vercel / acme-deploy-verify"]);
    expect(toolCandidates("linear linear TICK-1 ticket")).toEqual(["Linear MCP"]);
    expect(toolCandidates("refactor this function")).toEqual([]);
    expect(toolCandidates("linear email calendar posthog figma notion hubspot github").length).toBe(6);
  });

  it("asks Jev one needed/not-needed question per candidate tool", () => {
    const body = buildRouterJevBody("x", [], ["Linear MCP", "/browse"]) as Record<string, unknown>;
    const questions = body.questions as Record<string, { type: string; criteria: unknown }>;
    expect(Object.keys(questions).sort()).toEqual(["model", toolId(0), toolId(1), ...DISPATCH_KEYS].sort());
    expect(questions[toolId(0)]!.type).toBe("score");
    expect(questions[toolId(0)]!.criteria).toEqual(["Not needed to handle the prompt", "Needed to handle the prompt"]);
    expect((body.state as Record<string, unknown>).tools).toEqual([
      { id: toolId(0), name: "Linear MCP" },
      { id: toolId(1), name: "/browse" },
    ]);
  });

  it("sends no tool question and no tool state when nothing matched", () => {
    const body = buildRouterJevBody("x", []) as Record<string, unknown>;
    expect(Object.keys(body.questions as object)).toEqual(["model", ...DISPATCH_KEYS]);
    expect((body.state as Record<string, unknown>).tools).toBeUndefined();
  });

  it("drops the tools Jev says the prompt does not need, best first", () => {
    const rel = new Map([
      [0, 0.91],
      [1, 0.2],
      [2, 0.95],
    ]);
    expect(pickTools(["Linear MCP", "spark CLI", "/browse"], rel)).toEqual([
      { name: "/browse", why: "Jev: needed · 95%" },
      { name: "Linear MCP", why: "Jev: needed · 91%" },
    ]);
  });

  it("prunes a tool Jev never answered for rather than waving it through", () => {
    expect(pickTools(["Linear MCP", "spark CLI"], new Map([[0, 0.8]]))).toEqual([{ name: "Linear MCP", why: "Jev: needed · 80%" }]);
  });

  it("keeps the keyword matches when there is no Jev answer at all", () => {
    // Degraded, never empty: the card must still name tools with Jev unavailable.
    expect(pickTools(["Linear MCP", "spark CLI"], null)).toEqual([
      { name: "Linear MCP", why: "keyword match" },
      { name: "spark CLI", why: "keyword match" },
    ]);
    expect(pickTools([], null)).toEqual([]);
    expect(pickTools(["a", "b", "c", "d", "e", "f"], null).length).toBe(4);
  });

  it("treats the floor as inclusive and caps the list at four", () => {
    expect(pickTools(["a"], new Map([[0, TOOL_RELEVANCE_FLOOR]]))).toHaveLength(1);
    expect(pickTools(["a"], new Map([[0, TOOL_RELEVANCE_FLOOR - 0.01]]))).toHaveLength(0);
    const all = ["a", "b", "c", "d", "e", "f"];
    expect(pickTools(all, new Map(all.map((_, i) => [i, 0.9])))).toHaveLength(4);
  });

  it("parses per-tool answers, and tolerates a malformed one", () => {
    const answers = {
      model: { choice: "sonnet", probabilities: { opus: 0.1, fable: 0, sonnet: 0.8, haiku: 0.1 }, confidence: 0.7 },
      [toolId(0)]: { score: 1, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.8 },
      [toolId(1)]: { nope: true },
    };
    const parsed = parseRouterJevAnswers({ answers }, 0, 2);
    expect(parsed.toolRelevance.get(0)).toBe(0.9);
    expect(parsed.toolRelevance.has(1)).toBe(false);
    expect(parsed.model).toBe("sonnet");
  });

  it("leaves toolRelevance empty when no tools were offered", () => {
    const answers = { model: { choice: "fable", probabilities: { opus: 0.1, fable: 0.7, sonnet: 0.1, haiku: 0.1 }, confidence: 0.7 } };
    expect(parseRouterJevAnswers({ answers }, 0).toolRelevance.size).toBe(0);
  });
});

describe("dispatch", () => {
  const skills = [
    { slug: "code-review", description: "Review a diff or pull request for correctness bugs." },
    { slug: "pptx", description: "Build PowerPoint slide decks." },
    { slug: "linkedin-post", description: "Write a LinkedIn post." },
  ];

  it("offers only skills whose words appear in the prompt, best overlap first", () => {
    expect(skillCandidates("review this pull request", skills).map((s) => s.slug)).toEqual(["code-review"]);
    expect(skillCandidates("", skills)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ slug: `s${i}`, description: "deck" }));
    expect(skillCandidates("make a deck", many)).toHaveLength(MAX_SKILL_CANDIDATES);
  });

  it("puts skills and the question bank into one batched body", () => {
    const body = buildRouterJevBody("review the PR", [], [], [skills[0]!], QUESTION_BANK) as {
      state: Record<string, unknown>;
      questions: Record<string, { type: string }>;
    };
    expect(body.questions.skill_0?.type).toBe("score");
    // A catch-all workflow skill (live miss 2026-10-30: "yalla" offered for a PR review)
    // and keyword-started skills are ruled out in the question itself.
    expect((body.questions.skill_0 as unknown as { instructions: string }).instructions).toMatch(/general workflow.*keyword/s);
    expect(body.questions[`ask_${QUESTION_BANK.length - 1}`]?.type).toBe("score");
    expect(body.questions.deliver?.type).toBe("choice");
    expect((body.state.questions as unknown[]).length).toBe(QUESTION_BANK.length);
  });

  it("parses dispatch answers and tolerates bad ones field by field", () => {
    const yes = (p: number) => ({ score: p, probabilities: { "0": 1 - p, "1": p }, confidence: 0.8 });
    const parsed = parseRouterJevAnswers(
      {
        answers: {
          model: { choice: "sonnet", probabilities: {}, confidence: 0.7 },
          history: yes(0.9),
          web: "garbage",
          deliver: { choice: "spreadsheet", probabilities: {}, confidence: 0.9 },
          size: { choice: "big", probabilities: {}, confidence: 0.9 },
          skill_0: yes(0.4),
          skill_1: yes(0.7),
        },
      },
      0,
      0,
      2,
      0,
    );
    expect(parsed.history).toBe(0.9);
    expect(parsed.web).toBeNull();
    expect(parsed.deliver).toBeNull(); // not one of the allowed deliverables
    expect(parsed.size).toBe("big");
    const d = pickDispatch(parsed, skills, QUESTION_BANK);
    expect(d?.skill).toEqual({ name: "pptx", p: 0.7 }); // skill_0 under the floor
    expect(d?.ask).toEqual([]);
  });

  it("asks at most MAX_ASK_OUT questions, only above ASK_FLOOR, most needed first", () => {
    const askNeed = new Map(QUESTION_BANK.map((_, i) => [i, i === 0 ? ASK_FLOOR - 0.01 : 0.6 + i * 0.05]));
    const d = pickDispatch({ history: 0.5, web: 0, deliver: "answer", size: "quick", skillFit: new Map(), askNeed }, [], QUESTION_BANK);
    expect(d?.ask).toHaveLength(MAX_ASK_OUT);
    expect(d?.ask[0]).toBe(QUESTION_BANK[QUESTION_BANK.length - 1]!.text);
    expect(d?.ask).not.toContain(QUESTION_BANK[0]!.text);
  });

  it("returns null when Jev answered none of the dispatch questions", () => {
    expect(pickDispatch({ history: null, web: null, deliver: null, size: null, skillFit: new Map(), askNeed: new Map() }, [], [])).toBeNull();
  });
});

describe("summarizeRouteCards: cached follow-ups", () => {
  it("counts a cached follow-up as cached, not as a down server", () => {
    const text = [
      JSON.stringify({ ts: "2026-10-29T10:00:00Z", model: "sonnet", source: "jev" }),
      JSON.stringify({ ts: "2026-10-29T10:01:00Z", model: null, source: "cached" }),
      JSON.stringify({ ts: "2026-10-29T10:02:00Z", model: null, source: "down" }),
    ].join("\n");
    const s = summarizeRouteCards(text, Date.parse("2026-10-29T12:00:00Z"));
    expect(s.cached).toBe(1);
    expect(s.down).toBe(1);
    expect(s.byTier.sonnet).toBe(1);
  });
});

describe("mergeCandidates", () => {
  const c = (path: string): NoteCandidate => ({ path, title: path, bm25Score: 1 });
  it("interleaves vector and BM25 hits, vector first, without repeats", () => {
    expect(mergeCandidates([c("a"), c("b"), c("x")], [c("b"), c("y")], 10).map((x) => x.path)).toEqual(["a", "b", "y", "x"]);
  });
  it("caps the list and works with either side empty", () => {
    expect(mergeCandidates([c("a"), c("b"), c("c")], [], 2).map((x) => x.path)).toEqual(["a", "b"]);
    expect(mergeCandidates([], [c("z")]).map((x) => x.path)).toEqual(["z"]);
  });
  it("titles a vector hit from its file name", () => {
    expect(titleFromPath("/m/memory/project_alef-repo.md")).toBe("project alef-repo");
  });
});

describe("graph second wave", () => {
  const node = (id: string, path: string, links: string[] = [], kind: "n" | "a" = "n"): GraphNode => ({ id, path, kind, links });
  const nodes = [
    node("p1", "20-Projects/brain/_index.md", ["d1", "img", "d2", "d3"]),
    node("d1", "30-Knowledge/vault-sync-decision.md"),
    node("img", "assets/x.png", [], "a"),
    node("d2", "30-Knowledge/locks.md"),
    node("d3", "30-Knowledge/third.md"),
    node("m1", "60-Meta/claude-config/memory/project_alef-repo.md", ["p1", "d1", "d3"]),
  ];
  const graph = { byPath: new Map(nodes.map((n) => [n.path, n])), byId: new Map(nodes.map((n) => [n.id, n])) };
  const V = "/v";
  const M = "/home/me/.claude/projects/x/memory";
  const toRel = (p: string) => vaultRelative(p, V, M);
  const toAbs = (rel: string) => `${V}/${rel}`;
  const cand = (path: string): NoteCandidate => ({ path, title: path, bm25Score: 1 });

  it("maps vault, memory and brain-graph paths into the vault", () => {
    expect(vaultRelative("/v/20-Projects/brain/_index.md", V, M)).toBe("20-Projects/brain/_index.md");
    expect(vaultRelative(`${M}/project_alef-repo.md`, V, M)).toBe("60-Meta/claude-config/memory/project_alef-repo.md");
    expect(vaultRelative("brain-graph:30-Knowledge/x.md", V, M)).toBe("30-Knowledge/x.md");
    expect(vaultRelative("/elsewhere/x.md", V, M)).toBeNull();
  });

  it("follows the top seeds' links, skipping attachments and existing candidates, capped", () => {
    const wave = graphWave([cand("/v/20-Projects/brain/_index.md"), cand(`${M}/project_alef-repo.md`), cand("/v/30-Knowledge/locks.md")], graph, toRel, toAbs);
    // seed 1 -> d1 (d2 already a candidate, img an attachment), then d3; seed 2 -> its links are all taken
    expect(wave.map((w) => w.path)).toEqual(["/v/30-Knowledge/vault-sync-decision.md", "/v/30-Knowledge/third.md"]);
    expect(wave[0]!.title).toBe("vault-sync-decision");
    expect(wave.length).toBeLessThanOrEqual(MAX_WAVE);
  });

  it("is empty when no seed is in the graph", () => {
    expect(graphWave([cand("/elsewhere/a.md")], graph, toRel, toAbs)).toEqual([]);
  });
});
