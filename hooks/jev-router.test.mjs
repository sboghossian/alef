import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatContext, detectTools, parseConfidence, buildLogEntry, serverTools, isFollowUp, dispatchLog, isTerse } from "./jev-router.mjs";

const jev = (model, pct) => ({ ok: true, model, why: `Jev: ${model} · ${pct}% confidence`, notes: [] });

test("opus card", () => {
  const t = formatContext(jev("opus", 80));
  assert.match(t, /^## Route card \(Jev · opus · 80%\)\nEffort high\./);
  assert.match(t, /subagents that return conclusions, not file dumps/);
});
test("sonnet card", () => {
  const t = formatContext(jev("sonnet", 80));
  assert.match(t, /Effort medium\./);
  assert.match(t, /sonnet subagent \(effort: medium\)/);
});
test("haiku card", () => {
  assert.match(formatContext(jev("haiku", 80)), /^## Route card \(Jev · haiku · 80%\)\nMechanical work:/);
});
test("fable card", () => {
  const t = formatContext(jev("fable", 80));
  assert.match(t, /^## Route card \(Jev · fable · 80%\)\nEffort high\./);
  assert.match(t, /judged on its quality/);
  assert.match(t, /draws usage down faster than opus/);
});

// The bug this guards: formatContext returns null for a model it has no TIER_LINES entry
// for, so adding a tier to the shared union without adding a line here does not degrade the
// card -- it silently suppresses the whole thing. Read from source rather than imported,
// since this is a .mjs test and ModelTier is a TypeScript type.
test("every ModelTier in the shared union gets a card", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "features", "router.ts"), "utf8");
  const m = /export type ModelTier =([^;]+);/.exec(src);
  assert.ok(m, "could not find the ModelTier union -- update this test");
  const tiers = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  assert.ok(tiers.length >= 4, `expected 4+ tiers, parsed ${tiers.join()}`);
  for (const tier of tiers) {
    assert.ok(formatContext(jev(tier, 80)), `ModelTier "${tier}" has no TIER_LINES entry, so its card is dropped`);
  }
});
test("confidence parsing", () => {
  assert.equal(parseConfidence("Jev: opus · 28% confidence"), 28);
  assert.equal(parseConfidence("keyword rules (no Jev key)"), null);
  assert.match(formatContext(jev("opus", 28)), /Low confidence: your judgment overrides/);
  assert.doesNotMatch(formatContext(jev("opus", 80)), /Low confidence/);
});
test("rules fallback heading", () => {
  for (const s of ["x (no Jev key)", "x (Jev rate-limited)", "x (Jev unavailable)"]) {
    const t = formatContext({ ok: true, model: "sonnet", why: s });
    assert.match(t, /^## Route card \(rules · sonnet\)/);
    assert.match(t, /Low confidence/);
  }
  assert.match(formatContext({ ok: true, model: "sonnet", why: "plain" }), /^## Route card \(Jev · sonnet\)/);
});
test("tool detection", () => {
  assert.deepEqual(detectTools("check my linear tickets and email, then fix the PR #12"), ["Linear MCP", "spark CLI", "gh CLI"]);
  assert.deepEqual(detectTools("linear linear TICK-12 ticket"), ["Linear MCP"]);
  assert.equal(detectTools("linear email calendar posthog figma notion hubspot").length, 4);
  assert.deepEqual(detectTools("refactor this function"), []);
  assert.doesNotMatch(formatContext(jev("opus", 80), []), /Tools:/);
  assert.match(formatContext(jev("opus", 80), ["Linear MCP"]), /\nTools: Linear MCP\. Check each/);
});
test("900 char cap", () => {
  const notes = Array.from({ length: 4 }, (_, i) => ({ title: "T".repeat(300), path: `/a/b/${i}.md` }));
  const t = formatContext({ ok: true, model: "opus", why: "x (no Jev key)", notes }, ["Linear MCP", "spark CLI", "gh CLI", "/browse"]);
  assert.ok(t.length <= 900);
  assert.ok(t.split("\n").length <= 6);
});
test("log entry shapes", () => {
  const down = buildLogEntry({ payload: { session_id: "s" }, cwd: "/x", result: null, tools: ["gh CLI"] });
  assert.deepEqual(Object.keys(down), ["ts", "session", "cwd", "model", "confidence", "tools", "source"]);
  assert.equal(down.source, "down");
  assert.equal(down.model, null);
  assert.equal(down.confidence, null);
  const ok = buildLogEntry({ payload: {}, cwd: "", result: jev("opus", 28), tools: [] });
  assert.equal(ok.source, "jev");
  assert.equal(ok.confidence, 28);
  assert.equal(ok.session, null);
});

test("harness turns (subagent hand-backs, task notifications) are not routed", async () => {
  const { isHarnessTurn } = await import("./jev-router.mjs");
  assert.equal(isHarnessTurn('<agent-message from="a1">[Subagent hand-back] done'), true);
  assert.equal(isHarnessTurn("[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>"), true);
  assert.equal(isHarnessTurn("Aleph, what's on today"), false);
});

test("the server's pruned tool list wins over the local keyword table", () => {
  // The prompt's keywords suggest three tools; Jev kept one. Returning null for the empty
  // and malformed cases is what makes the caller fall back instead of reading an empty
  // list as "this prompt needs no tools".
  const prompt = "check my linear tickets and email, then fix the PR #12";
  assert.deepEqual(detectTools(prompt), ["Linear MCP", "spark CLI", "gh CLI"]);
  assert.deepEqual(serverTools({ tools: [{ name: "Linear MCP", why: "Jev: needed · 91%" }] }), ["Linear MCP"]);
  assert.equal(serverTools({ tools: [] }), null);
  assert.equal(serverTools({}), null);
  assert.equal(serverTools(null), null);
  assert.equal(serverTools({ tools: "Linear MCP" }), null);
  assert.equal(serverTools({ tools: [{ why: "no name" }, { name: "" }] }), null);
});

test("the server's tool list is still capped at four", () => {
  const many = ["a", "b", "c", "d", "e", "f"].map((name) => ({ name, why: "x" }));
  assert.deepEqual(serverTools({ tools: many }), ["a", "b", "c", "d"]);
});

const notes = [{ title: "Vault locks", path: "/v/20-Projects/brain/vault-write-locks.md" }];
const withDispatch = (d) => ({ ...jev("sonnet", 80), notes, dispatch: d });

test("dispatch card: history needed lists the notes to read first", () => {
  const t = formatContext(withDispatch({ history: 0.8, web: 0.1, deliver: "pr", size: "big", skill: { name: "code-review", p: 0.9 }, ask: [] }));
  assert.match(t, /^## Dispatch card \(Jev · sonnet · 80%\)/);
  assert.match(t, /History: needed \(80%\)\. Read first, only these: Vault locks \[brain\/vault-write-locks\.md\]/);
  assert.match(t, /Skill: code-review \(90%\) · Web: no · Deliver: pr · Size: big \(delegate per the tier line\)/);
  assert.doesNotMatch(t, /Ask Steph/);
});
test("dispatch card: history not needed drops the notes and says act now", () => {
  const t = formatContext(withDispatch({ history: 0.2, web: 0.7, deliver: "answer", size: "quick", skill: null, ask: ["Which project?"] }));
  assert.match(t, /History: not needed \(20%\)\. Act now; fetch only if you hit an unknown\./);
  assert.doesNotMatch(t, /Vault locks/);
  assert.match(t, /Web: yes/);
  assert.match(t, /Size: quick \(inline, no planning step\)/);
  assert.match(t, /Ask Steph first, only these: Which project\?/);
});
test("terse prompts: no notes, no questions, plan line kept", () => {
  const d = { history: 0.69, web: 0.1, deliver: "answer", size: "quick", skill: null, ask: ["Is there an existing file?"] };
  const t = formatContext(withDispatch(d), [], { terse: true });
  assert.match(t, /Short reply: carry on from this session's context/);
  assert.doesNotMatch(t, /Vault locks|Read first|Ask Steph/);
  assert.match(t, /Deliver: answer · Size: quick/);
});
test("isTerse", () => {
  for (const p of ["pr", "switch", "have you checked? all good?", "merge"]) assert.equal(isTerse(p), true, p);
  for (const p of ["review the PR for the brain graph", "x".repeat(41), ""]) assert.equal(isTerse(p), p === "", p);
});
test("big size only says delegate when Jev is confident", () => {
  const d = { history: 0.8, web: 0, deliver: "answer", size: "big", skill: null, ask: [] };
  assert.match(formatContext({ ...jev("haiku", 80), notes, dispatch: d }), /Size: big \(delegate per the tier line\)/);
  assert.match(formatContext({ ...jev("haiku", 25), notes, dispatch: d }), /Size: big \(unsure; delegate only if the work proves big\)/);
});
test("log marks terse turns", () => {
  assert.equal(buildLogEntry({ payload: {}, cwd: "", result: jev("haiku", 80), tools: [], terse: true }).terse, true);
  assert.equal("terse" in buildLogEntry({ payload: {}, cwd: "", result: jev("haiku", 80), tools: [] }), false);
});
test("no dispatch block keeps the plain route card", () => {
  const t = formatContext({ ...jev("haiku", 80), notes });
  assert.match(t, /^## Route card/);
  assert.match(t, /Related notes: Vault locks/);
});
test("card stays under the context cap", () => {
  const long = "x".repeat(300);
  const t = formatContext(withDispatch({ history: 0.9, web: 1, deliver: "doc", size: "big", skill: { name: long, p: 1 }, ask: [long, long, long] }));
  assert.ok(t.length <= 900);
});
test("follow-up detection", () => {
  const now = 1_000_000_000;
  assert.equal(isFollowUp("yes, merge it", now - 60_000, now), true);
  assert.equal(isFollowUp("yes, merge it", null, now), false); // no card yet this session
  assert.equal(isFollowUp("yes, merge it", now - 31 * 60_000, now), false); // card too old
  assert.equal(isFollowUp("now check my linear tickets", now - 60_000, now), false); // names a tool
  assert.equal(isFollowUp("a".repeat(81), now - 60_000, now), false); // too long to be a follow-up
});
test("dispatch log fields are prompt-free", () => {
  assert.deepEqual(dispatchLog(withDispatch({ history: 0.333, web: 0, deliver: "pr", size: "big", skill: { name: "tdd", p: 0.8 }, ask: ["a", "b"] })), {
    history: 0.33, web: 0, deliver: "pr", size: "big", skill: "tdd", asked: 2,
  });
  assert.deepEqual(dispatchLog(jev("opus", 80)), {});
});
