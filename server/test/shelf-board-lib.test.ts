import { describe, expect, it } from "vitest";
import { classifyUrl, itemIdOf, lineMentions, pathsIn } from "../features/shelf-board-lib.js";
import { applyMentions, pruneItems, type BoardState } from "../features/shelf-board-store.js";
import { cleanTitle, movePin, normalisePins, normaliseSections, removePin, seedPins, setSections, upsertPin, pinFor } from "../features/shelf-board-pins.js";
import { DEFAULT_SHELF_SECTIONS } from "../../shared/features/shelf-seed.js";

const HOME = "/Users/tester";
const AT = "2026-10-14T10:00:00.000Z";

function user(text: string): string {
  return JSON.stringify({ type: "user", timestamp: AT, cwd: `${HOME}/proj`, message: { role: "user", content: [{ type: "text", text }] } });
}
function tool(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", timestamp: AT, cwd: `${HOME}/proj`, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] } });
}

const HOOK = `Zx9${"kQ2mPa7".repeat(4)}`;

describe("classifyUrl", () => {
  it("types and normalises each kind of link", () => {
    expect(classifyUrl("https://github.com/sboghossian/agent-world/pull/84/files#diff")).toMatchObject({ type: "github", key: "github:sboghossian/agent-world#84", url: "https://github.com/sboghossian/agent-world/pull/84", kind: "PR #84" });
    expect(classifyUrl("https://github.com/ACME-Inc/acme-ai/issues/7")).toMatchObject({ key: "github:acme-inc/acme-ai#7", kind: "issue #7" });
    expect(classifyUrl("https://github.com/sboghossian/agent-world/blob/main/README.md")?.key).toBe("github:sboghossian/agent-world");
    expect(classifyUrl("https://github.com/settings/tokens")?.type).toBe("link");
    expect(classifyUrl("https://linear.app/acmeai/issue/tick-2520/twelve-projects")).toMatchObject({ type: "linear", key: "linear:issue:TICK-2520", url: "https://linear.app/acmeai/issue/TICK-2520" });
    expect(classifyUrl("https://linear.app/acmeai/document/artifacts-bb10a0f894be")).toMatchObject({ type: "linear", key: "linear:document:bb10a0f894be", title: "artifacts", kind: "doc" });
    expect(classifyUrl("https://lawgraph.dashable.dev/graph?x=1")).toMatchObject({ type: "dashable", key: "dashable:lawgraph.dashable.dev", url: "https://lawgraph.dashable.dev" });
    expect(classifyUrl("https://claude.ai/code/artifact/d9b6be0a-b231-4c73-b014-6da81c9900d5")).toMatchObject({ type: "artifact", key: "artifact:d9b6be0a-b231-4c73-b014-6da81c9900d5" });
    expect(classifyUrl("https://www.Example-Blog.io/post/?utm_source=x&utm_medium=y&id=3&fbclid=abc#top")).toMatchObject({ type: "link", url: "https://example-blog.io/post?id=3", key: "link:https://example-blog.io/post?id=3" });
  });

  it("dedupes spellings of one link onto one key", () => {
    const a = classifyUrl("https://www.news.site/a/?utm_campaign=q");
    const b = classifyUrl("https://news.site/a#section");
    expect(a?.key).toBe(b?.key);
    expect(itemIdOf(a?.key ?? "")).toBe(itemIdOf(b?.key ?? ""));
  });

  it("drops URLs that carry credentials or signatures, even when lenient", () => {
    for (const u of [
      "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=abc&X-Amz-Credential=x",
      "https://app.site/callback?token=abc123",
      "https://app.site/x?access_token=abc",
      "https://storage.googleapis.com/b/o?X-Goog-Signature=ff",
      "https://acct.blob.core.windows.net/c/f?sv=2020&sig=abc",
      "https://user:pw@site.com/x",
      `https://api.site/v1/keys/sk-ant-${"a".repeat(30)}`,
      `https://site.com/x?q=${"Ab1".repeat(12)}`,
      "https://accounts.site.com/authorize?client_id=x&state=abc&code_challenge=y",
      "https://bucket.s3.eu-west-1.amazonaws.com/f.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261014T000000Z&X-Amz-Expires=3600&X-Amz-Signature=deadbeef",
      "https://d111.cloudfront.net/v.mp4?Expires=1&Signature=abc&Key-Pair-Id=K2",
      "https://app.site/x?auth_token=abc",
      "https://app.site/x?api-key=abc",
      "https://app.site/x?accessToken=abc",
      "https://app.site/x?sessionid=abc",
      "https://user@site.com/x",
      `https://hooks.slack.com/services/T0000/B0000/${HOOK}`,
      `https://discord.com/api/webhooks/123456789012345678/${HOOK}`,
      `https://acme.webhook.office.com/webhookb2/a@b/IncomingWebhook/${HOOK}/c`,
      `https://api.telegram.org/bot123456:${HOOK}/sendMessage`,
      "https://hooks.zapier.com/hooks/catch/123456/abcdef/",
      `https://maker.ifttt.com/trigger/ev/with/key/${HOOK}`,
      `https://hooks.myapp.io/webhook/${HOOK}`,
      "https://docs.google.com/document/d/1AbCdEf/edit?usp=sharing&key=abc",
      "https://drive.google.com/file/d/1AbC/view?usp=sharing&resourcekey=0-abcDEF",
    ]) {
      expect(classifyUrl(u), u).toBeNull();
      expect(classifyUrl(u, { lenient: true }), u).toBeNull();
    }
    expect(classifyUrl("https://hooks.slack.com/services/T000/B000/xyz")).toBeNull();
    // Not over-eager: plain Docs links, Discord invites and webhook docs stay.
    for (const u of ["https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing&authuser=0", "https://discord.com/invite/abc", "https://docs.github.com/en/webhooks/about-webhooks"]) expect(classifyUrl(u), u).not.toBeNull();
  });

  it("filters noise: local hosts, CDNs, assets, placeholders", () => {
    for (const u of ["http://localhost:5178/#/shelf", "http://127.0.0.1:3000", "http://192.168.1.4/x", "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js", "https://fonts.googleapis.com/css2?family=Inter", "https://site.com/logo.png", "https://raw.githubusercontent.com/a/b/main/x.md", "https://api.github.com/repos/a/b", "https://img.shields.io/badge/x-y-green", "https://site.com/${id}", "https://site.com/<path>"]) {
      expect(classifyUrl(u), u).toBeNull();
    }
    expect(classifyUrl("http://localhost:5178", { lenient: true })?.type).toBe("link");
  });
});

