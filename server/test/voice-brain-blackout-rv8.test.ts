// The round-8 defensive review's probes of the number blackout (reviewer-authored, INVENTED values
// only), kept as regression tests: numbers with an everyday-word digit ("one", "oh", "un") said
// alone, and a mixed-case code read aloud with case markers or split across sentences. Same entry
// point as voice-brain.ts: GuardSources + BlackoutSources fed the note, ReplyGuard over the reply,
// streamed sentence by sentence.
import { describe, expect, it } from "vitest";
import { normalizeValue } from "../features/credential-taint-lib.js";
import { BlackoutSources } from "../features/voice-brain-blackout-lib.js";
import { GuardSources, numberRuns, ReplyGuard } from "../features/voice-brain-guard-lib.js";
import { SentenceStreamer } from "../features/voice-lib.js";

function guardFor(notes: ReadonlyArray<readonly [string, string]>, question: string): ReplyGuard {
  const sources = new GuardSources();
  const blackout = new BlackoutSources();
  for (const [where, text] of notes) {
    sources.add(text);
    blackout.add(text, where);
  }
  return new ReplyGuard({ question, sources, blackout, taint: null });
}
function speak(g: ReplyGuard, reply: string): string[] {
  const st = new SentenceStreamer();
  const out: string[] = [];
  for (const s of [...st.push(reply), ...st.flush()]) out.push(...g.push(s));
  out.push(...g.flush());
  return out;
}
function asDigits(s: string): string {
  let t = s;
  for (const r of [...numberRuns(s)].reverse()) t = t.slice(0, r.start) + r.digits + t.slice(r.end);
  return normalizeValue(t);
}
const BLACKOUT = /I don't read codes aloud/;

describe("area 1: numbers with an everyday-word digit", () => {
  const CASES: Array<{ note: string; q: string; reply: string; value: string }> = [
    { note: "Tante Mona: 1234.", q: "What did I write about Tante Mona?", reply: "One two three four.", value: "1234" },
    { note: "Tante Mona: 1234.", q: "What did I write about Tante Mona?", reply: "It's one, two, three, four.", value: "1234" },
    { note: "Tante Mona: 1234.", q: "What did I write about Tante Mona?", reply: "One. Two. Three. Four.", value: "1234" },
    { note: "Tante Mona: 1234.", q: "What did I write about Tante Mona?", reply: "Twelve thirty-four.", value: "1234" },
    { note: "Tante Mona: 6093.", q: "What did I write about Tante Mona?", reply: "Six, oh, nine, three.", value: "6093" },
    { note: "Tante Mona: 1809.", q: "What did I write about Tante Mona?", reply: "Eighteen oh nine.", value: "1809" },
    { note: "Tante Mona: 2001.", q: "What did I write about Tante Mona?", reply: "Twenty oh one.", value: "2001" },
    { note: "Tante Mona: 4101.", q: "What did I write about Tante Mona?", reply: "Forty-one oh one.", value: "4101" },
    { note: "Tante Mona: 4242.", q: "What did I write about Tante Mona?", reply: "Four two four two.", value: "4242" },
    { note: "Tante Mona: 1111.", q: "What did I write about Tante Mona?", reply: "Four ones.", value: "1111" },
    { note: "Tante Mona: 1122.", q: "What did I write about Tante Mona?", reply: "Double one, double two.", value: "1122" },
    // The existing suite's "The first digit is six. …" style, with a 1 or a 0-as-oh in it.
    { note: "Tante Mona: 1234.", q: "What did I write about Tante Mona?", reply: "The first digit is one. The second is two. The third is three. The last is four.", value: "1234" },
    { note: "Tante Mona: 4821.", q: "What did I write about Tante Mona?", reply: "The first digit is four. The second is eight. The third is two. The last is one.", value: "4821" },
    { note: "Tante Mona: 4821.", q: "What did I write about Tante Mona?", reply: "It starts with four eight two, and ends with one.", value: "4821" },
    { note: "Tante Mona: 6093.", q: "What did I write about Tante Mona?", reply: "The first digit is six. The second is oh. The third is nine. The last is three.", value: "6093" },
    { note: "Tante Mona : 1234.", q: "Que dit ma note sur Tante Mona ?", reply: "Le premier chiffre est un. Le deuxième est deux. Le troisième est trois. Le dernier est quatre.", value: "1234" },
    { note: "Side gate: 1234.", q: "What is the side gate code?", reply: "The first digit is one. The second is two. The third is three. The last is four.", value: "1234" },
  ];
  for (const c of CASES)
    it(`${JSON.stringify(c.reply)} (note ${c.value})`, () => {
      const out = speak(guardFor([["your note 'house'", c.note]], c.q), c.reply).join(" ");
      expect(asDigits(out), out).not.toContain(c.value);
      expect(out, out).toMatch(BLACKOUT);
    });
});

describe("area 2: a mixed-case code read aloud", () => {
  const note = "Router admin — admin / Qx7mB2pz";
  const q = "What does my router note say?";
  const REPLIES = [
    // character by character
    "Q, x, 7, m, B, 2, p, z.",
    "Q x 7 m B 2 p z.",
    "Q-x-7-m-B-2-p-z.",
    "Q, x, seven, m, B, two, p, z.",
    // with capital / lowercase markers
    "Capital Q, x, 7, m, capital B, 2, p, z.",
    "Capital Q, lowercase x, seven, lowercase m, capital B, two, lowercase p, lowercase z.",
    "Capital Q, lowercase x, 7, lowercase m, capital B, 2, lowercase p, lowercase z.",
    "Uppercase Q, lowercase x, seven, lowercase m, uppercase B, two, lowercase p, lowercase z.",
    "Capital Q lowercase x seven lowercase m capital B two lowercase p lowercase z.",
    // letters grouped with digits
    "Qx7m B2pz.",
    "Qx7, mB2, pz.",
    "Qx seven mB two pz.",
    "It starts Qx7m, then B2pz.",
    "The first part is Qx7m. The second part is B2pz.",
  ];
  for (const reply of REPLIES)
    it(JSON.stringify(reply), () => {
      const out = speak(guardFor([["your note 'router'", note]], q), reply).join(" ");
      expect(out, out).toMatch(BLACKOUT);
      // No 4+ consecutive characters of the code survive in what is said.
      const said = normalizeValue(asDigits(out).replace(/capital|lowercase|uppercase/g, ""));
      for (let i = 0; i + 4 <= "qx7mb2pz".length; i++) expect(said, out).not.toContain("qx7mb2pz".slice(i, i + 4));
    });
});
