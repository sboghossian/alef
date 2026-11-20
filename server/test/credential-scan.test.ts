// The credential scanner over a fixture home (never the real vault): which files it closes, that
// it re-reads only what changed, that its reads are bounded, and that what it persists holds
// paths and reason classes, never a value.

import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createCredentialScanner, type CredentialScanner } from "../features/credential-scan.js";
import { scanText } from "../features/credential-scan-lib.js";
import { TIER_SPOKEN } from "../features/credential-taint-lib.js";

const CANARY = "CanaryPw7!x9";
let home = "";
let root = "";
let reads: string[] = [];
let taintReads: Array<[string, "values" | "recheck"]> = [];

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

function scanner(extra: { maxBytes?: number; cacheFile?: string } = {}): CredentialScanner {
  return createCredentialScanner({ home, roots: async () => [root], onRead: (p) => reads.push(p), onTaintRead: (p, why) => taintReads.push([p, why]), ...extra });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cred-scan-home-"));
  root = join(home, "Documents", "Code");
  reads = [];
  taintReads = [];
  await put(join(root, "vault", "family.md"), "Maya is his daughter, born September 2025.\n");
  await put(join(root, "vault", "flat.md"), `The Lisbon flat is in Achrafieh. Door code: ${CANARY}\n`);
  await put(join(root, "vault", "Notion wiki (old)", "Family [draft].md"), `# Family\n\nPasswordManager master code: ${CANARY}\n`);
  await put(join(root, "vault", "gym.md"), "purplewalrus is the gym password.\n");
  await put(join(root, "app", "src", "config.ts"), `export const password = "${CANARY}";\n`);
  await put(join(root, "app", "src", "types.ts"), "export interface User { password: string }\n");
  await put(join(root, "app", "node_modules", "pkg", "README.md"), `password: ${CANARY}\n`); // skipped folder: never read
  await put(join(root, "app", "data", "session.jsonl"), `{"text":"password: ${CANARY}"}\n`); // raw transcript: never read
  await put(join(root, "app", ".env"), `SECRET=${CANARY}\n`); // refused by class: never read
});