describe("pathsIn", () => {
  it("expands ~ and keeps only safe home paths", () => {
    const text = `see ~/Documents/Code/agent-world/ and /Users/tester/notes/plan.md. Also ${HOME}/Desktop/private.txt ${HOME}/.ssh/id_rsa ${HOME}/x/node_modules/y /etc/hosts ${HOME}/.claude/projects/a/b.jsonl`;
    expect(pathsIn(text, HOME)).toEqual([`${HOME}/Documents/Code/agent-world`, `${HOME}/notes/plan.md`]);
  });
});

describe("lineMentions", () => {
  it("credits Alex for typed links and paths, the subagent brief to the assistant", () => {
    const line = user("look at https://github.com/a/b/pull/3 and ~/Documents/Code/x");
    const main = lineMentions(line, { subagent: false, home: HOME });
    expect(main?.mentions.map((m) => [m.key, m.source])).toEqual([["github:a/b#3", "user"], [`path:${HOME}/Documents/Code/x`, "user"]]);
    expect(lineMentions(line, { subagent: true, home: HOME })?.mentions[0]?.source).toBe("assistant");
  });

  it("marks fetched URLs as fetch, skips writes, results, injected blocks and artifact links", () => {
    expect(lineMentions(tool("WebFetch", { url: "https://docs.tool.dev/guide" }), { subagent: false, home: HOME })?.mentions[0]?.source).toBe("fetch");
    expect(lineMentions(tool("Bash", { command: "curl -s https://status.site.io/x" }), { subagent: false, home: HOME })?.mentions[0]?.source).toBe("fetch");
    expect(lineMentions(tool("Bash", { command: "gh pr view https://github.com/a/b/pull/9" }), { subagent: false, home: HOME })?.mentions[0]?.source).toBe("tool");
    expect(lineMentions(tool("Write", { file_path: "/x", content: "https://site.io/a" }), { subagent: false, home: HOME })).toBeNull();
    expect(lineMentions(user("<system-reminder>https://cdn.site.io/a https://injected.site/b</system-reminder>"), { subagent: false, home: HOME })).toBeNull();
    expect(lineMentions(user("https://claude.ai/artifact/AbCdEf123456"), { subagent: false, home: HOME })).toBeNull();
    const result = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "https://x.site/y" }] } });
    expect(lineMentions(result, { subagent: false, home: HOME })).toBeNull();
  });

  it("folds mentions: once per line, sessions newest first, typed sticks", () => {
    const st: BoardState = { items: {} };
    const m = lineMentions(user("https://news.site/a https://news.site/a/?utm_x=1"), { subagent: false, home: HOME });
    expect(m?.mentions).toHaveLength(1);
    applyMentions(st, m?.mentions ?? [], "s1", "2026-10-01T00:00:00Z");
    applyMentions(st, lineMentions(tool("Bash", { command: "open https://news.site/a" }), { subagent: false, home: HOME })?.mentions ?? [], "s2", "2026-10-05T00:00:00Z");
    const it = Object.values(st.items)[0];
    expect(it).toMatchObject({ count: 2, sessions: ["s2", "s1"], typed: true, source: "user", firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-05T00:00:00Z" });
  });

  it("prunes fetch-only items first, then links and files, keeping repos and issues", () => {
    const st: BoardState = { items: {} };
    applyMentions(st, [{ key: "link:a", type: "link", url: "a", path: null, title: "a", kind: "a", source: "fetch" }], "s", AT);
    applyMentions(st, [{ key: "link:b", type: "link", url: "b", path: null, title: "b", kind: "b", source: "user" }], "s", AT);
    applyMentions(st, [{ key: "github:a/b", type: "github", url: "g", path: null, title: "g", kind: "repo", source: "tool" }], "s", "2020-01-01T00:00:00Z");
    expect(pruneItems(st, Date.parse(AT), 1)).toBe(2);
    expect(Object.values(st.items).map((i) => i.key)).toEqual(["github:a/b"]);
  });
});

