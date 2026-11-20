import { describe, expect, it } from "vitest";
import { bm25Scores, buildIndex, search, tokenize, type RecallDoc } from "../features/recall/bm25.js";

describe("tokenize", () => {
  it("lowercases, drops stopwords and single-char tokens", () => {
    // "my" is intentionally not in the (aleph-ported) stopword list — matches upstream.
    expect(tokenize("The Jessica Email is On my Plate")).toEqual(["jessica", "email", "my", "plate"]);
  });
  it("keeps dotted/hyphenated identifiers together", () => {
    expect(tokenize("acme-ai-next feedback_calibration.md")).toEqual(["acme-ai-next", "feedback_calibration.md"]);
  });
});

const DOCS: RecallDoc[] = [
  { path: "/memory/jessica.md", title: "email to Jessica about the contract", snippet: "drafted the reply to Jessica regarding the signed contract terms" },
  { path: "/memory/renderer.md", title: "renderer refactor notes", snippet: "split the THREE.js renderer into scene modules for agent-world" },
  { path: "/vault/acme/_index.md", title: "ACME growth index", snippet: "messaging system, claims registry, outbound sequences for ACME Legal AI" },
];

describe("buildIndex + search", () => {
  it("ranks the doc whose title matches the query above unrelated docs", () => {
    const idx = buildIndex(DOCS);
    expect(idx.n).toBe(3);
    const hits = search(idx, "who worked on the Jessica email?", 3);
    expect(hits[0]?.path).toBe("/memory/jessica.md");
  });

  it("returns [] for a query with no matching terms", () => {
    const idx = buildIndex(DOCS);
    expect(search(idx, "the a an", 3)).toEqual([]);
    expect(search(idx, "zzzznotarealword", 3)).toEqual([]);
  });

  it("dedupes by path and caps at k", () => {
    const idx = buildIndex([...DOCS, { path: "/memory/jessica.md", title: "email to Jessica about the contract (dup)", snippet: "same file indexed twice should still collapse to one hit" }]);
    const hits = search(idx, "jessica renderer acme", 2);
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.path)).size).toBe(2);
  });

  it("skips a doc with no indexable tokens (title+snippet all stopwords) without throwing", () => {
    const idx = buildIndex([{ path: "/x", title: "the a an", snippet: "is of on" }]);
    expect(idx.n).toBe(0);
    expect(search(idx, "anything", 3)).toEqual([]);
  });

  it("bm25Scores returns an empty map for an empty index", () => {
    const idx = buildIndex([]);
    expect(bm25Scores(idx, "jessica").size).toBe(0);
  });
});