describe("credential scanner", () => {
  it("closes every file that holds a credential, with its reason classes, and nothing else", async () => {
    const s = scanner();
    const st = await s.sweep();
    expect(st.ready).toBe(true);
    const closed = s.excluded();
    expect(closed.map((e) => e.path.slice(root.length + 1)).sort()).toEqual(["app/src/config.ts", "vault/Notion wiki (old)/Family [draft].md", "vault/flat.md", "vault/gym.md"]);
    expect(closed.find((e) => e.path.endsWith("[draft].md"))?.reasons).toEqual(["password-manager"]);
    expect(st.byReason).toMatchObject({ "password-manager": 1, "access-code": 1, password: 2 });
    expect(reads.some((p) => p.includes("node_modules") || p.endsWith(".jsonl") || p.endsWith(".env"))).toBe(false);
    expect(s.isExcluded(join(root, "VAULT", "Flat.md"))).toBe(true); // the Mac's disk ignores case
    expect(s.isExcluded(join(root, "vault", "family.md"))).toBe(false);
  });

  it("re-reads only what changed, and follows an edit either way", async () => {
    const s = scanner();
    await s.sweep();
    reads = [];
    const again = await s.sweep();
    expect(again.lastSweepRead).toBe(0);
    expect(reads).toEqual([]);
    const fam = join(root, "vault", "family.md");
    await writeFile(fam, "Maya is his daughter. Her PIN: 4821.\n");
    await utimes(fam, new Date(), new Date(Date.now() + 5000));
    await writeFile(join(root, "vault", "gym.md"), "The gym opens at seven.\n");
    await s.sweep();
    expect(reads.map((p) => p.slice(root.length + 1)).sort()).toEqual(["vault/family.md", "vault/gym.md"]);
    expect(s.isExcluded(fam)).toBe(true);
    expect(s.isExcluded(join(root, "vault", "gym.md"))).toBe(false);
  });

  it("a verdict for one file is read on demand, then cached (once the taint exists); before it, a clean file fails closed", async () => {
    const s = scanner();
    const family = join(root, "vault", "family.md");
    expect((await s.verdict(join(root, "vault", "flat.md"))).excluded).toBe(true);
    // No sweep yet, so no taint to check it against: closed for now, and never cached either way.
    expect(await s.verdict(family)).toEqual({ excluded: true, reasons: ["unvetted"] });
    expect(s.isExcluded(family)).toBe(false);
    reads = [];
    await s.verdict(family);
    expect(reads).toEqual([family]);
    await s.sweep();
    reads = [];
    await s.verdict(join(root, "vault", "flat.md"));
    expect((await s.verdict(family)).excluded).toBe(false);
    expect(reads).toEqual([]);
    expect((await s.verdict(join(root, "vault", "missing.md"))).excluded).toBe(false);
  });

  it("reads are bounded: a file over the cap is closed unread", async () => {
    const big = join(root, "vault", "big.md");
    await writeFile(big, `${"harmless words ".repeat(2000)}\n`);
    const s = scanner({ maxBytes: 4096 });
    await s.sweep();
    expect(s.excluded().find((e) => e.path === big)?.reasons).toEqual(["unvetted"]);
    expect(reads).not.toContain(big);
  });

  it("a symlink to a file that holds a credential is closed under its own name too", async () => {
    await symlink(join(root, "vault", "flat.md"), join(root, "vault", "innocent-link.md"));
    const s = scanner();
    await s.sweep();
    expect(s.isExcluded(join(root, "vault", "innocent-link.md"))).toBe(true);
  });

  it("forgets a closed file once it is deleted", async () => {
    const s = scanner();
    await s.sweep();
    const { rm } = await import("node:fs/promises");
    await rm(join(root, "vault", "gym.md"));
    await s.sweep();
    expect(s.isExcluded(join(root, "vault", "gym.md"))).toBe(false);
  });

  it("persists paths, fingerprints and reason classes only, and a restart re-reads nothing", async () => {
    const cacheFile = join(home, "data", "credential-scan.json");
    const s = scanner({ cacheFile });
    await s.sweep();
    const raw = await readFile(cacheFile, "utf8");
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain("purplewalrus");
    expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);
    reads = [];
    taintReads = [];
    const restarted = scanner({ cacheFile });
    expect(await restarted.whenReady(1000)).toBe(true); // ready from the cache (and the taint rebuilt)
    expect(restarted.isExcluded(join(root, "vault", "flat.md"))).toBe(true);
    await restarted.sweep();
    expect(reads).toEqual([]);
    // The taint lives in memory only: a restart reads the closed files again for their values, and
    // every open file once for the values it repeats (who repeats what is counted in memory)…
    expect(taintReads.filter(([, why]) => why === "values").every(([p]) => restarted.isExcluded(p))).toBe(true);
    expect(taintReads.filter(([, why]) => why === "values").length).toBeGreaterThan(0);
    expect(taintReads.some(([p, why]) => why === "recheck" && p.endsWith("family.md"))).toBe(true);
    // …and a second sweep in the same process reads nothing.
    reads = [];
    taintReads = [];
    await restarted.sweep();
    expect(reads).toEqual([]);
    expect(taintReads).toEqual([]);
  });

  it("whenReady runs the first sweep, and reports a timeout honestly", async () => {
    const s = scanner();
    expect(s.status().ready).toBe(false);
    expect(await s.whenReady(10_000)).toBe(true);
    const slow = createCredentialScanner({ home, roots: () => new Promise<string[]>(() => undefined) });
    expect(await slow.whenReady(50)).toBe(false);
  });

  it("valuesOf reads a closed file's values into memory, for the spoken filter", async () => {
    const s = scanner();
    expect(await s.valuesOf(join(root, "vault", "gym.md"))).toContain("purplewalrus");
    expect(await s.valuesOf(join(root, "vault", "family.md"))).toEqual([]);
  });

  describe("value taint", () => {
    // An invented master code, in a closed page, then bare and cut short in two open ones.
    const MASTER = "Kx9Plum-44Travel-Zq81";
    const toStart = (): string => join(root, "vault", "notion-wiki", "To start.md");
    const travel = (): string => join(root, "vault", "notion-professional", "France Travail.md");
    const feedback = (): string => join(root, "vault", "notion-professional", "Feedback on Test AI.md");

    beforeEach(async () => {
      await put(toStart(), `# To start\n\nPasswordManager master code: ${MASTER}\n`);
      await put(travel(), `# France Travail\n\nDossier ${MASTER} envoyé le 12 mars, rendez-vous le 3 avril.\n`);
      await put(feedback(), "# Feedback on Test AI\n\nRan the test with Kx9Plum44Tr… yesterday, it went fine.\n");
    });

    it("a closed file's value, bare or cut to 8+ characters in another file, closes that file too", async () => {
      // The phrasing rules alone leave both copies open: nothing in them names a credential.
      for (const p of [travel(), feedback()]) expect(scanText(await readFile(p, "utf8"), p).reasons, p).toEqual([]);
      const s = scanner();
      const st = await s.sweep();
      expect(s.excluded().find((e) => e.path === toStart())?.reasons).toContain("password-manager");
      expect(s.excluded().find((e) => e.path === travel())?.reasons).toEqual(["tainted-value"]);
      expect(s.excluded().find((e) => e.path === feedback())?.reasons).toEqual(["tainted-value"]);
      expect(s.isExcluded(join(root, "vault", "family.md"))).toBe(false);
      expect(st.byReason["tainted-value"]).toBe(2);
      expect(st.taint.ready).toBe(true);
      expect(st.taint.sources).toBeGreaterThan(0);
    });

    it("a quiet re-sweep reads nothing again; a new value starts a census of every open file; a gone one reopens its copies", async () => {
      const s = createCredentialScanner({ home, roots: async () => [root], onRead: (p) => reads.push(p), onTaintRead: (p, why) => taintReads.push([p, why]), censusEveryMs: 0 });
      await s.sweep();
      taintReads = [];
      reads = [];
      const quiet = await s.sweep();
      expect(taintReads).toEqual([]);
      expect(reads).toEqual([]);
      expect(quiet.taint.lastRecheck?.files ?? 0).toBeGreaterThan(0); // from the first sweep
      // The master code changes: the old copies reopen, a file holding the new one closes.
      const NEXT = "Rw4Fig-19Ocean-Lp07";
      await writeFile(toStart(), `# To start\n\nPasswordManager master code: ${NEXT}\n`);
      await utimes(toStart(), new Date(), new Date(Date.now() + 5000));
      await put(join(root, "vault", "old-list.md"), `Things to keep: ${NEXT}\n`);
      taintReads = [];
      const after = await s.sweep();
      expect(s.isExcluded(travel())).toBe(false);
      expect(s.isExcluded(feedback())).toBe(false);
      expect(s.excluded().find((e) => e.path.endsWith("old-list.md"))?.reasons).toEqual(["tainted-value"]);
      expect(after.taint.lastRecheck?.full).toBe(true); // it gained a value: a census of every open file
      expect(taintReads.some(([p, why]) => why === "recheck" && p.endsWith("family.md"))).toBe(true);
    });

    it("between two censuses, a new value closes a new copy at once, and a cached copy when it is asked about", async () => {
      const s = scanner(); // the default: at most one census every 6 hours
      await s.sweep();
      const NEXT = "Rw4Fig-19Ocean-Lp07";
      const fam = join(root, "vault", "family.md");
      // family.md held the next code before anyone knew it was one (cached as open)…
      await writeFile(fam, `Maya is his daughter. Ref ${NEXT}.\n`);
      await utimes(fam, new Date(), new Date(Date.now() + 5000));
      await s.sweep();
      expect(s.isExcluded(fam)).toBe(false);
      // …then the master code changes to it, and a new note copies it.
      await writeFile(toStart(), `# To start\n\nPasswordManager master code: ${NEXT}\n`);
      await utimes(toStart(), new Date(), new Date(Date.now() + 10_000));
      await put(join(root, "vault", "old-list.md"), `Things to keep: ${NEXT}\n`);
      taintReads = [];
      const after = await s.sweep();
      expect(after.taint.lastRecheck?.full).toBe(false); // no census yet
      expect(s.isExcluded(join(root, "vault", "old-list.md"))).toBe(true); // read by this walk: checked again
      expect(s.isExcluded(travel())).toBe(false); // the old code is gone: its copies reopen
      expect(s.isExcluded(fam)).toBe(false); // cached open, not read again…
      expect(after.taint.pending).toBeGreaterThan(0);
      expect(await s.verdict(fam)).toEqual({ excluded: true, reasons: ["tainted-value"] }); // …until it is asked about
      expect(taintReads.filter(([, why]) => why === "recheck").length).toBeLessThan(5);
    });

    it("a closed file that changed while the server was down: the restart re-checks every clean file", async () => {
      const cacheFile = join(home, "data", "credential-scan.json");
      await scanner({ cacheFile }).sweep();
      const raw = await readFile(cacheFile, "utf8");
      expect(raw).not.toContain(MASTER);
      expect(raw).not.toMatch(/kx9plum/i);
      const NEXT = "Rw4Fig-19Ocean-Lp07";
      await writeFile(toStart(), `# To start\n\nPasswordManager master code: ${NEXT}\n`);
      await utimes(toStart(), new Date(), new Date(Date.now() + 5000));
      await put(join(root, "vault", "old-list.md"), `Things to keep: ${NEXT}\n`);
      const restarted = scanner({ cacheFile });
      await restarted.sweep();
      expect(restarted.isExcluded(join(root, "vault", "old-list.md"))).toBe(true);
      expect(restarted.isExcluded(travel())).toBe(false);
    });

    it("a value more open files repeat than the cap is nobody's secret: it closes none of them and is never withheld", async () => {
      // An invented "value" the rules take from a closed file, that 5 open files also hold (a code
      // identifier, a URL fragment): with a cap of 3 it closes nothing; the master code still does.
      const COMMONISH = "fetchUserProfile42";
      await put(join(root, "vault", "creds-note.md"), `password: ${COMMONISH}\n`);
      for (let i = 0; i < 5; i++) await put(join(root, "vault", "code", `f${i}.md`), `We call ${COMMONISH} here (${i}).\n`);
      const s = createCredentialScanner({ home, roots: async () => [root], commonFiles: 3 });
      const st = await s.sweep();
      expect(s.isExcluded(join(root, "vault", "creds-note.md"))).toBe(true); // by the rules
      for (let i = 0; i < 5; i++) expect(s.isExcluded(join(root, "vault", "code", `f${i}.md`)), `f${i}`).toBe(false);
      expect(s.isExcluded(travel())).toBe(true);
      expect(s.isExcluded(feedback())).toBe(true);
      expect(st.taint.common).toBeGreaterThan(0);
      expect(st.taint.repeating).toBe(2); // France Travail and Feedback: files that repeat only common values are not kept
      expect(s.taint()?.textHit(`call ${COMMONISH}`, TIER_SPOKEN)).toBe(false);
      expect(s.taint()?.textHit(MASTER, TIER_SPOKEN)).toBe(true);
      // Down to 3 copies: common until the next census counts again (here, the next process's).
      for (const i of [3, 4]) await rm(join(root, "vault", "code", `f${i}.md`));
      await s.sweep();
      expect(s.isExcluded(join(root, "vault", "code", "f0.md"))).toBe(false);
      const next = createCredentialScanner({ home, roots: async () => [root], commonFiles: 3 });
      await next.sweep();
      for (let i = 0; i < 3; i++) expect(next.isExcluded(join(root, "vault", "code", `f${i}.md`)), `f${i}`).toBe(true);
    });

    it("a cache made under other rules: its closed files feed a provisional taint before the walk, and its taint-only closures stay closed", async () => {
      const cacheFile = join(home, "data", "credential-scan.json");
      await scanner({ cacheFile }).sweep();
      const o = JSON.parse(await readFile(cacheFile, "utf8")) as { v: string };
      o.v = "an-older-rules-version"; // a rules bump: nothing of the cache is trusted as is
      await writeFile(cacheFile, JSON.stringify(o));
      const log: string[] = [];
      // A copy the old rules never saw closed (its source is closed only by a rule the new version
      // adds, simulated here as a page the cache does not list): during the first walk, with only a
      // provisional taint, a rules-clean file is never let through.
      const copy = join(root, "vault", "copy-of-new.md");
      await put(copy, "A note that holds nothing but ordinary words.\n");
      const seen: { during?: { vetted: boolean; taint: boolean; verdict: Promise<unknown> }; walking: boolean } = { walking: false };
      const next: CredentialScanner = createCredentialScanner({
        home,
        roots: async () => [root],
        cacheFile,
        concurrency: 1,
        onRead: (p) => {
          log.push(`read ${p}`);
          if (seen.walking) seen.during ??= { vetted: next.vetted(), taint: next.taint() !== null, verdict: next.verdict(copy) };
        },
        onTaintRead: (p, why) => log.push(`${why} ${p}`),
      });
      // Before the new rules' first walk: the bare copy is still closed, and a clean file fails closed.
      expect(await next.verdict(travel())).toEqual({ excluded: true, reasons: ["tainted-value"] });
      expect((await next.verdict(join(root, "vault", "family.md"))).reasons).toEqual(["unvetted"]);
      log.length = 0;
      seen.walking = true;
      await next.sweep();
      // The closed master-code page was read for its values before the walk read any file.
      const firstValues = log.findIndex((l) => l === `values ${toStart()}`);
      const firstRead = log.findIndex((l) => l.startsWith("read "));
      expect(firstValues).toBeGreaterThanOrEqual(0);
      expect(firstValues).toBeLessThan(firstRead);
      expect(next.isExcluded(travel())).toBe(true);
      expect(next.isExcluded(feedback())).toBe(true);
      expect(next.isExcluded(join(root, "vault", "family.md"))).toBe(false);
      expect(seen.during).toBeDefined();
      expect(seen.during?.taint).toBe(true); // the provisional taint is in place during the walk…
      expect(seen.during?.vetted).toBe(false); // …but it vets nothing
      expect(await seen.during?.verdict).toEqual({ excluded: true, reasons: ["unvetted"] });
      expect(next.vetted()).toBe(true);
      expect(await next.verdict(copy)).toEqual({ excluded: false, reasons: [] });
    });

    it("a master code copied into more files than the cap is still his master code, and copies of one file count once", async () => {
      // Six open copies, every one different: over a cap of 3, yet a password manager's value.
      for (let i = 0; i < 6; i++) await put(join(root, "vault", "copies", `c${i}.md`), `Copy ${i}: ${MASTER} (${"x".repeat(i)}).\n`);
      const s = createCredentialScanner({ home, roots: async () => [root], commonFiles: 3 });
      await s.sweep();
      for (let i = 0; i < 6; i++) expect(s.isExcluded(join(root, "vault", "copies", `c${i}.md`)), `c${i}`).toBe(true);
      expect(s.taint()?.textHit(MASTER, TIER_SPOKEN)).toBe(true);
      // A value the rules took from an ordinary closed file, in 5 checkouts of ONE file: one copy,
      // not five, so it is not common and still closes them.
      const VALUE = "fetchUserProfile42";
      await put(join(root, "vault", "creds-note.md"), `password: ${VALUE}\n`);
      for (let i = 0; i < 5; i++) await put(join(root, `checkout-${i}`, "src", "api.md"), `We call ${VALUE} here.\n`);
      const t = createCredentialScanner({ home, roots: async () => [root], commonFiles: 3 });
      await t.sweep();
      for (let i = 0; i < 5; i++) expect(t.isExcluded(join(root, `checkout-${i}`, "src", "api.md")), `checkout-${i}`).toBe(true);
    });

    it("a verdict between sweeps checks a changed file against the taint", async () => {
      const s = scanner();
      await s.sweep();
      const fam = join(root, "vault", "family.md");
      await writeFile(fam, `Maya is his daughter. Ref ${MASTER.toLowerCase()}.\n`);
      await utimes(fam, new Date(), new Date(Date.now() + 5000));
      expect(await s.verdict(fam)).toEqual({ excluded: true, reasons: ["tainted-value"] });
    });
  });
});