describe("pins", () => {
  const base = { sections: [...DEFAULT_SHELF_SECTIONS], pins: [] };
  it("pins one item to several shelves, moves one pin, unpins from one shelf or all, keeps Unsorted last", () => {
    const pin = pinFor({ url: "https://github.com/a/b" }, "Growth", null, AT);
    if (!pin) throw new Error("pin");
    let s = upsertPin(base, pin);
    s = upsertPin(s, { ...pin, section: "New shelf" });
    expect(s.pins.map((p) => p.section)).toEqual(["Growth", "New shelf"]);
    expect(upsertPin(s, { ...pin, title: "Renamed title" }).pins.map((p) => [p.section, p.title])).toEqual([["Growth", "Renamed title"], ["New shelf", "a/b"]]);
    expect(s.sections.at(-1)).toBe("Unsorted");
    expect(s.sections).toContain("New shelf");
    s = movePin(s, pin.itemId, "Growth", "Sales");
    expect(s.pins.map((p) => p.section)).toEqual(["Sales", "New shelf"]);
    expect(movePin(s, pin.itemId, "Sales", "New shelf").pins.map((p) => p.section)).toEqual(["New shelf"]); // already there: merge
    expect(movePin(s, pin.itemId, "Product", "Growth")).toBe(s); // not on Product: no-op
    expect(removePin(s, pin.itemId, "Sales").pins.map((p) => p.section)).toEqual(["New shelf"]);
    s = setSections(s, ["Sales", "Renamed"], { "New shelf": "Renamed" });
    expect(s.pins.map((p) => p.section)).toEqual(["Sales", "Renamed"]);
    s = setSections(s, ["Product"]); // both shelves dropped: one Unsorted pin, not two
    expect(s.pins.map((p) => p.section)).toEqual(["Unsorted"]);
    expect(removePin(upsertPin(s, { ...pin, section: "Product" }), pin.itemId).pins).toHaveLength(0);
    expect(normaliseSections(["  A  ", "A", "Unsorted", "", 3])).toEqual(["A", "Unsorted"]);
    expect(cleanTitle("a\u0000b   c")).toBe("a b c");
  });

  it("loads pins stored one-per-item unchanged and dedupes (item, section)", () => {
    const pin = pinFor({ url: "https://github.com/a/b" }, "Growth", null, AT);
    const other = pinFor({ url: "https://github.com/c/d" }, "Gone shelf", null, AT);
    if (!pin || !other) throw new Error("pin");
    const old = { sections: [...DEFAULT_SHELF_SECTIONS], pins: [pin, { ...other, section: "Product" }] };
    expect(normalisePins(old)).toEqual(old);
    const messy = normalisePins({ sections: ["Growth"], pins: [pin, { ...pin }, other] });
    expect(messy.pins.map((p) => [p.itemId, p.section])).toEqual([[pin.itemId, "Growth"], [other.itemId, "Unsorted"]]);
  });

  it("imports a seed once per (url, section): one URL under two headings lands on both shelves", () => {
    const rows = [
      { section: "Product", url: "https://claude.ai/artifact/AbCdEf123456", title: "Board" },
      { section: "Benchmarks", url: "https://lawgraph.dashable.dev", title: "Law graph" },
      { section: "Brand new", url: "https://claude.ai/code/artifact/d9b6be0a-b231-4c73-b014-6da81c9900d5", title: "Testimonial" },
      { section: "Growth", url: "https://claude.ai/artifact/AbCdEf123456", title: "Board" },
      { section: "Product", url: "https://claude.ai/artifact/AbCdEf123456/", title: "Board again" },
      { section: "Product", url: "https://site.com/x?token=abc", title: "Leaky" },
      { nope: true },
    ];
    const first = seedPins(base, rows, AT);
    expect(first).toMatchObject({ added: 4, skipped: 1, invalid: 2 });
    expect(first?.state.sections).toContain("Brand new");
    expect(first?.state.pins.filter((p) => p.url === "https://claude.ai/artifact/AbCdEf123456").map((p) => p.section)).toEqual(["Product", "Growth"]);
    const again = seedPins(first?.state ?? base, rows, AT);
    expect(again).toMatchObject({ added: 0, skipped: 5, invalid: 2 });
    expect(again?.state).toEqual(first?.state);
    // Unpinning from one shelf leaves the other; a rerun puts back only what was removed.
    const unpinned = removePin(first?.state ?? base, first?.state.pins[0]?.itemId ?? "", "Growth");
    expect(unpinned.pins.filter((p) => p.url === "https://claude.ai/artifact/AbCdEf123456").map((p) => p.section)).toEqual(["Product"]);
    expect(seedPins(unpinned, rows, AT)).toMatchObject({ added: 1, skipped: 4 });
    expect(seedPins(base, { not: "an array" }, AT)).toBeNull();
  });
});
