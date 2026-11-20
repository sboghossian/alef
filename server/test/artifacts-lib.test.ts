import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactFallbackTitle, isRealArtifactId } from "../../shared/features/artifacts.js";
import { applyEvents, emptyState, foldLine, isServable, mentionTitlesIn, toItem, type ArtifactEvent, type PendingPublish } from "../features/artifacts-lib.js";
import { listTargets, scanPass } from "../features/artifacts-scan.js";
import { ArtifactsStore, META_DONE } from "../features/artifacts-store.js";
import { artifactCall, artifactResult, publishLines, S1, S2, URL_A, UUID_A } from "./artifacts-fixtures.js";
import { makeTempDb, makeTempProjectsDir } from "./helpers.js";

function fold(lines: string[], sessionId = S1, pending = new Map<string, PendingPublish>()): ArtifactEvent[] {
  return lines.flatMap((l) => foldLine(l, sessionId, pending));
}

describe("foldLine", () => {
  it("pairs an Artifact publish with its result, and a frame-link is only a hint", () => {
    const ev = fold(publishLines("toolu_1", "2026-10-01T10:00:00Z", "Board", "/tmp/x/board.html"));
    expect(ev.map((e) => [e.kind, e.kind === "publish" ? e.hint : null])).toEqual([
      ["publish", true],
      ["publish", false],
    ]);
    expect(ev[1]).toMatchObject({ url: URL_A, title: "Board", path: "/tmp/x/board.html", sessionId: S1, uuid: UUID_A });
  });

  it("falls back to the result text and the call's input when there is no toolUseResult", () => {
    const at = "2026-10-01T10:00:00Z";
    const ev = fold([artifactCall("t2", { file_path: "/w/a.html", title: "From input" }, at), artifactResult("t2", `Published /w/a.html at ${URL_A} (Version 2)`, at)]);
    expect(ev).toEqual([{ kind: "publish", url: URL_A, title: "From input", path: "/w/a.html", at, sessionId: S1, uuid: null, hint: false }]);
  });

  it("skips failed publishes, asset uploads and non-publish actions (their links are mentions)", () => {
    const at = "2026-10-01T10:00:00Z";
    const ev = fold([
      artifactCall("e1", { file_path: "/w/a.html" }, at),
      artifactResult("e1", "Publish refused", at, undefined, true),
      artifactCall("e2", { url: URL_A, file_path: "/w/logo.png", asset: true }, at),
      artifactResult("e2", `Uploaded to ${URL_A}`, at, { url: URL_A }),
      artifactCall("e3", { action: "read", url: URL_A }, at),
    ]);
    expect(ev.every((e) => e.kind === "mention")).toBe(true);
  });

  it("an update by url (no file_path) still counts as a publish", () => {
    const at = "2026-10-02T10:00:00Z";
    const ev = fold([artifactCall("u1", { url: URL_A, files: { "data.json": "d.json" } }, at), artifactResult("u1", `Published at ${URL_A}`, at, { url: URL_A, title: "Board v2" })]);
    expect(ev.filter((e) => e.kind === "publish")).toMatchObject([{ kind: "publish", path: null, title: "Board v2", hint: false }]);
  });

  it("a gallery listing yields titles, not mentions; a pasted link is a mention", () => {
    const listing = JSON.stringify({ type: "user", toolUseResult: { artifacts: [{ title: "Old deck", url: "https://claude.ai/artifact/ListedAb3dEf5h7K9mNp2Q", updatedAt: "2026-09-01T00:00:00Z" }] } });
    expect(fold([listing])).toEqual([{ kind: "listed", url: "https://claude.ai/artifact/ListedAb3dEf5h7K9mNp2Q", title: "Old deck", at: "2026-09-01T00:00:00Z" }]);
    const pasted = JSON.stringify({ type: "user", timestamp: "2026-09-02T00:00:00Z", message: { content: [{ type: "text", text: "look at https://claude.ai/artifact/PastedAb3dEf5h7K9mNp2Q?x=1 please" }] } });
    expect(fold([pasted], S2)).toEqual([{ kind: "mention", url: "https://claude.ai/artifact/PastedAb3dEf5h7K9mNp2Q", at: "2026-09-02T00:00:00Z", sessionId: S2 }]);
    expect(fold(['{"type":"user","message":{"content":"no links here"}}'])).toEqual([]);
  });
});