// An iCloud-evicted file keeps its size, mtime and inode, so its fingerprint is unchanged -- which
// is exactly why the recheck path has to test isDataless itself rather than trusting the change
// check. Reading one blocks in pread until iCloud produces the bytes, holding a libuv threadpool
// slot; four of those starved every DNS lookup in the live server and took the Jev router down.
// A sparse file is the same stat shape (size > 0, blocks === 0) and needs no iCloud to reproduce.
describe("an evicted (dataless) file is never read", () => {
  // A whole millisecond, so restoring it after the truncate round-trips exactly: the filesystem
  // keeps nanoseconds and a real mtime carries a fraction that utimes(Date) would drop, which would
  // change the fingerprint and let the recheck skip on its change check instead of on isDataless.
  const STAMP = new Date(1_700_000_000_000);

  /** Punches out the bytes in place: same inode, same size, no blocks. */
  async function evict(path: string): Promise<void> {
    const before = await stat(path);
    const fh = await open(path, "r+");
    try {
      await fh.truncate(0);
      await fh.truncate(before.size);
    } finally {
      await fh.close();
    }
    await utimes(path, STAMP, STAMP);
    const after = await stat(path);
    // Guard the guard: if any of these drifted, the recheck would skip on the change check instead
    // and the test would pass without exercising isDataless at all.
    expect(after.blocks).toBe(0);
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }

  it("is not re-read by the taint recheck, and stays closed", async () => {
    const cacheFile = join(home, "data", "credential-scan.json");
    const fam = join(root, "vault", "family.md");
    await utimes(fam, STAMP, STAMP); // pin it before the sweep records the fingerprint
    const first = scanner({ cacheFile });
    await first.sweep();
    expect(first.isExcluded(fam)).toBe(false); // clean, so the recheck is what would read it

    await evict(fam);
    reads = [];
    taintReads = [];

    const restarted = scanner({ cacheFile });
    expect(await restarted.whenReady(1000)).toBe(true);
    await restarted.sweep();

    expect(taintReads.some(([p, why]) => why === "recheck" && p === fam)).toBe(false);
    expect(reads).not.toContain(fam);
    // Other files are still rechecked: the skip is this file, not the pass.
    expect(taintReads.length).toBeGreaterThan(0);
  });
});
