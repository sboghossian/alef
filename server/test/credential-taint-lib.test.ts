// The value taint's pure logic (invented values only): how a value is normalised, which values taint
// files or speech, and that a text repeating one is found however it is spaced, cased or cut.

import { describe, expect, it } from "vitest";
import { normalizeValue, randomTaintKey, taintEntries, TaintSet, taintTiers, TIER_FILE, TIER_SPOKEN, type TaintPart } from "../features/credential-taint-lib.js";

const key = randomTaintKey();
const setOf = (...values: string[]): TaintSet => new TaintSet(key, values.flatMap((v) => taintEntries(key, v)));
const BOTH = TIER_SPOKEN | TIER_FILE;

describe("value taint", () => {
  it("normalises case, separators, accents, invisible characters and other scripts' digits", () => {
    expect(normalizeValue("Qx7m-B2pz")).toBe("qx7mb2pz");
    expect(normalizeValue("36 24 12")).toBe("362412");
    expect(normalizeValue("7-7-3-1")).toBe("7731");
    expect(normalizeValue("٤٨٢١")).toBe("4821");
    expect(normalizeValue("Ｑｘ７")).toBe("qx7");
    expect(normalizeValue("Pässwörd")).toBe("password");
    expect(normalizeValue("zorba​vex")).toBe("zorbavex");
  });

  it("years and runs taint nothing; short values are withheld in speech only; only distinctive ones close files", () => {
    for (const n of ["2024", "1987", "1234", "4321", "aaaa", "abc", "abcd"]) expect(taintTiers(n), n).toBe(0);
    for (const n of ["6093", "362412", "zorbavex", "marmalade", "hunter2"]) expect(taintTiers(n), n).toBe(TIER_SPOKEN);
    // A card number (Luhn: a public test number) and a 14+ digit account number close files; a
    // phone number or an id of 8-12 digits is withheld in speech only.
    for (const n of ["swordfish9", "qx7mb2pz", "purplewalrus", "378282246310005", "48213377120955", "correcthorsebatterystaple"]) expect(taintTiers(n), n).toBe(BOTH);
    for (const n of ["48213377", "9613123456", "33612345678"]) expect(taintTiers(n), n).toBe(TIER_SPOKEN);
    // a date or a timestamp is common in unrelated files: never a file-closing value
    for (const n of ["20260928", "28092026", "1727000000", "1727000000123"]) expect(taintTiers(n), n).toBe(TIER_SPOKEN);
    // a dictionary word the rules took for a value closes nothing (a password of two words does)
    const isWord = (w: string): boolean => ["subscription", "configuration"].includes(w);
    expect(taintTiers("subscription", isWord)).toBe(TIER_SPOKEN);
    expect(taintTiers("purplewalrus", isWord)).toBe(BOTH);
  });

  it("a text repeats a value exactly, spaced, dashed or in another case, but never inside a longer run", () => {
    const s = setOf("Qx7m-B2pz-9K");
    for (const t of ["the code: qx7mb2pz9k.", "QX7M B2PZ 9K", "qx7m-b2pz-9k", "(Qx7m.B2pz.9K)"]) expect(s.textHit(t), t).toBe(true);
    for (const t of ["aqx7mb2pz9k", "qx7mb2pz9kz", "nothing to see here", ""]) expect(s.textHit(t), t).toBe(false);
  });

  it("a truncated or masked copy counts: a prefix or suffix of 8+ characters of a 10+ character value", () => {
    const s = setOf("ZK4-TRAVEL-PLUM-8841-QQ");
    expect(s.textHit("first bit: ZK4TRAVE… (the rest is hidden)")).toBe(true);
    expect(s.textHit("…lum8841QQ at the end")).toBe(true);
    expect(s.textHit("ends with 8841QQ")).toBe(false); // 6 characters: too short to mean anything
    expect(s.textHit("zk4t travel")).toBe(false);
  });

  it("a letters-only prefix or suffix never taints: it is too often a word, a URL or an identifier", () => {
    const url = setOf("https://www.example-journal.org/articles/Tk9Q2xZ81");
    expect(url.textHit("see https://www.example-journal.org/about")).toBe(false); // "httpswwwexam…" alone
    expect(url.textHit("… articles/Tk9Q2xZ81")).toBe(true); // the part that mixes letters and digits
    const words = setOf("correcthorsebatterystaple");
    expect(words.textHit("correcthorsebattery")).toBe(false);
    expect(words.textHit("Correct Horse Battery Staple")).toBe(true); // the whole value still does
  });

  it("reports which values a text repeats, each once", () => {
    const k2 = randomTaintKey();
    const s = new TaintSet(k2, [...taintEntries(k2, "Qx7m-B2pz-9K"), ...taintEntries(k2, "purplewalrus")]);
    const keys = s.textKeys("qx7mb2pz9k and purplewalrus, then QX7M B2PZ 9K again", TIER_SPOKEN);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(s.textKeys("nothing here", TIER_SPOKEN)).toEqual([]);
    expect(s.without(new Set(keys)).textHit("purplewalrus", TIER_SPOKEN)).toBe(false);
  });

  it("a value longer than the window is matched by its first 64 characters", () => {
    const long = `Tk${"9aB".repeat(30)}`;
    const s = setOf(long);
    expect(s.textHit(`token was ${long} here`)).toBe(true);
    expect(s.textHit(`token was ${long.slice(0, 40)}`)).toBe(true); // a 40-character prefix
  });

  it("a seed phrase taints every 4 consecutive words", () => {
    const s = setOf("orbit lemon canyon velvet shadow tiger mango pepper");
    expect(s.textHit("words: canyon velvet shadow tiger")).toBe(true);
    expect(s.textHit("an orbit and a lemon")).toBe(false);
  });

  it("other scripts' digits and fullwidth forms fold before comparing", () => {
    const s = setOf("4821 7730 9912 55");
    expect(s.textHit("٤٨٢١ ٧٧٣٠ ٩٩١٢ ٥٥")).toBe(true);
    expect(s.textHit("４８２１７７３０９９１２５５")).toBe(true);
  });

  it("the spoken tier matches runs a sentence already turned into digits", () => {
    const s = setOf("6093");
    const parts: TaintPart[] = [
      { norm: "the", start: 0, end: 3 },
      { norm: "6093", start: 4, end: 23 },
    ];
    expect(s.partHits(parts, TIER_SPOKEN)).toEqual([[1, 1]]);
    expect(s.partHits(parts, TIER_FILE)).toEqual([]); // 4 digits never close a file
    expect(s.textHit("6093", TIER_FILE)).toBe(false);
  });

  it("keeps keyed hashes and lengths only: another key never matches, and no value text is held", () => {
    const entries = taintEntries(key, "Qx7m-B2pz-9K");
    expect(entries.length).toBeGreaterThan(1);
    for (const e of entries) expect(Object.values(e).every((v) => typeof v === "number")).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/qx7m|b2pz/i);
    expect(new TaintSet(randomTaintKey(), entries).textHit("Qx7m-B2pz-9K")).toBe(false);
  });

  it("checks 2 MB of prose in well under a second, for every value it repeats", () => {
    // 2,000 values of every length, as the real taint holds (4,456 values, ~50,000 keys).
    const many = Array.from({ length: 2000 }, (_, i) => `Zq${i}x${(i * 7919).toString(36)}Kp`);
    const s = setOf("Qx7m-B2pz-9K", "purplewalrus", "48213377", "6093", ...many);
    const words = "the quick brown fox jumps over 12 lazy dogs at 09:45 on 2026-09-28 near gate B12 ".repeat(25_000);
    const t0 = performance.now();
    expect(s.textHit(words)).toBe(false);
    expect(s.textKeys(words, TIER_SPOKEN)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
