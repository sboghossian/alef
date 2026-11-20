// The number blackout (invented values only): a number of 4+ digits or a code-like token copied
// from what the turn read, or a closed file's value, is never said aloud, whatever the question is
// about, however the reply spells, splits or sums it. Replies are streamed sentence by sentence
// the way the turn streams them (SentenceStreamer), so a number read out across sentences is
// judged whole.

import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { normalizeValue, randomTaintKey, taintEntries, TaintSet } from "../features/credential-taint-lib.js";
import { BlackoutSources, blackoutNotice, maskExceptions, noteNumbersAndCodes, whereOf } from "../features/voice-brain-blackout-lib.js";
import { GuardSources, numberRuns, ReplyGuard, WITHHELD_SPOKEN } from "../features/voice-brain-guard-lib.js";
import { SentenceStreamer } from "../features/voice-lib.js";

/** A turn's guard over these notes (each with where it is), in the live turn's order: the guard
 *  first, then the notes as they land (voice-brain.ts builds it before retrieval is back). */
function guardFor(notes: ReadonlyArray<readonly [string, string]>, question: string, taint: TaintSet | null = null): ReplyGuard {
  const sources = new GuardSources();
  const blackout = new BlackoutSources();
  const g = new ReplyGuard({ question, sources, blackout, taint });
  for (const [where, text] of notes) {
    sources.add(text);
    blackout.add(text, where);
  }
  return g;
}

/** What the turn says, streamed sentence by sentence (and each piece in the order it is said). */
function speak(g: ReplyGuard, reply: string): string[] {
  const st = new SentenceStreamer();
  const out: string[] = [];
  for (const s of [...st.push(reply), ...st.flush()]) out.push(...g.push(s));
  out.push(...g.flush());
  return out;
}

/** The output as digits (numbers in digits or in words) and letters, run together. */
function asDigits(s: string): string {
  let t = s;
  for (const r of [...numberRuns(s)].reverse()) t = t.slice(0, r.start) + r.digits + t.slice(r.end);
  return normalizeValue(t);
}

const BLACKOUT = /I don't read codes aloud/;

describe("numbers: a run is the numbers it says, never their sum", () => {
  it.each([
    ["Eight thousand eight hundred and thirty, and twenty-one.", ["8830", "21"]],
    ["8830 and 21.", ["8830", "21"]],
    ["48 hundred and 21", ["4821"]],
    ["six thousand and ninety-three", ["6093"]],
    ["two thousand twenty-six", ["2026"]],
    ["Six. Oh. Nine. Three.", ["6", "0", "9", "3"]],
    ["Six… zero… nine… three.", ["6", "0", "9", "3"]],
    ["six o nine three", ["6", "0", "9", "3"]],
    ["sechs null neun drei", ["6", "0", "9", "3"]],
    ["sei zero nove tre", ["6", "0", "9", "3"]],
    ["sei sette nove tre", ["6", "7", "9", "3"]],
    ["einundzwanzig", ["21"]],
    ["ventitre", ["23"]],
    ["Seventy. Forty-four.", ["70", "44"]],
  ])("%s → %j", (said, groups) => {
    expect(numberRuns(said).flatMap((r) => r.groups)).toEqual(groups);
  });
});

