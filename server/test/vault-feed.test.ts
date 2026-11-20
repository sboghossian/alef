import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VaultMeta } from "../../shared/features/vault.js";
import type { RunningServer } from "../index.js";
import { createVaultFeature } from "../features/vault.js";
import {
  EMPTY_META,
  parseDate,
  parseManifest,
  parseMentions,
  parseRow,
  parseShard,
  parseUp,
  vaultFeedDir,
  VaultFeedReader,
} from "../features/vault-feed.js";
import { bootTestServer } from "./helpers.js";

// A row as the vault's builder writes it: 12 tab-separated fields.
function row(fields: readonly string[]): string {
  const f = [...fields];
  while (f.length < 12) f.push("");
  return f.join("\t");
}

describe("parseDate", () => {
  it("reads a plain date as whole days since the epoch", () => {
    expect(parseDate("1970-01-01")).toEqual([0, null]);
    expect(parseDate("1970-01-02")).toEqual([1, null]);
    // 2026-10-26, the day this was written.
    expect(parseDate("2026-10-26")).toEqual([Math.floor(Date.parse("2026-10-26T00:00:00Z") / 86_400_000), null]);
  });

  it("reads the local hour the builder appends as THH", () => {
    expect(parseDate("2026-01-19T14")[1]).toBe(14);
    expect(parseDate("2026-01-19T00")[1]).toBe(0);
    expect(parseDate("2026-01-19T23")[1]).toBe(23);
  });

  it("refuses an out-of-range or malformed hour without losing the date", () => {
    const [day, hour] = parseDate("2026-01-19T99");
    expect(day).not.toBeNull();
    expect(hour).toBeNull();
    expect(parseDate("2026-01-19Txx")[1]).toBeNull();
  });

  it("returns nulls for anything that is not a date", () => {
    expect(parseDate("")).toEqual([null, null]);
    expect(parseDate("not-a-date")).toEqual([null, null]);
    expect(parseDate("2026-13")).toEqual([null, null]);
    expect(parseDate("20261026")).toEqual([null, null]);
  });
});

describe("parseMentions", () => {
  it("reads the total/last/weeks triple", () => {
    const m = parseMentions("7;2026-10-20;2960:3,2961:4");
    expect(m.mentionLast).toBe(Math.floor(Date.parse("2026-10-20T00:00:00Z") / 86_400_000));
    expect(m.mentionWeeks?.get(2960)).toBe(3);
    expect(m.mentionWeeks?.get(2961)).toBe(4);
    expect(m.mentionWeeks?.size).toBe(2);
  });

  it("marks a note as an entity even when no week parses", () => {
    // An empty map still means "this is a person or company note"; null means "it is not one".
    const m = parseMentions("0;;");
    expect(m.mentionWeeks).not.toBeNull();
    expect(m.mentionWeeks?.size).toBe(0);
    expect(m.mentionLast).toBeNull();
  });

  it("leaves a non-entity note with no mention data at all", () => {
    expect(parseMentions("")).toEqual({ mentionWeeks: null, mentionLast: null });
  });

  it("drops junk pairs and non-positive counts", () => {
    const m = parseMentions("3;2026-01-01;abc,2960:0,2961:-2,2962:5,nocolon");
    expect([...(m.mentionWeeks ?? [])]).toEqual([[2962, 5]]);
  });
});

describe("parseUp", () => {
  it("splits id and rule, and refuses anything without both", () => {
    expect(parseUp("abc1234:broader")).toEqual({ up: "abc1234", upRule: "broader" });
    expect(parseUp("")).toEqual({ up: null, upRule: "" });
    expect(parseUp(":home")).toEqual({ up: null, upRule: "" });
    expect(parseUp("abc1234")).toEqual({ up: null, upRule: "" });
  });
});

