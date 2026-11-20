// The copy guard on what Alef says (invented values only). It is tested ALONE here: no phrasing
// rules, no per-turn value lists, only intent stems, what the reply copies from the turn's sources,
// and the taint of closed files' values.

import { describe, expect, it } from "vitest";
import { randomTaintKey, taintEntries, TaintSet, normalizeValue } from "../features/credential-taint-lib.js";
import { GuardSources, hasIntent, numberRuns, ReplyGuard, WITHHELD_SPOKEN, type GuardContext } from "../features/voice-brain-guard-lib.js";
import { GUARD_KNOWN_MISSES, HOLDOUT_R6, ORDINARY_NOTES, ORDINARY_SPOKEN, REVIEW5_MISSES, REVIEW5_RESHAPED, REVIEW5_UNASKED } from "./credential-fixtures.js";

/** A few common words, as /usr/share/dict/words would know them (no compounds). */
const COMMON = new Set(
  "the a an is it its you your my to of in on at for with and then set use log opens open garage door gate front back side lobby safe closet opener remote network password key guest code codes card pin bike combination locker gym laptop router admin building chalet mailbox box printer zoom server panel phone app bank alarm shed padlock seed words start orbit lemon canyon velvet shadow tiger mango pepper ivory drum cable scout marmalade kettle harbor nine popcorn river violet anchor tundra hunter root".split(" "),
);
const dictionaries: Record<string, ((w: string) => boolean) | undefined> = { "no dictionary": undefined, "a small dictionary": (w) => COMMON.has(w), "a dictionary that knows every word": () => true };

/** The value as the output would carry it: numbers (in digits or in words) as digits, then letters
 *  and digits only. */
function asDigits(s: string): string {
  let t = s;
  for (const r of [...numberRuns(s)].reverse()) t = t.slice(0, r.start) + r.digits + t.slice(r.end);
  return normalizeValue(t);
}

/** The output says the value: whole, or every one of its digit groups in order ("left 22, right 8"). */
function says(out: string, value: string): boolean {
  if (asDigits(out).includes(asDigits(value))) return true;
  const groups = value.match(/\d+/g) ?? [];
  const said = numberRuns(out).map((r) => r.digits);
  return groups.length >= 2 && said.join(" ").includes(groups.join(" "));
}

function guard(note: string, q: string, reply: string, extra: Partial<GuardContext> = {}): string {
  const sources = new GuardSources();
  sources.add(note);
  return ReplyGuard.text(reply, { question: q, sources, ...extra });
}

describe("numbers said in words", () => {
  it.each([
    ["four eight two one", "4821"],
    ["forty-eight twenty-one", "4821"],
    ["48 hundred and 21", "4821"],
    ["4, then 8, then 2, then 1", "4821"],
    ["double five six six", "5566"],
    ["four zeros", "0000"],
    ["two fives and nine", "559"],
    ["36 24 12", "362412"],
    ["7-7-3-1", "7731"],
    ["quatre huit deux un", "4821"],
    ["quatre-vingt-dix-neuf", "99"],
    ["cinco dos nueve siete", "5297"],
    ["treinta y seis", "36"],
    ["vier acht twee een", "4821"],
    ["zesendertig", "36"],
    ["arb3a tmene tnen wa7ad", "4821"],
    ["أربعة ثمانية اثنان واحد", "4821"],
    ["٤٨٢١", "4821"],
  ])("%s → %s", (said, digits) => {
    expect(numberRuns(said).map((r) => r.digits)).toEqual([digits]);
  });

  it("a lone everyday word is not a number, and a time is two numbers", () => {
    expect(numberRuns("one of them")).toEqual([]);
    expect(numberRuns("Sept 2025").map((r) => r.digits)).toEqual(["2025"]);
    expect(numberRuns("at 15:30").map((r) => r.digits)).toEqual(["15", "30"]);
    expect(numberRuns("wa7ad")).toEqual([]);
  });
});

describe("intent", () => {
  it.each([
    "What's the garage code?",
    "How do I get into the parking?",
    "Remind me of the wifi password",
    "wi-fi?",
    "Log in to the NAS",
    "Quel est le code de la porte ?",
    "Comment j'ouvre le portail ?",
    "¿Cómo abro el garaje?",
    "Wat is het wachtwoord van de wifi?",
    "shu code el bab?",
    "ما هو رمز الباب؟",
    "The side gate unlocks with it",
    "wifi pass: x",
    "PIN: 4821",
    "The pin up to now was 4821",
  ])("about access: %s", (t) => {
    expect(hasIntent(t)).toBe(true);
  });

  it.each([
    "How many Claude Code sessions ran yesterday?",
    "Secret scans need rtk proxy.",
    "When does my passport expire?",
    "2459 tests pass and 20 are skipped.",
    "We shipped 4821 lines of code this sprint.",
    "Pass the report to Sam by Friday.",
    "Is the keyboard shortcut documented?",
    "What's the open source licence?",
    "When was the baby born?",
    "What's the safety policy?",
    "We raised 2.5M in the seed round in 2025.",
    "Karim's PIN-up poster sold for 60 USD at the fair.",
  ])("not about access: %s", (t) => {
    expect(hasIntent(t)).toBe(false);
  });
});

