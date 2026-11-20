// Jev's kept web trips (recall/jev-web.ts): the line websearch.ts appends, the log read back as a
// small index, and the nets a find passes before any prompt sees it. Web text is untrusted: every
// URL below that is not http(s), every control character and every credential-shaped value must
// stay out. Key-shaped values are built at runtime, so no key literal sits in this file.

import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomTaintKey, taintEntries, TaintSet } from "../features/credential-taint-lib.js";
import { appendJevWeb, citableFinds, findAge, JevWebLog, jevWebLine, jevWebLogFor, parseJevWeb, WITHHELD_QUESTION } from "../features/recall/jev-web.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "agent-world-jev-web-"));
  dirs.push(d);
  return d;
}

function alnum(seed: string, n: number): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; out.length < n; i++) out += [...createHash("sha512").update(`${seed}#${i}`).digest()].map((b) => abc[b % abc.length]).join("");
  return out.slice(0, n);
}
const GITHUB = ["gh", "p_", alnum("github", 36)].join("");
const AT = new Date("2026-09-29T10:00:00.000Z");

describe("jevWebLine", () => {
  it("keeps http(s) hits only, one clean line each, at most 5", () => {
    const line = jevWebLine(AT, "  claude code\nhooks  ", [
      { title: "Hooks\u0000 reference docs", url: "https://docs.anthropic.com/en/hooks" },
      { title: "evil", url: "javascript:alert(1)" },
      { title: "local", url: "file:///etc/passwd" },
      { title: "", url: "http://x.test/a" },
      { title: "spaces", url: "https://x.test/a b" },
      ...Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, url: `https://a.test/${i}` })),
    ]);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    const [e] = parseJevWeb(line);
    expect(e).toEqual({
      at: "2026-09-29T10:00:00.000Z",
      question: "claude code hooks",
      hits: [
        { title: "Hooks reference docs", url: "https://docs.anthropic.com/en/hooks" },
        { title: "http://x.test/a", url: "http://x.test/a" },
        { title: "t0", url: "https://a.test/0" },
        { title: "t1", url: "https://a.test/1" },
        { title: "t2", url: "https://a.test/2" },
      ],
    });
  });

  it("drops a hit that carries a credential, and withholds a question that does", () => {
    const line = jevWebLine(AT, `why does ${GITHUB} fail`, [
      { title: "leaky", url: `https://x.test/?token=${GITHUB}` },
      { title: "fine", url: "https://y.test/" },
    ]);
    expect(line).not.toContain(GITHUB);
    const [e] = parseJevWeb(line);
    expect(e!.question).toBe(WITHHELD_QUESTION);
    expect(e!.hits.map((h) => h.title)).toEqual(["fine"]);
  });
});

describe("parseJevWeb", () => {
  it("skips torn and hand-edited lines, and re-checks every hit on the way out", () => {
    const text = [
      jevWebLine(AT, "a", [{ title: "A", url: "https://a.test/" }]).trim(),
      '{"at":"2026-09-29T10:01:00Z","question":"b","hits":[{"title":"B","url":"javascript:alert(1)"},{"title":"<b>C</b>","url":"https://c.test/"}]}',
      '{"at":"not a date","question":"x","hits":[]}',
      '{"at":"2026-09-29T10:02:00Z","question":"torn","hi',
      "",
    ].join("\n");
    const out = parseJevWeb(text);
    expect(out.map((e) => [e.question, e.hits.map((h) => h.url)])).toEqual([
      ["a", ["https://a.test/"]],
      ["b", ["https://c.test/"]],
    ]);
  });
});