describe("parseRow", () => {
  it("reads every field of a real-shaped row", () => {
    const note = parseRow(
      row([
        "003t8gq",
        "40-Resources/notion/notion-about-yalla-loubnan.md",
        "n",
        "resource",
        "2026-01-19T09",
        "yalla",
        "side",
        "resource/notion,other",
        "1yz9thm,itwp6em",
        "Some Missing Note",
        "4;2026-01-19;2922:4",
        "45",
        "k2bq7ze:topic",
      ]),
    );
    expect(note).not.toBeNull();
    expect(note?.id).toBe("003t8gq");
    expect(note?.kind).toBe("n");
    expect(note?.type).toBe("resource");
    expect(note?.hour).toBe(9);
    expect(note?.project).toBe("yalla");
    expect(note?.umbrella).toBe("side");
    expect(note?.tags).toEqual(["resource/notion", "other"]);
    expect(note?.links).toEqual(["1yz9thm", "itwp6em"]);
    expect(note?.ghosts).toEqual(["Some Missing Note"]);
    expect(note?.minutes).toBe(45);
    expect(note?.mentionWeeks?.get(2922)).toBe(4);
    expect(note?.up).toBe("k2bq7ze");
    expect(note?.upRule).toBe("topic");
  });

  it("reads a 12-field row from a feed built before the climb column", () => {
    const old = parseRow(row(["i", "p.md", "n"]));
    expect(old?.up).toBeNull();
    expect(old?.upRule).toBe("");
  });

  it("treats kind 'a' as an attachment and anything else as a note", () => {
    expect(parseRow(row(["i", "p.png", "a"]))?.kind).toBe("a");
    expect(parseRow(row(["i", "p.md", "n"]))?.kind).toBe("n");
    expect(parseRow(row(["i", "p.md", ""]))?.kind).toBe("n");
  });

  it("drops a row with no id or no path, and tolerates a short row", () => {
    expect(parseRow("")).toBeNull();
    expect(parseRow("\tpath.md")).toBeNull();
    expect(parseRow("id")).toBeNull();
    const short = parseRow("id\tpath.md");
    expect(short?.day).toBeNull();
    expect(short?.tags).toEqual([]);
    expect(short?.minutes).toBeNull();
    expect(short?.mentionWeeks).toBeNull();
  });

  it("ignores a zero or unparsable duration", () => {
    expect(parseRow(row(["i", "p.md", "n", "", "", "", "", "", "", "", "", "0"]))?.minutes).toBeNull();
    expect(parseRow(row(["i", "p.md", "n", "", "", "", "", "", "", "", "", "x"]))?.minutes).toBeNull();
  });
});

describe("parseShard", () => {
  it("skips blank lines and keeps the rest in order", () => {
    const notes = parseShard([row(["a", "a.md"]), "", row(["b", "b.md"]), ""].join("\n"));
    expect(notes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty shard", () => {
    expect(parseShard("")).toEqual([]);
  });
});

describe("parseManifest", () => {
  it("reads the stats and shard list", () => {
    const m = parseManifest(
      JSON.stringify({ version: 1, generated: "2026-10-26T05:05:56+00:00", stats: { notes: 3, links: 7, tags: 2 }, shards: [{ name: "shard-00.tsv", nodes: 3 }] }),
    );
    expect(m?.generated).toBe("2026-10-26T05:05:56+00:00");
    expect(m?.notes).toBe(3);
    expect(m?.links).toBe(7);
    expect(m?.tags).toBe(2);
    expect(m?.shards).toEqual([{ name: "shard-00.tsv", nodes: 3 }]);
  });

  it("refuses a shard name that could walk out of the feed directory", () => {
    const m = parseManifest(JSON.stringify({ shards: [{ name: "../../../etc/passwd" }, { name: "a/b.tsv" }, { name: "ok.tsv" }] }));
    expect(m?.shards.map((s) => s.name)).toEqual(["ok.tsv"]);
  });

  it("returns null for junk, for a missing shard list, and for an empty one", () => {
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest("null")).toBeNull();
    expect(parseManifest("{}")).toBeNull();
    expect(parseManifest(JSON.stringify({ shards: [] }))).toBeNull();
    expect(parseManifest(JSON.stringify({ shards: [{ nodes: 1 }] }))).toBeNull();
  });

  it("defaults missing stats to zero rather than throwing", () => {
    const m = parseManifest(JSON.stringify({ shards: [{ name: "s.tsv" }] }));
    expect(m?.notes).toBe(0);
    expect(m?.generated).toBe("");
  });
});