describe("applyEvents", () => {
  it("dedupes republishes into one item: count, latest title and source, sessions newest first", () => {
    const st = emptyState();
    applyEvents(st, fold(publishLines("a", "2026-10-01T10:00:00Z", "Board v1", "/tmp/v1.html")));
    applyEvents(st, fold(publishLines("b", "2026-10-03T10:00:00Z", "Board v3", "/tmp/v3.html"), S2));
    applyEvents(st, fold(publishLines("c", "2026-10-02T10:00:00Z", "Board v2", "/tmp/v2.html")));
    const items = Object.values(st.items);
    expect(items).toHaveLength(1);
    const it0 = toItem(items[0]!, (s) => (s === S2 ? "isle-2" : "isle-1"), false);
    expect(it0).toMatchObject({ id: "Ab3dEf5h7K9mNp2QrStUvW", title: "Board v3", origin: "published", publishCount: 3, islandId: "isle-2", sessions: [S2, S1], firstAt: "2026-10-01T10:00:00Z", lastAt: "2026-10-03T10:00:00Z" });
    expect(items[0]!.sourcePath).toBe("/tmp/v3.html");
  });

  it("folds a /code/artifact/<uuid> link into the item once a publish names that uuid", () => {
    const st = emptyState();
    applyEvents(st, [{ kind: "mention", url: `https://claude.ai/code/artifact/${UUID_A}`, at: "2026-09-30T00:00:00Z", sessionId: S2 }]);
    applyEvents(st, fold(publishLines("a", "2026-10-01T10:00:00Z", "Board", "/tmp/b.html")));
    applyEvents(st, [{ kind: "mention", url: `https://claude.ai/code/artifact/${UUID_A}`, at: "2026-10-05T00:00:00Z", sessionId: S2 }]);
    expect(Object.keys(st.items)).toEqual(["Ab3dEf5h7K9mNp2QrStUvW"]);
    expect(st.items.Ab3dEf5h7K9mNp2QrStUvW).toMatchObject({ firstAt: "2026-09-30T00:00:00Z", url: URL_A, publishCount: 1 });
  });

  it("a referenced item has no district and takes a listing's title", () => {
    const st = emptyState();
    applyEvents(st, [
      { kind: "mention", url: "https://claude.ai/artifact/PastedAb3dEf5h7K9mNp2Q", at: "2026-09-02T00:00:00Z", sessionId: S2 },
      { kind: "listed", url: "https://claude.ai/artifact/PastedAb3dEf5h7K9mNp2Q", title: "Deck", at: "2026-09-03T00:00:00Z" },
    ]);
    expect(toItem(st.items.PastedAb3dEf5h7K9mNp2Q!, () => "isle", false)).toMatchObject({ origin: "referenced", islandId: null, title: "Deck", sessions: [S2], publishCount: 0 });
  });
});