describe("what a note wrote", () => {
  it("numbers of 4+ digits, joined across spaces, dashes, dots and commas, and codes of 5+ mixed characters", () => {
    expect(noteNumbersAndCodes("Fietsslot: 0 9 3 6").numbers).toEqual(["0936"]);
    expect(noteNumbersAndCodes("Numbers for the week: 7394, 12 and 40.").numbers.sort()).toEqual(["73941240", "7394"].sort());
    expect(noteNumbersAndCodes("Router admin — admin / Qx7mB2pz").codes).toContain("qx7mb2pz");
    expect(noteNumbersAndCodes("France Travail\nCastor-Lune-58").codes).toContain("castorlune58");
  });

  it("a year inside a date, and an amount or a measure with its unit, are not numbers to withhold", () => {
    for (const t of ["Check-up on 2026-11-03.", "RDV le 3 avril 2026.", "Signed 14 October 2026", "Since March 2025", "Rent 1850 USD a month", "It was $14.99", "Speed 94 Mbps", "The marathon is 42.2 km", "Budget 4200 EUR", "Invoice for 2,450 USD", "The p95 was 2340 ms", "It rose to 83%"])
      expect(noteNumbersAndCodes(t).numbers, t).toEqual([]);
    expect(maskExceptions("Due 2026-10-10, 18 slides")).toBe("Due __________, 18 slides");
  });

  it("everything else of 4+ digits counts, order and room numbers included (the accepted false withholding)", () => {
    for (const [t, n] of [["Order 58213 from IKEA", "58213"], ["Room 2207 at the Hilton", "2207"], ["The Q4 target is 2600 signups", "2600"], ["Karim's number is +961 3 555 482.", "9613555482"], ["Goals for 2026", "2026"]] as const)
      expect(noteNumbersAndCodes(t).numbers, t).toContain(n);
  });

  it("measures glued to their unit, ordinals and Arabizi words are not codes", () => {
    expect(noteNumbersAndCodes("The NAS has 128GB and a 1080p camera, on the 21st").codes).toEqual([]);
    expect(noteNumbersAndCodes("ra2em el khazne, ba3den el 3ashra").codes).toEqual([]);
    expect(noteNumbersAndCodes("Mac login: fernhollow7 and zaatar99").codes.sort()).toEqual(["fernhollow7", "zaatar99"]);
  });

  it("the recall block's lines say where each came from; a title with a digit is never said", () => {
    const b = new BlackoutSources();
    b.addBlock("<<<UNTRUSTED_DATA\n[vault] vault/30-Knowledge/Garage.md: Garage: The garage opens with 6093.\n[memory] memory/user_badge.md: badge (the office badge): Badge: 3 0 7 7\n[vault] vault/Room 2207.md: Room: 5512 then up\nUNTRUSTED_DATA>>>");
    expect(b.numbers.get("6093")).toBe("your note 'Garage'");
    expect(b.numbers.get("3077")).toBe("your note 'badge'");
    expect(b.numbers.get("5512")).toBe("your notes");
    expect(whereOf("file", "config.ts")).toBe("your file 'config'");
  });
});