describe("vaultFeedDir", () => {
  it("defaults to the vault's own graph-feed directory", () => {
    const before = process.env.ALEF_VAULT_DIR;
    delete process.env.ALEF_VAULT_DIR;
    try {
      expect(vaultFeedDir({}, "/home/x")).toBe("/home/x/Documents/Code/alex_claude/60-Meta/graph-feed");
    } finally {
      if (before !== undefined) process.env.ALEF_VAULT_DIR = before;
    }
  });

  it("honours an explicit vault directory", () => {
    expect(vaultFeedDir({ vaultDir: "/v" })).toBe("/v/60-Meta/graph-feed");
    expect(vaultFeedDir({ vaultDir: "/v", feedSubdir: "feed" })).toBe("/v/feed");
  });
});

describe("VaultFeedReader", () => {
  async function feedDir(shards: Record<string, string>, stats = { notes: 0, links: 0, tags: 0 }): Promise<string> {
    const vault = await mkdtemp(join(tmpdir(), "alef-vault-"));
    const dir = join(vault, "feed");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ generated: "2026-10-26T05:00:00+00:00", stats, shards: Object.keys(shards).map((name) => ({ name, nodes: 0 })) }),
    );
    for (const [name, body] of Object.entries(shards)) await writeFile(join(dir, name), body);
    return vault;
  }

  it("serves nothing until the first refresh", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]) });
    const r = new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed" });
    expect(r.current()).toBeNull();
    const feed = await r.refresh();
    expect(feed?.notes.map((n) => n.id)).toEqual(["a"]);
    expect(r.current()).not.toBeNull();
  });

  it("reads every shard the manifest lists, in order", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]), "shard-01.tsv": `${row(["b", "b.md"])}\n${row(["c", "c.md"])}` });
    const feed = await new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed" }).refresh();
    expect(feed?.notes.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("carries the manifest's stats and its own parse time into the meta", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]) }, { notes: 32_429, links: 136_339, tags: 4_487 });
    const feed = await new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed", now: () => 1_700_000_000_000 }).refresh();
    expect(feed?.meta.notes).toBe(32_429);
    expect(feed?.meta.links).toBe(136_339);
    expect(feed?.meta.tags).toBe(4_487);
    expect(feed?.meta.shards).toBe(1);
    expect(feed?.meta.ready).toBe(true);
    expect(feed?.meta.generatedAt).toBe("2026-10-26T05:00:00+00:00");
    expect(feed?.meta.parsedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("re-reads a shard whose contents changed and keeps the one that did not", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]), "shard-01.tsv": row(["b", "b.md"]) });
    const r = new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed" });
    await r.refresh();
    await writeFile(join(vault, "feed", "shard-01.tsv"), `${row(["b", "b.md"])}\n${row(["z", "z.md"])}`);
    const feed = await r.refresh();
    expect(feed?.notes.map((n) => n.id)).toEqual(["a", "b", "z"]);
  });

  it("forgets a shard the manifest stops listing", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]), "shard-01.tsv": row(["b", "b.md"]) });
    const r = new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed" });
    await r.refresh();
    await writeFile(join(vault, "feed", "manifest.json"), JSON.stringify({ generated: "", stats: {}, shards: [{ name: "shard-00.tsv" }] }));
    const feed = await r.refresh();
    expect(feed?.notes.map((n) => n.id)).toEqual(["a"]);
  });

  it("keeps the last good parse when the feed disappears", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]) });
    const r = new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed" });
    await r.refresh();
    await writeFile(join(vault, "feed", "manifest.json"), "not json at all");
    const feed = await r.refresh();
    expect(feed?.notes.map((n) => n.id)).toEqual(["a"]);
  });

  it("returns null when there was never a feed to read", async () => {
    const r = new VaultFeedReader({ vaultDir: join(tmpdir(), "alef-vault-does-not-exist"), feedSubdir: "feed" });
    expect(await r.refresh()).toBeNull();
    expect(r.current()).toBeNull();
  });

  it("skips a shard the manifest names but disk does not have", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]) });
    await writeFile(
      join(vault, "feed", "manifest.json"),
      JSON.stringify({ generated: "", stats: {}, shards: [{ name: "shard-00.tsv" }, { name: "gone.tsv" }] }),
    );
    const feed = await new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed" }).refresh();
    expect(feed?.notes.map((n) => n.id)).toEqual(["a"]);
  });

  it("hands back the same feed object, parse time included, while nothing changed", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]), "shard-01.tsv": row(["b", "b.md"]) });
    let nowMs = 1_700_000_000_000;
    const r = new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed", now: () => nowMs });
    const first = await r.refresh();
    nowMs += 60_000;
    const again = await r.refresh();
    expect(again).toBe(first);
    expect(again?.meta.parsedAt).toBe(new Date(1_700_000_000_000).toISOString());

    // A shard that moved is a new feed with a new parse time.
    await writeFile(join(vault, "feed", "shard-01.tsv"), `${row(["b", "b.md"])}\n${row(["z", "z.md"])}`);
    const moved = await r.refresh();
    expect(moved).not.toBe(first);
    expect(moved?.meta.parsedAt).toBe(new Date(nowMs).toISOString());

    // So is a rebuilt manifest, even when every shard is byte-identical.
    const manifest = join(vault, "feed", "manifest.json");
    const m = JSON.parse(await readFile(manifest, "utf8")) as { generated: string };
    await writeFile(manifest, JSON.stringify({ ...m, generated: "2026-10-26T06:00:00+00:00" }));
    const rebuilt = await r.refresh();
    expect(rebuilt).not.toBe(moved);
    expect(rebuilt?.meta.generatedAt).toBe("2026-10-26T06:00:00+00:00");
    expect(await r.refresh()).toBe(rebuilt);
  });

  it("shares one pass between concurrent refreshes", async () => {
    const vault = await feedDir({ "shard-00.tsv": row(["a", "a.md"]) });
    const r = new VaultFeedReader({ vaultDir: vault, feedSubdir: "feed" });
    const [x, y] = await Promise.all([r.refresh(), r.refresh()]);
    expect(x).toBe(y);
  });
});