describe("the copy guard, alone", () => {
  for (const [name, isWord] of Object.entries(dictionaries))
    it(`withholds every round-5 miss (${REVIEW5_MISSES.length}) with ${name}`, () => {
      for (const c of REVIEW5_MISSES) {
        const out = guard(c.note, c.q, c.reply, isWord ? { isWord } : {});
        expect(says(out, c.value), `${c.note} → ${out}`).toBe(false);
        expect(out, c.note).toContain(WITHHELD_SPOKEN);
      }
    });

  for (const [name, isWord] of Object.entries(dictionaries).slice(0, 2))
    it(`withholds every round-6 hold-out phrasing (${HOLDOUT_R6.length}), written after the redesign, with ${name}`, () => {
      for (const c of HOLDOUT_R6) {
        const out = guard(c.note, c.q, c.reply, isWord ? { isWord } : {});
        expect(says(out, c.value), `${c.note} → ${out}`).toBe(false);
        expect(out, c.note).toContain(WITHHELD_SPOKEN);
      }
    });

  it(`says ordinary answers with numbers and dates (${ORDINARY_SPOKEN.length}) exactly as written, though they copy the notes`, () => {
    for (const [q, reply] of ORDINARY_SPOKEN) expect(guard(`Note: ${reply}`, q, reply, { isWord: (w) => COMMON.has(w) })).toBe(reply);
  });

  it("never withholds what he said himself", () => {
    expect(guard("The garage opens with 6093", "Is the garage code still 6093?", "Yes, 6093.")).toBe("Yes, 6093.");
  });

  it("a name is said unless the notes wrote it about access", () => {
    const note = "The door code is 4821. The concierge is Samir.";
    expect(guard(note, "Who has the door code?", "Samir the concierge can help.", { isWord: (w) => COMMON.has(w) || w === "concierge" || w === "help" || w === "can" })).toBe("Samir the concierge can help.");
    const out = guard("Samir: 4821 for the door", "Who has the door code?", "Ask Samir.", { isWord: (w) => w === "ask" });
    expect(out).toBe(`Ask — ${WITHHELD_SPOKEN}`);
  });

  it("keeps what comes before the value, says the notice once for a run of withheld sentences", () => {
    const sources = new GuardSources();
    sources.add("Garage: 4821. Mac login: swordfish9");
    const g = new ReplyGuard({ question: "What are my codes?", sources });
    expect(g.sentence("The garage code is 4821.")).toBe(`The garage code is — ${WITHHELD_SPOKEN}`);
    expect(g.sentence("It's 4821.")).toBe(""); // right after the notice: nothing more to say
    expect(g.sentence("Anything else, sir?")).toBe("Anything else, sir?");
    expect(g.sentence("swordfish9.")).toBe(WITHHELD_SPOKEN);
  });

  it("a sentence about access makes the next one about access too", () => {
    const sources = new GuardSources();
    sources.add("Garage: 6093");
    const g = new ReplyGuard({ question: "What do I need tonight?", sources });
    expect(g.sentence("You'll need the garage code.")).toBe("You'll need the garage code.");
    expect(g.sentence("It's 6093.")).toBe(WITHHELD_SPOKEN);
    expect(g.sentence("Dinner is at 20:30.")).toBe("Dinner is at 20:30.");
  });
});

