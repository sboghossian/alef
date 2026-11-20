import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatTokens,
  fuzzyRank,
  fuzzyScore,
  relativeTime,
} from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences and rejects missing chars", () => {
    expect(fuzzyScore("acn", "acme-ai-next")).not.toBeNull();
    expect(fuzzyScore("xyz", "acme-ai-next")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("prefers direct substrings, then word starts", () => {
    const direct = fuzzyScore("next", "acme-ai-next") ?? 0;
    const scattered = fuzzyScore("hnt", "acme-ai-next") ?? 0;
    expect(direct).toBeGreaterThan(scattered);
    expect(fuzzyScore("ai", "acme-ai") ?? 0).toBeGreaterThan(
      fuzzyScore("ai", "mountain") ?? 0,
    );
  });
});

describe("fuzzyRank", () => {
  it("ranks best first across several keys and respects the limit", () => {
    const items = [
      { id: 1, title: "Fix the blog build", city: "acme-ai-next" },
      { id: 2, title: "Draft linkedin post", city: "alexboghossian" },
      { id: 3, title: "Blog SEO audit", city: "work" },
    ];
    const ranked = fuzzyRank("blog", items, (i) => [i.title, i.city], 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.item.id).sort()).toEqual([1, 3]);
    expect(fuzzyRank("alex", items, (i) => [i.title, i.city])[0]?.item.id).toBe(
      2,
    );
  });

  it("returns nothing for an unmatched query", () => {
    expect(fuzzyRank("zzzz", [{ a: "abc" }], (i) => [i.a])).toEqual([]);
  });
});

describe("formatters", () => {
  it("formats token counts like the system canvas", () => {
    expect(formatTokens(1_940_000)).toBe("1.94M");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(Number.NaN)).toBe("—");
    expect(formatTokens(-1)).toBe("—");
  });

  it("relativeTime", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(relativeTime("2026-09-24T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-24T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-09-24T06:00:00Z", now)).toBe("6h ago");
    expect(relativeTime("not a date", now)).toBe("unknown");
  });

  it("escapes html", () => {
    expect(escapeHtml(`<b a="x">&'</b>`)).toBe(
      "&lt;b a=&quot;x&quot;&gt;&amp;&#39;&lt;/b&gt;",
    );
  });
});
