import { describe, expect, it } from "vitest";
import type { InstalledSkill, SkillEvent } from "../../shared/features/skills.js";
import { aggregateSkillUsage, indexInstalledBySlug } from "../features/skills-aggregate.js";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const DAY = 86_400_000;

function installed(slug: string, o: Partial<InstalledSkill> = {}): InstalledSkill {
  return { slug, name: slug, description: "", origin: "user", pluginId: null, path: `/skills/${slug}/SKILL.md`, updatedAt: null, ...o };
}

function ev(o: Partial<SkillEvent> & Pick<SkillEvent, "skillName" | "at">): SkillEvent {
  return { sessionId: "s1", kind: "invoke", ...o };
}

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

describe("aggregateSkillUsage — graveyard math", () => {
  it("an installed skill with zero events lands in the graveyard with all-zero counts", () => {
    const { graveyard, topUsed } = aggregateSkillUsage([], [installed("dusty")], NOW);
    expect(topUsed).toEqual([]);
    expect(graveyard).toEqual([{ slug: "dusty", installed: installed("dusty"), fired30d: 0, fired90d: 0, firedTotal: 0, suggestedTotal: 0, lastFiredAt: null }]);
  });

  it("collapses a typed slash command immediately followed by its Skill tool_use into ONE firing (same session, within the dedup window)", () => {
    const events = [ev({ skillName: "grill-me", kind: "slash", at: iso(10_000) }), ev({ skillName: "grill-me", kind: "invoke", at: iso(5_000) })];
    const { topUsed } = aggregateSkillUsage(events, [installed("grill-me")], NOW);
    expect(topUsed).toHaveLength(1);
    expect(topUsed[0]).toMatchObject({ slug: "grill-me", firedTotal: 1, fired30d: 1, fired90d: 1 });
  });

  it("does NOT dedup the same skill fired twice far apart, or in two different sessions", () => {
    const events = [
      ev({ sessionId: "s1", skillName: "linear", kind: "invoke", at: iso(0) }),
      ev({ sessionId: "s1", skillName: "linear", kind: "invoke", at: iso(20 * 60_000) }), // 20 min later, same session: not deduped
      ev({ sessionId: "s2", skillName: "linear", kind: "invoke", at: iso(1000) }), // different session, same instant: not deduped
    ];
    const { topUsed } = aggregateSkillUsage(events, [installed("linear")], NOW);
    expect(topUsed[0]?.firedTotal).toBe(3);
  });

  it("splits fired30d / fired90d / firedTotal by age, independent of the dedup window", () => {
    const events = [
      ev({ skillName: "x", at: iso(5 * DAY) }), // within 30d and 90d
      ev({ skillName: "x", at: iso(50 * DAY) }), // within 90d only
      ev({ skillName: "x", at: iso(200 * DAY) }), // outside both windows, still counts toward firedTotal
    ];
    const { topUsed } = aggregateSkillUsage(events, [installed("x")], NOW);
    expect(topUsed[0]).toMatchObject({ fired30d: 1, fired90d: 2, firedTotal: 3 });
  });

  it("a skill that only fired 200 days ago still lands in the graveyard (0 in the last 90 days) even though it has fired before", () => {
    const events = [ev({ skillName: "old-timer", at: iso(200 * DAY) })];
    const { graveyard, topUsed } = aggregateSkillUsage(events, [installed("old-timer")], NOW);
    expect(topUsed).toHaveLength(1); // firedTotal > 0, so it's still "used" historically
    expect(graveyard).toHaveLength(1); // but 0 in the last 90 days, so also graveyard-eligible
  });

  it("a fired skill that isn't in the current inventory shows in Top used (installed: null) but never in the graveyard", () => {
    const events = [ev({ skillName: "since-removed", at: iso(0) })];
    const { topUsed, graveyard } = aggregateSkillUsage(events, [], NOW);
    expect(topUsed).toEqual([{ slug: "since-removed", installed: null, fired30d: 1, fired90d: 1, firedTotal: 1, suggestedTotal: 0, lastFiredAt: iso(0) }]);
    expect(graveyard).toEqual([]);
  });

  it("a router suggestion alone does not count as a firing — the skill still shows in the graveyard, with suggestedTotal set", () => {
    const events = [ev({ skillName: "declined", kind: "suggested", at: iso(0) }), ev({ skillName: "declined", kind: "suggested", at: iso(1000) })];
    const { topUsed, graveyard } = aggregateSkillUsage(events, [installed("declined")], NOW);
    expect(topUsed).toEqual([]); // never actually used
    expect(graveyard).toEqual([{ slug: "declined", installed: installed("declined"), fired30d: 0, fired90d: 0, firedTotal: 0, suggestedTotal: 2, lastFiredAt: null }]);
  });

  it("Top used sorts by fired90d desc, then firedTotal desc, then most-recent lastFiredAt desc", () => {
    const events = [
      ev({ skillName: "a", at: iso(0) }), // fired90d 1, total 1
      ev({ skillName: "b", at: iso(0) }),
      ev({ skillName: "b", at: iso(60 * 60_000) }), // fired90d 2, total 2 — should rank first
      ev({ skillName: "c", at: iso(200 * DAY) }), // fired90d 0, total 1 — should not appear in topUsed's 90d-desc lead but still listed
    ];
    const { topUsed } = aggregateSkillUsage(events, [], NOW);
    expect(topUsed.map((r) => r.slug)).toEqual(["b", "a", "c"]);
  });

  it("Graveyard sorts oldest SKILL.md first; unknown age (null updatedAt) sorts last", () => {
    const skills = [installed("mystery", { updatedAt: null }), installed("newer", { updatedAt: iso(10 * DAY) }), installed("ancient", { updatedAt: iso(400 * DAY) })];
    const { graveyard } = aggregateSkillUsage([], skills, NOW);
    expect(graveyard.map((r) => r.slug)).toEqual(["ancient", "newer", "mystery"]);
  });
});

describe("indexInstalledBySlug", () => {
  it("prefers user over plugin over project when the same slug is installed more than once", () => {
    const user = installed("dup", { origin: "user", path: "/user/dup/SKILL.md" });
    const plugin = installed("dup", { origin: "plugin", path: "/plugin/dup/SKILL.md" });
    const project = installed("dup", { origin: "project", path: "/project/dup/SKILL.md" });
    expect(indexInstalledBySlug([project, plugin, user]).get("dup")).toEqual(user);
    expect(indexInstalledBySlug([user, plugin]).get("dup")).toEqual(user);
    expect(indexInstalledBySlug([plugin, project]).get("dup")).toEqual(plugin);
  });
});