describe("vault feature refresh", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("re-stats the feed at most once per 30 s of requests, and serves the same parse in between", async () => {
    const vault = await mkdtemp(join(tmpdir(), "alef-vault-"));
    const dir = join(vault, "feed");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ generated: "2026-10-26T05:00:00+00:00", stats: { notes: 1 }, shards: [{ name: "shard-00.tsv", nodes: 1 }] }));
    await writeFile(join(dir, "shard-00.tsv"), row(["a", "a.md"]));
    let nowMs = Date.parse("2026-10-27T09:00:00Z");
    let refreshes = 0;
    class CountingReader extends VaultFeedReader {
      override refresh(): ReturnType<VaultFeedReader["refresh"]> {
        refreshes += 1;
        return super.refresh();
      }
    }
    const reader = new CountingReader({ vaultDir: vault, feedSubdir: "feed", now: () => nowMs });
    const b = await bootTestServer({ configOverrides: { features: [createVaultFeature({ reader, now: () => nowMs })] } });
    server = b.server;
    const meta = async (): Promise<VaultMeta> => ((await (await fetch(`${b.base}/api/vault/meta`)).json()) as { meta: VaultMeta }).meta;

    const booted = refreshes; // onStart's read
    const first = await meta();
    for (let i = 0; i < 5; i++) {
      nowMs += 1_000;
      expect(await meta()).toEqual(first);
    }
    expect(refreshes - booted).toBe(1);
    nowMs += 30_000;
    expect((await meta()).parsedAt).toBe(first.parsedAt); // re-stated, nothing moved: same parse
    expect(refreshes - booted).toBe(2);
  });
});

describe("EMPTY_META", () => {
  it("is not ready, so a client can tell a cold server from an empty vault", () => {
    expect(EMPTY_META.ready).toBe(false);
    expect(EMPTY_META.notes).toBe(0);
  });
});
