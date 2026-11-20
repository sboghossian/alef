import { describe, expect, it } from "vitest";
import type { CandidateBuckets, CleanupSessionItem, TrashManifest } from "../../../shared/features/cleanup";
import {
  ago,
  bucketCount,
  chunk,
  diskSentence,
  formatBytes,
  inTrash,
  isCandidatesResponse,
  isRetireResult,
  isTrashList,
  retireSummary,
  selectableIds,
  selectionSummary,
} from "./cleanup-lib";

const item = (id: string, bytes: number, prot?: string): CleanupSessionItem => ({
  id,
  title: id,
  cwd: "/w",
  islandId: "w",
  projDir: "-w",
  lastActive: "2026-09-01T00:00:00Z",
  messageCount: 1,
  bytes,
  reason: "only 1 message",
  ...(prot ? { protected: prot } : {}),
});

const empty: CandidateBuckets = { empty: [], headless: [], tiny: [], dormant: [], worktree: [], tmux: [], totals: { bytes: 0, count: 0, protectedCount: 0 } };

describe("cleanup-lib", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatBytes(212 * 1024 * 1024)).toBe("212 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("ages", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(ago("2026-09-25T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-09-22T12:00:00Z", now)).toBe("3 days ago");
    expect(ago("2026-09-25T11:00:00Z", now)).toBe("1 hour ago");
    expect(ago("nope", now)).toBe("");
  });

  it("counts buckets without protected items; selections skip protected ids", () => {
    const b = { ...empty, tiny: [item("a", 10), item("b", 20, "it is live right now"), item("c", 5)] };
    expect(bucketCount(b, "tiny")).toEqual({ count: 2, bytes: 15, protectedCount: 1 });
    expect(bucketCount(b, "tmux")).toEqual({ count: 0, bytes: 0, protectedCount: 0 });
    expect(selectableIds(b.tiny)).toEqual(["a", "c"]);
    expect(selectionSummary(b.tiny, new Set(["a", "b"]))).toEqual({ ids: ["a"], bytes: 10 });
    expect(selectionSummary([], new Set(["a"]))).toEqual({ ids: [], bytes: 0 });
  });

  it("the disk sentence is honest about deletion", () => {
    expect(diskSentence(212 * 1024 * 1024)).toMatch(/^212 MB could leave ~\/.claude\/projects.*never deletes.*~\/.alef-trash/);
    expect(diskSentence(0)).toMatch(/Nothing to tidy/);
  });

  it("chunks bulk retires to the server's 200-id cap", () => {
    const ids = Array.from({ length: 401 }, (_, i) => String(i));
    expect(chunk(ids).map((c) => c.length)).toEqual([200, 200, 1]);
    expect(chunk([])).toEqual([]);
  });

  it("summarises a retire", () => {
    expect(retireSummary([{ id: "a", ok: true, bytes: 2048 }, { id: "b", ok: false, error: "protected: live", bytes: 0 }])).toBe("Retired 1 · 2.0 KB · 1 refused");
    expect(retireSummary([{ id: "b", ok: false, error: "protected: live", bytes: 0 }])).toBe("Not retired: protected: live");
    expect(retireSummary([])).toBe("None retired (0 refused)");
  });

  it("validates server answers", () => {
    expect(isCandidatesResponse({ ok: true, params: {}, buckets: empty, generatedAt: "" })).toBe(true);
    expect(isCandidatesResponse({ ok: true, params: {}, buckets: { ...empty, tmux: null } })).toBe(false);
    expect(isCandidatesResponse(null)).toBe(false);
    expect(isTrashList({ ok: true, root: "/x", batches: [] })).toBe(true);
    expect(isTrashList({ ok: true, batches: [] })).toBe(false);
    expect(isRetireResult({ ok: false, error: "x" })).toBe(true);
    expect(isRetireResult({ ok: true, results: [] })).toBe(false);
  });

  it("lists only items still in the trash", () => {
    const m: TrashManifest = {
      batchId: "20260925-090507-abc123",
      date: "2026-09-25",
      at: "2026-09-25T09:05:07Z",
      items: (["retired", "restored", "failed", "planned"] as const).map((state, i) => ({ sessionId: String(i), title: "", cwd: "", messageCount: 0, lastActive: "", from: [], to: [], bytes: 1, state })),
    };
    expect(inTrash(m).map((i) => i.state)).toEqual(["retired", "planned"]);
  });
});
