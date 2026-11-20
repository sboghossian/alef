import { describe, expect, it } from "vitest";
import { VOICE_REMEMBER_MAX_BODY } from "../../shared/features/voice-brain.js";
import { checkMemoryNote, holdsCredential, REMEMBER_CREDENTIAL, stagingEntry } from "../features/voice-remember-lib.js";

describe("checkMemoryNote (voice memory write-back)", () => {
  it("a plain fact is kept, whitespace flattened, a title derived when none is given", () => {
    expect(checkMemoryNote("  Doremi  ", "Doremi Touch demo\nis on Thursday.")).toEqual({ ok: true, note: { title: "Doremi", body: "Doremi Touch demo is on Thursday." } });
    const r = checkMemoryNote(undefined, "Leila prefers the morning flight to Lisbon");
    expect(r).toEqual({ ok: true, note: { title: "Leila prefers the morning flight to", body: "Leila prefers the morning flight to Lisbon" } });
  });
  it("refuses empty, over-long and non-string input", () => {
    expect(checkMemoryNote("t", "  ").ok).toBe(false);
    expect(checkMemoryNote("t", 42).ok).toBe(false);
    expect(checkMemoryNote("t", "word ".repeat(200)).ok).toBe(false);
    // capped so the whole note is read back inside the 30 s yes window
    expect(checkMemoryNote("t", "a".repeat(VOICE_REMEMBER_MAX_BODY)).ok).toBe(true);
    expect(checkMemoryNote("t", "a".repeat(VOICE_REMEMBER_MAX_BODY + 1)).ok).toBe(false);
  });
  it.each([
    "the wifi password is marmalade",
    "my door code is 7731, remember it",
    "github token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "the safe opens with hunter22",
    "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
  ])("never stages a credential: %s", (body) => {
    expect(holdsCredential(body)).toBe(true);
    expect(checkMemoryNote("note", body)).toEqual({ ok: false, text: REMEMBER_CREDENTIAL });
  });
  it("a credential in the title is refused too", () => {
    expect(checkMemoryNote("password hunter22", "for the garage").ok).toBe(false);
  });
  it("ordinary numbers, dates and ticket ids pass", () => {
    for (const body of ["TICK-2520 has 12 projects since 13 Oct", "Portugal trip ends end of July 2026", "the call is at 11:00 Lisbon"]) expect(checkMemoryNote("n", body).ok).toBe(true);
  });
  it("the staged entry is a dated section that says it is not in memory", () => {
    const e = stagingEntry({ title: "Doremi", body: "Demo Thursday." }, new Date("2026-10-14T09:00:00Z"));
    expect(e).toBe("\n## Doremi\n\n_staged by Alef (voice) 2026-10-14T09:00:00.000Z; not in memory until you move it_\n\nDemo Thursday.\n");
  });
});