describe("scanPass + store", () => {
  async function tree(): Promise<{ dir: string; projects: string; main: string; sub: string }> {
    const dir = await makeTempProjectsDir();
    const projects = join(dir, "projects");
    await mkdir(join(projects, "-w", S1, "subagents"), { recursive: true });
    const main = join(projects, "-w", `${S1}.jsonl`);
    const sub = join(projects, "-w", S1, "subagents", "agent-abc123.jsonl");
    await writeFile(main, "");
    await writeFile(sub, "");
    return { dir, projects, main, sub };
  }

  it("keeps a call pending across passes, credits a subagent's publish to its parent, never double counts", async () => {
    const { dir, projects, main, sub } = await tree();
    const db = await makeTempDb(dir);
    const store = new ArtifactsStore(db);
    store.load();
    expect(await store.ensureBackup(new Date("2026-10-14T00:00:00Z"))).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith("world.db.pre-artifacts-"))).toBe(true);

    const [call, link, result] = publishLines("p1", "2026-10-01T10:00:00Z", "Board", "/tmp/b.html");
    await appendFile(main, `${call}\n${link}\n`);
    await appendFile(sub, `${publishLines("p2", "2026-10-02T10:00:00Z", "Board 2", "/tmp/b2.html").join("\n")}\n`);
    let targets = await listTargets(projects);
    let r = await scanPass(store, targets, 1 << 30);
    store.commit(r.complete);
    expect(store.cursors.get(main)?.p?.p1).toBeDefined();
    expect(db.getMeta(META_DONE)).toBe("1");

    await appendFile(main, `${result}\n`);
    targets = await listTargets(projects);
    r = await scanPass(store, targets, 1 << 30);
    store.commit(false);
    const item = store.state.items.Ab3dEf5h7K9mNp2QrStUvW!;
    expect(item.publishCount).toBe(2);
    expect(Object.keys(item.publishers)).toEqual([S1]);

    // A reload + rescan reads nothing new: counts stay.
    const again = new ArtifactsStore(db);
    again.load();
    expect(again.done).toBe(true);
    await scanPass(again, targets, 1 << 30);
    expect(again.state.items.Ab3dEf5h7K9mNp2QrStUvW!.publishCount).toBe(2);
  });

  it("stops at the byte budget and reports the pass incomplete", async () => {
    const { dir, projects, main, sub } = await tree();
    await appendFile(main, `${publishLines("p1", "2026-10-01T10:00:00Z", "A", "/tmp/a.html").join("\n")}\n`);
    await appendFile(sub, `${publishLines("p2", "2026-10-01T11:00:00Z", "B", "/tmp/b.html", "https://claude.ai/artifact/SecondAb3dEf5h7K9mNp2Q").join("\n")}\n`);
    const store = new ArtifactsStore(await makeTempDb(dir));
    store.load();
    const r = await scanPass(store, await listTargets(projects), 1);
    expect(r.complete).toBe(false);
    expect(Object.keys(store.state.items)).toHaveLength(1);
    expect((await scanPass(store, await listTargets(projects), 1)).complete).toBe(true);
    expect(Object.keys(store.state.items)).toHaveLength(2);
    expect(existsSync(main)).toBe(true);
  });
});

const SHORT = "RWViDXvpKXH6KuCeS2qta5";
const UUID_LC = "0f1e2d3c-aaaa-4bbb-8ccc-000011112222";
const say = (text: string, at = "2026-09-02T00:00:00Z") => JSON.stringify({ type: "user", timestamp: at, message: { content: [{ type: "text", text }] } });

describe("which ids are real artifacts", () => {
  it("accepts a 22-char base58 short id and an RFC-4122 uuid (any case)", () => {
    expect(isRealArtifactId(SHORT)).toBe(true);
    expect(isRealArtifactId(UUID_LC)).toBe(true);
    expect(isRealArtifactId(UUID_LC.toUpperCase())).toBe(true);
  });

  it("refuses placeholders, a 21-char truncation, bad uuid version/variant and non-base58 chars", () => {
    for (const bad of ["AbCdEf123456", "abc-123", "Probe1234567", "AbCdEfGh12", "1qyDtT6Wcn5vumPpsRDae", "0f1e2d3c-aaaa-bbbb-cccc-000011112222", "0f1e2d3c-aaaa-0bbb-8ccc-000011112222", `${SHORT.slice(0, 21)}0`, `${SHORT}x`]) {
      expect(isRealArtifactId(bad), bad).toBe(false);
    }
  });

  it("foldLine never emits an event for a fixture or truncated id, but keeps a real link with query or slash", () => {
    expect(fold([say("see https://claude.ai/artifact/abc-123 and https://claude.ai/artifact/1qyDtT6Wcn5vumPpsRDae and https://claude.ai/artifact/AbCdEf123456")])).toEqual([]);
    const ev = fold([say(`a https://claude.ai/artifact/${SHORT}/?x=1 b https://claude.ai/code/artifact/${UUID_LC.toUpperCase()}/`)]);
    expect(ev.map((e) => e.url)).toEqual([`https://claude.ai/artifact/${SHORT}`, `https://claude.ai/code/artifact/${UUID_LC}`]);
    const listing = JSON.stringify({ type: "user", toolUseResult: { artifacts: [{ title: "Probe", url: "https://claude.ai/artifact/Probe1234567" }, { title: "Real", url: `https://claude.ai/artifact/${SHORT}` }] } });
    expect(fold([listing]).map((e) => e.url)).toEqual([`https://claude.ai/artifact/${SHORT}`]);
  });

  it("an item already persisted under a junk id is not servable", () => {
    const st = emptyState();
    st.items.Probe1234567 = { ...st.items.x, id: "Probe1234567" } as never;
    expect(isServable({ id: "Probe1234567" })).toBe(false);
    expect(isServable({ id: SHORT })).toBe(true);
  });
});