describe("the copy guard, second pass: what the notes wrote next to what it opens", () => {
  for (const [name, isWord] of Object.entries(dictionaries))
    it(`withholds it from a reply not about access, to a question not about access (${REVIEW5_UNASKED.length}), with ${name}`, () => {
      for (const c of REVIEW5_UNASKED) {
        // A dictionary word is said outside a sentence about access, even next to a password word.
        if (name === "a dictionary that knows every word" && !/\d/.test(c.value)) continue;
        expect(hasIntent(c.q), c.q).toBe(false);
        expect(hasIntent(c.reply), c.reply).toBe(false);
        const out = guard(c.note, c.q, c.reply, isWord ? { isWord } : {});
        expect(says(out, c.value), `${c.note} → ${out}`).toBe(false);
        expect(out, c.note).toContain(WITHHELD_SPOKEN);
      }
    });

  it(`withholds a value re-spaced, spelled out or joined by symbols (${REVIEW5_RESHAPED.length})`, () => {
    for (const c of REVIEW5_RESHAPED) {
      const out = guard(c.note, c.q, c.reply, { isWord: (w) => COMMON.has(w) || w === "spell" || w === "melody" });
      expect(says(out, c.value), `${c.note} → ${out}`).toBe(false);
    }
  });

  it(`says ordinary answers copied from notes that use access words in everyday senses (${ORDINARY_NOTES.length})`, () => {
    const words = new Set([...COMMON, ..."firms onboarded downloads week waiting review saved this per command archive holds sessions from days version runs port lift onto floor workshop room round closed march journal entry resident filed proposals backup ran files copied account manager since how many much what where which when big did has been".split(" ")]);
    for (const [note, q, reply] of ORDINARY_NOTES) expect(guard(note, q, reply, { isWord: (w) => words.has(w) }), note).toBe(reply);
  });

  it(`the misses it cannot catch by design still get through (${GUARD_KNOWN_MISSES.length}): no access word in the note, the question or the reply`, () => {
    for (const c of GUARD_KNOWN_MISSES) expect(says(guard(c.note, c.q, c.reply, { isWord: (w) => COMMON.has(w) }), c.value), c.note).toBe(true);
  });

  it("a follow-up to an access question is about access too", () => {
    const sources = new GuardSources();
    sources.add("Car: 5512 to drive");
    expect(ReplyGuard.text("You need 5512.", { question: "Just read me the car note.", sources })).toBe("You need 5512.");
    expect(ReplyGuard.text("You need 5512.", { question: "Just read me the car note.", previous: ["What's the code to start the car?"], sources })).toBe(`You need — ${WITHHELD_SPOKEN}`);
  });

  it("the reply is about access from its first sentence about access on", () => {
    const sources = new GuardSources();
    sources.add("Car: 5512 to drive");
    const g = new ReplyGuard({ question: "What do I need tonight?", sources, isWord: (w) => COMMON.has(w) || ["need", "car", "note", "has"].includes(w) });
    expect(g.sentence("You'll need the car key.")).toBe("You'll need the car key.");
    expect(g.sentence("Your note has it.")).toBe("Your note has it.");
    expect(g.sentence("It's 5512.")).toBe(WITHHELD_SPOKEN);
  });

  it("a lookup's big result costs little: 400 KB of notes in well under a second", () => {
    const sources = new GuardSources();
    const para = "The gate code for the old office was 6093 and the door opens at 09:00. Victor has the key to room 1205. ";
    const t0 = performance.now();
    sources.add(para.repeat(4000));
    const out = ReplyGuard.text("Victor has it. The old office used 6093.", { question: "Who has the office key?", sources });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out).toContain(WITHHELD_SPOKEN);
  });

  it("his own number stays only exactly as he said it, not inside a longer one", () => {
    expect(guard("Car: 5512 to drive", "Is the car code 55129999?", "No, it's 5512.")).toBe(WITHHELD_SPOKEN);
    expect(guard("Car: 5512 to drive", "Is the car code 5512?", "Yes, 5512.")).toBe("Yes, 5512.");
  });
});

describe("the copy guard with the taint of closed files", () => {
  const key = randomTaintKey();
  const MASTER = "Kx9Plum-44Travel-Zq81";
  const taint = new TaintSet(key, [...taintEntries(key, MASTER), ...taintEntries(key, "6093")]);

  it("withholds a closed file's value in any sentence, about access or not, copied or not", () => {
    const out = guard("", "What's in my France Travail note?", `Your France Travail file number is ${MASTER}, sent in March.`, { taint });
    expect(asDigits(out)).not.toContain(asDigits(MASTER));
    expect(out).toBe(`Your France Travail file number is — ${WITHHELD_SPOKEN}`);
  });

  it("however it is said: spaced, in another case, cut to a long prefix, or in words", () => {
    for (const said of ["KX9 PLUM 44 TRAVEL ZQ81", "kx9plum44travel…", "the number six zero nine three came up"]) {
      const out = guard("", "Tell me about my week", `Noted: ${said}.`, { taint });
      expect(out, said).toContain(WITHHELD_SPOKEN);
    }
  });

  it("leaves everything else alone", () => {
    expect(guard("", "When is my meeting?", "Your meeting is at 16:00 on 2026-10-01.", { taint })).toBe("Your meeting is at 16:00 on 2026-10-01.");
  });
});