describe("the blackout on a spoken reply, whatever the question is about", () => {
  // The round-7 review's numeric misses, each against the note it copies (invented values).
  const CASES: ReadonlyArray<{ note: string; q: string; reply: string; value: string }> = [
    { note: "Numbers to remember: 8830 and 21.", q: "What numbers should I remember?", reply: "8830 and 21.", value: "8830" },
    { note: "Numbers to remember: 8830 and 21.", q: "What numbers should I remember?", reply: "The numbers are 8830 and 21.", value: "8830" },
    { note: "Numbers to remember: 8830 and 21.", q: "What numbers should I remember?", reply: "Eight thousand eight hundred and thirty, and twenty-one.", value: "8830" },
    { note: "Numbers for the week: 7394, 12 and 40.", q: "What are my numbers for the week?", reply: "Card 7394 12.", value: "7394" },
    { note: "Numbers for the week: 7394, 12 and 40.", q: "What are my numbers for the week?", reply: "7394, 12 and 40.", value: "7394" },
    { note: "Fietsslot: 0 9 3 6", q: "Wat staat er over het fietsslot?", reply: "Fietsslot: 0 9 3 6", value: "0936" },
    { note: "Fietsslot: 0 9 3 6", q: "Wat staat er over het fietsslot?", reply: "Nul negen drie zes.", value: "0936" },
    { note: "ra2em el khazne bel maktab: 7 1 9 3", q: "shu fi 3an el maktab?", reply: "ra2em el khazne bel maktab: 7 1 9 3", value: "7193" },
    { note: "Yale on the terrace: 5529 then tick.", q: "What's my note on the Yale on the terrace?", reply: "Yale on the terrace: 5529", value: "5529" },
    { note: "Voicemail: 8420.", q: "What's in my voicemail note?", reply: "Voicemail: 8420", value: "8420" },
    { note: "Screen Time limits on Maya's iPad: 2718.", q: "What did I write about Screen Time?", reply: "Screen Time 2718", value: "2718" },
    { note: "Badge: 3 0 7 7", q: "What's on my office badge note?", reply: "Badge: 3 0 7 7", value: "3077" },
    { note: "The garage opens with 6093.", q: "Read the number in my house note one digit at a time.", reply: "Six. Oh. Nine. Three.", value: "6093" },
    { note: "The garage opens with 6093.", q: "Read my house note slowly.", reply: "Six... zero... nine... three.", value: "6093" },
    { note: "The garage opens with 6093.", q: "What does my house note say?", reply: "The garage opens with:\n- 60\n- 93", value: "6093" },
    { note: "Parking downstairs, 7044.", q: "What did I note for parking downstairs?", reply: "Seventy. Forty-four.", value: "7044" },
    { note: "The garage opens with 6093.", q: "What does my house note say?", reply: "It's six o nine three.", value: "6093" },
    { note: "The garage opens with 6093.", q: "Was steht in meiner Notiz über das Haus, auf Deutsch?", reply: "Die Garage öffnet mit sechs null neun drei.", value: "6093" },
    { note: "The garage opens with 6093.", q: "Cosa dice la nota sulla casa, in italiano?", reply: "Il garage si apre con sei zero nove tre.", value: "6093" },
    { note: "The garage opens with 6093.", q: "What does my house note say?", reply: "The first digit is six. The second is zero. The third is nine. The last one is three.", value: "6093" },
    { note: "Oma's flat: 6 1 8 4, dan de bel.", q: "Wat staat er over oma's flat?", reply: "6 1 8 4, dan de bel.", value: "6184" },
    { note: "Tante Mona: 4821.", q: "Read Tante Mona's number two digits at a time.", reply: "Forty-eight. Twenty-one.", value: "4821" },
    { note: "بيت تيتا: ٢٢٥٨ وبعدين الجرس", q: "شو كتبت عن بيت تيتا؟", reply: "٢٢٥٨ وبعدين الجرس.", value: "2258" },
  ];

  for (const c of CASES)
    it(`${JSON.stringify(c.reply)} (note "${c.note}")`, () => {
      const out = speak(guardFor([["your note 'house'", c.note]], c.q), c.reply);
      expect(asDigits(out.join(" ")), out.join(" | ")).not.toContain(c.value);
      expect(out.join(" "), out.join(" | ")).toMatch(BLACKOUT);
      // Never a piece of it first: what is said before the notice holds none of its first digits.
      const before = out.join(" ").split(/ — |That (?:number|code) is in/)[0] ?? "";
      expect(asDigits(before), out.join(" | ")).not.toContain(c.value.slice(0, 2));
    });

  it("a code spelled out in NATO words, or letter by letter with other words in a list, is withheld", () => {
    const note = "Router admin — admin / Qx7mB2pz";
    for (const reply of ["Queen, x-ray, seven, mike, bravo, two, papa, zulu.", "Quebec X-ray Seven Mike Bravo Two Papa Zulu.", "Q x 7 m. B 2 p z.", "It reads zp2Bm7xQ backwards."]) {
      const out = speak(guardFor([["your note 'router'", note]], "Read my router admin note letter by letter, using words."), reply).join(" ");
      expect(out, reply).toMatch(BLACKOUT);
      expect(out, reply).not.toMatch(/queen|quebec|bravo\W+two|b\W*2\W*p\W*z|zp2bm7xq/i);
    }
  });

  it("a code re-spaced or split into words is withheld; the pointer names the note", () => {
    const g = guardFor([["your note 'Mac'", "Mac login: fernhollow7"]], "What does my Mac note say?");
    expect(speak(g, "Fern, hollow, seven.")).toEqual([blackoutNotice("code", "your note 'Mac'")]);
    expect(speak(guardFor([["your note 'France Travail'", "Castor-Lune-58"]], "Read me line 5."), "Line 5 says Castor Lune 58.")).toEqual([`Line 5 says — ${blackoutNotice("code", "your note 'France Travail'").replace(/^That/, "that")}`]);
  });

  it("the 8830 case: a closed file's value summed across 'and' by the model is withheld by the taint alone", () => {
    const key = randomTaintKey();
    const taint = new TaintSet(key, taintEntries(key, "8 8 3 0"));
    // No note in this turn holds it: only the closed Bank card file does (by keyed hash).
    for (const reply of ["Eight thousand eight hundred and thirty, and twenty-one.", "8830 and 21.", "Eighty-eight. Thirty. And twenty-one."]) {
      const out = speak(guardFor([["your note 'numbers'", "Numbers to remember: two of them."]], "What numbers should I remember?", taint), reply).join(" ");
      expect(asDigits(out), reply).not.toContain("8830");
      expect(out, reply).toMatch(BLACKOUT);
    }
  });

  it("a value said in short pieces with words between them (hold-out F05's class) is withheld: a closed PIN, a closed code, a note's number", () => {
    const key = randomTaintKey();
    const MASTER = "Kx9Plum-44Travel-Zq81"; // invented
    const taint = new TaintSet(key, [...taintEntries(key, "8 8 3 0"), ...taintEntries(key, MASTER)]);
    // The open hint note says the closed PIN in pieces: no 4-digit number in it for the notes' own net.
    const hint: Array<[string, string]> = [["your note 'hint'", "Hint for the family: it starts 88 and the rest is 30. The master one starts Kx9 Plum, then 44 Travel, ends Zq81."]];
    for (const reply of ["It's 88, then 30.", "First 8 8, and after that 3 0.", "88 … the rest is 30.", "It's eighty-eight. Then thirty, sir."]) {
      const out = speak(guardFor(hint, "What's the hint for the family?", taint), reply).join(" ");
      expect(asDigits(out), `${reply} → ${out}`).not.toContain("8830");
      expect(out, reply).toMatch(BLACKOUT);
    }
    const f05 = speak(guardFor(hint, "What's the hint for the family?", taint), "It starts Kx9 Plum, then 44 Travel, and ends Zq81.").join(" ");
    expect(f05, f05).not.toMatch(/zq81/i);
    expect(f05, f05).toMatch(BLACKOUT);
    // A note's own number said in pieces, across sentences, with words between.
    const garage = speak(guardFor([["your note 'garage'", "The garage opens with 6093."]], "What's up?"), "The first half is 60. The second half is 93.").join(" ");
    expect(asDigits(garage), garage).not.toContain("6093");
  });

  it("an everyday digit word said alone ('one', 'oh') or a case-marked spelled code, when only a closed file holds the value", () => {
    const key = randomTaintKey();
    const taint = new TaintSet(key, [...taintEntries(key, "4 8 2 1"), ...taintEntries(key, "6 0 9 3"), ...taintEntries(key, "Qx7mB2pz")]);
    const g = (): ReplyGuard => guardFor([["your note 'misc'", "Nothing to see here."]], "What's up?", taint);
    for (const [reply, value] of [
      ["It starts with four eight two, and ends with one.", "4821"],
      ["The first digit is six. The second is oh. The third is nine. The last is three.", "6093"],
    ] as const) {
      const out = speak(g(), reply).join(" ");
      expect(asDigits(out), `${reply} → ${out}`).not.toContain(value);
    }
    const spelled = speak(g(), "Capital Q, lowercase x, seven, lowercase m, capital B, two, lowercase p, lowercase z.").join(" ");
    expect(spelled, spelled).not.toMatch(/lowercase p/i);
    // Four characters of a note's code spelled with case markers (the markers are not letters of it).
    const part = speak(guardFor([["your note 'router'", "Router: admin / Pz8q-Lark-19"]], "What's up?"), "Capital P, lowercase z, eight, lowercase q.").join(" ");
    expect(part, part).toMatch(BLACKOUT);
    // "One" as a word, not a digit, next to numbers that are not a note's.
    const plain = "Which one? The one from 2019, sir: 3 of them.";
    expect(speak(g(), plain).join(" ")).toBe(plain);
  });

  it("the notes land after the guard is built (the live order): a sentence whose digits start a note's number still waits", () => {
    const garage: Array<[string, string]> = [["your note 'garage'", "The garage opens with 6093."]];
    for (const reply of ["The first digit is six. The second is zero. The third is nine. The last one is three.", "The code starts with 60. It ends with 93."]) {
      const out = speak(guardFor(garage, "What does my house note say?"), reply);
      expect(out[0], out.join(" | ")).toMatch(/— that number is in your note 'garage'/);
      expect(asDigits(out.join(" ")), out.join(" | ")).not.toMatch(/60|six/);
    }
    // A 16-digit number read in 4-digit groups, one per sentence: none of it is said, whether the
    // groups are joined by "then" or by other words (the note's number guides which belong together).
    for (const reply of ["It starts with 4821. Then 5561. Then 7788. Then 9012.", "It starts with 4821. The next group is 5561. After that comes 7788. It ends with 9012."]) {
      const card = speak(guardFor([["your note 'Card'", "Card: 4821556177889012"]], "What's on my card note?"), reply);
      expect(card, card.join(" | ")).toEqual([`It starts with — ${blackoutNotice("number", "your note 'Card'").replace(/^That/, "that")}`]);
    }
  });

  it("a withheld number read out digit by digit does not take the sentences after it down with it", () => {
    const out = speak(guardFor([["your note 'garage'", "The garage opens with 6093."]], "What's up?"), "Six. Oh. Nine. Three. Dinner is on Friday at Em Sherif.");
    expect(out).toEqual([blackoutNotice("number", "your note 'garage'"), "Dinner is on Friday at Em Sherif."]);
  });

  it("a lookup's big numeric result costs little memory, and a long spelled list little time", () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    // A Read of an all-numeric file, 48 KB, as the CLI returns it: one run of thousands of numbers.
    const read = Array.from({ length: 1000 }, (_, i) => `${String(i + 1).padStart(6)}\t${Array.from({ length: 12 }, (_, j) => String((i * 13 + j * 7) % 1000)).join(",")}`).join("\n");
    expect(read.length).toBeGreaterThan(40_000);
    gc();
    const h0 = process.memoryUsage().heapUsed;
    const b = new BlackoutSources();
    b.add(read, "your file 'data'");
    const g = new ReplyGuard({ question: "What's in the data file?", sources: new GuardSources(), blackout: b });
    const t1 = performance.now();
    speak(g, "The first rows are 1, 2 and 3. Row 40 has 520, 527 and 534, sir.");
    expect(performance.now() - t1).toBeLessThan(500);
    gc();
    const grew = process.memoryUsage().heapUsed - h0;
    expect(grew, `${Math.round(grew / 1e6)} MB`).toBeLessThan(20e6);
    expect(g).toBeDefined(); // kept alive until measured
    // 2,000 comma-separated letters and digits in one sentence (a list read out): well under a second.
    const list = Array.from({ length: 2000 }, (_, i) => (i % 2 ? String(i % 10) : String.fromCharCode(97 + (i % 26)))).join(", ") + ".";
    const t0 = performance.now();
    speak(guardFor([["your note 'router'", "Router admin — admin / Qx7mB2pz"]], "q"), list);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("pieces too far apart, or a long number next to a piece, do not join", () => {
    const key = randomTaintKey();
    const taint = new TaintSet(key, taintEntries(key, "8 8 3 0"));
    const far = "You have 88 unread emails from the week, and the kids scored 30 points.";
    expect(speak(guardFor([["your note 'week'", "88 emails, 30 points."]], "How was the week?", taint), far)).toEqual([far]);
  });

  it("says ordinary answers: dates with years, amounts and measures with their unit, short numbers, the world's numbers", () => {
    const notes: Array<[string, string]> = [
      ["your note 'dentist'", "Dentist: Dr. Khoury, 8 October 16:00, filling 120 USD. Next check-up 2026-11-03."],
      ["your note 'lease'", "The lease is 1850 USD a month from March, 2 year term. Speed test: 94 Mbps down."],
      ["your note 'deck'", "Sam's board deck is due 2026-10-10, 18 slides; signed 14 October 2026."],
    ];
    const g = guardFor(notes, "Tell me about my week");
    for (const reply of ["The filling is 120 USD, on 8 October at 16:00.", "Your next check-up is on 2026-11-03.", "1850 USD a month from March, for 2 years.", "94 Mbps down.", "On 2026-10-10, 18 slides, signed 14 October 2026."]) expect(speak(g, reply), reply).toEqual([reply]);
  });

  it("his own number stays, as he said it", () => {
    const g = guardFor([["your note 'invoices'", "Invoice INV-7731 for 2,450 USD is due on 30 October."]], "When is invoice INV-7731 due?");
    expect(speak(g, "INV-7731 is due on 30 October.")).toEqual(["INV-7731 is due on 30 October."]);
  });

  it("the world summary is not a source: its numbers are said (only notes and lookups feed the blackout)", () => {
    const sources = new GuardSources();
    sources.add("Today: 15 sessions active, 1234 messages.");
    const g = new ReplyGuard({ question: "How busy was today?", sources, blackout: new BlackoutSources() });
    expect(speak(g, "1234 messages across 15 sessions today.")).toEqual(["1234 messages across 15 sessions today."]);
  });

  it("a number fragment waits for what follows, and a reply with nothing to withhold is said as it came", () => {
    const g = guardFor([["your note 'garage'", "The garage opens with 6093."]], "What's up?");
    expect(g.push("Six.")).toEqual([]);
    expect(g.push("Oh.")).toEqual([]);
    expect(g.push("Nine.")).toEqual([]);
    expect(g.push("Three.")).toEqual([]);
    expect(g.flush()).toEqual([blackoutNotice("number", "your note 'garage'")]);
    const h = guardFor([["your note 'dinner'", "Dinner for 4 on Friday."]], "Dinner?");
    expect(h.push("Four.")).toEqual([]);
    expect(h.push("On Friday, sir.")).toEqual(["Four.", "On Friday, sir."]);
  });

  it("an action's text is judged alone: a note's number or code in it is caught, his own is not", () => {
    const g = guardFor([["your note 'garage'", "The garage opens with 6093. Wifi key Qx7mB2pz."]], "Dispatch a note about 5512 to agent-world");
    expect(g.carries("Write 6093 on the garage card")).toBe(true);
    expect(g.carries("Set the wifi to Qx7mB2pz")).toBe(true);
    expect(g.carries("Fix the flaky test")).toBe(false);
    expect(g.carries("Look into 5512")).toBe(false);
  });

  it("without a blackout the guard is unchanged (sentence by sentence, its own notice)", () => {
    const sources = new GuardSources();
    sources.add("Garage: 6093");
    expect(ReplyGuard.text("It's 6093.", { question: "What's the garage code?", sources })).toBe(WITHHELD_SPOKEN);
  });

  it("the copy guard's intent now spans the whole conversation window", () => {
    const sources = new GuardSources();
    sources.add("Faqra chalet: 607, Georges has the spare.");
    const ctx = { question: "Read me the Faqra chalet note word for word.", sources };
    expect(ReplyGuard.text("Faqra chalet: 607.", ctx)).toBe("Faqra chalet: 607.");
    expect(ReplyGuard.text("Faqra chalet: 607.", { ...ctx, previous: ["What's the Faqra gate code?", "Who is Georges?"] })).toContain(WITHHELD_SPOKEN);
  });
});