describe("mention titles", () => {
  const url = `https://claude.ai/artifact/${SHORT}`;

  it("takes markdown link text for an artifact url", () => {
    expect(mentionTitlesIn(`Open [Q4 board](${url}) now`).get(url)).toBe("Q4 board");
    expect(mentionTitlesIn(`[Deck](${url}?x=1) and [Other](https://example.com/a)`).get(url)).toBe("Deck");
  });

  it("ignores empty, generic and url-as-text labels", () => {
    for (const label of ["", " ", "link", "Here", "artifact", "Open", url, "claude.ai/artifact/x"]) {
      expect(mentionTitlesIn(`[${label}](${url})`).size, label).toBe(0);
    }
  });

  it("caps the label length and skips a fixture id", () => {
    expect(mentionTitlesIn(`[${"x".repeat(299)}](${url})`).get(url)).toHaveLength(299);
    expect(mentionTitlesIn("[Fixture](https://claude.ai/artifact/AbCdEf123456)").size).toBe(0);
  });

  it("ranks below a gallery listing and a publish", () => {
    const st = emptyState();
    const mention = (title: string, at: string): ArtifactEvent => ({ kind: "mention", url, title, at, sessionId: S2 });
    applyEvents(st, fold([say(`[From text](${url})`)], S2));
    expect(st.items[SHORT]).toMatchObject({ title: "From text", titleRank: 0.5 });
    applyEvents(st, [{ kind: "listed", url, title: "Listed", at: "2026-09-03T00:00:00Z" }]);
    applyEvents(st, [mention("Later mention", "2026-09-09T00:00:00Z")]);
    expect(st.items[SHORT]).toMatchObject({ title: "Listed", titleRank: 1 });
    applyEvents(st, [{ kind: "publish", url, title: "Published", path: null, at: "2026-09-01T00:00:00Z", sessionId: S1, uuid: null, hint: false }]);
    expect(st.items[SHORT]).toMatchObject({ title: "Published", titleRank: 2 });
  });

  it("a newer mention title replaces an older mention title", () => {
    const st = emptyState();
    applyEvents(st, [{ kind: "mention", url, title: "Old", at: "2026-09-01T00:00:00Z", sessionId: S2 }, { kind: "mention", url, title: "New", at: "2026-09-02T00:00:00Z", sessionId: S2 }]);
    expect(st.items[SHORT]?.title).toBe("New");
  });
});

describe("fallback label", () => {
  it("is readable and keyed off the link shape", () => {
    expect(artifactFallbackTitle({ id: SHORT, url: `https://claude.ai/artifact/${SHORT}` })).toBe("Artifact · RWViDXvp");
    expect(artifactFallbackTitle({ id: UUID_LC, url: `https://claude.ai/code/artifact/${UUID_LC}` })).toBe("Code artifact · 0f1e2d3c");
  });
});