describe("JevWebLog", () => {
  it("reads EXISTING kept trips, then sees a new one appended after it was read", async () => {
    const d = await tmp();
    const path = join(d, "jev-web.jsonl");
    await appendJevWeb(path, new Date("2026-09-20T10:00:00Z"), "firecrawl pricing plans", [{ title: "Pricing · Firecrawl", url: "https://firecrawl.dev/pricing" }]);
    const log = new JevWebLog(path);
    await log.refresh();
    expect(log.stats()).toEqual({ trips: 1, since: "2026-09-20T10:00:00.000Z", last: "2026-09-20T10:00:00.000Z" });

    await appendJevWeb(path, new Date("2026-09-29T10:00:00Z"), "claude code hooks reference", [
      { title: "Hooks reference", url: "https://docs.anthropic.com/en/hooks" },
      { title: "Pricing · Firecrawl", url: "https://firecrawl.dev/pricing" },
    ]);
    await log.refresh();
    expect(log.stats().trips).toBe(2);
    const hooks = log.search("how do claude code hooks work", 3);
    expect(hooks[0]).toMatchObject({ url: "https://docs.anthropic.com/en/hooks", host: "docs.anthropic.com", question: "claude code hooks reference" });
    expect(hooks[0]!.matched).toBeGreaterThanOrEqual(3);
    // One find per URL: the latest search that found it.
    const pricing = log.search("firecrawl pricing", 3);
    expect(pricing.filter((f) => f.url === "https://firecrawl.dev/pricing")).toHaveLength(1);
    expect(pricing[0]!.at).toBe("2026-09-29T10:00:00.000Z");
    expect(log.search("garage door opener", 3)).toEqual([]);
    // "code" alone matches: one word, which is why a prompt cites only a find matching 2 or more.
    expect(log.search("garage door code", 3).every((f) => f.matched === 1)).toBe(true);
  });

  it("a missing or unreadable-then-torn file is empty, never a throw", async () => {
    const d = await tmp();
    const log = new JevWebLog(join(d, "nope.jsonl"));
    await log.refresh();
    expect(log.stats()).toEqual({ trips: 0, since: null, last: null });
    await writeFile(join(d, "nope.jsonl"), '{"at":"2026-09-29T10:00:00Z","question":"q","hits":[');
    await log.refresh();
    expect(log.stats().trips).toBe(0);
    await appendFile(join(d, "nope.jsonl"), "\n");
    await log.refresh();
    expect(log.search("q", 3)).toEqual([]);
  });

  it("one reader per data dir, none for an in-memory db", async () => {
    const d = await tmp();
    expect(jevWebLogFor(join(d, "world.db"))).toBe(jevWebLogFor(join(d, "world.db")));
    expect(jevWebLogFor(join(d, "world.db"))?.path).toBe(join(d, "jev-web.jsonl"));
    expect(jevWebLogFor(":memory:")).toBeNull();
  });
});

describe("citableFinds", () => {
  const find = (title: string, url: string, matched = 3) => ({ title, url, host: new URL(url).hostname, question: "q", at: "2026-09-29T10:00:00.000Z", score: 1, matched });

  it("no taint (the scanner has not vetted his files): nothing is cited", () => {
    expect(citableFinds([find("Hooks", "https://a.test/")], null, 1, 3)).toEqual([]);
  });

  it("drops a find that repeats a closed file's value, and one that matched too few words", () => {
    const key = randomTaintKey();
    const taint = new TaintSet(key, taintEntries(key, "Qx7m-B2pz-9K"));
    const out = citableFinds([find("Why QX7M B2PZ 9K fails", "https://a.test/"), find("Weak", "https://b.test/", 1), find("Hooks", "https://c.test/")], taint, 2, 3);
    expect(out.map((f) => f.title)).toEqual(["Hooks"]);
  });

  it("ages carry no 4-digit year for the number blackout", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(findAge("2026-09-29T08:00:00Z", now)).toBe("today");
    expect(findAge("2026-09-28T11:00:00Z", now)).toBe("yesterday");
    expect(findAge("2026-09-20T12:00:00Z", now)).toBe("9 days ago");
  });
});

describe("appendJevWeb", () => {
  it("makes the data dir and appends one line per search", async () => {
    const d = await tmp();
    const path = join(d, "data", "jev-web.jsonl");
    await appendJevWeb(path, AT, "a", []);
    await appendJevWeb(path, AT, "b", [{ title: "B", url: "https://b.test/" }]);
    const text = await readFile(path, "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
  });
});
