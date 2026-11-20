import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AtlasDeptId } from "../../shared/features/atlas.js";
import type { CareerRun } from "../../shared/features/careers.js";
import type { InstalledSkill, SkillUsageRow } from "../../shared/features/skills.js";
import type { JevLookup } from "../features/atlas-jev-lib.js";
import { buildAtlas, classifyLeaf, countMemoryFiles, countMentions, descriptionHit, fileLeaf, infraYield, isDailyOrWeekly, mentionWinner, OVERRIDES, packMatch, PACKS, readBundles, ritualException, scanAgents, type AtlasInput } from "../features/atlas-lib.js";
import { createAutomationsFeature, isIncompleteDiscovery } from "../features/automations.js";
import { scanCliRegistry } from "../features/cli-station-lib.js";
import { scanSemanticMemory } from "../features/memory-layers-lib.js";
import { scanInstalledSkills } from "../features/skills-inventory.js";

/** Root reads and writes through chmod 000/444 (a container, CI as root): those cases can't fail there. */
const AS_ROOT = process.getuid?.() === 0;

const NOW = Date.parse("2026-09-30T12:00:00Z");
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

function skill(slug: string, description = ""): InstalledSkill {
  return { slug, name: slug, description, origin: "user", pluginId: null, path: `/s/${slug}/SKILL.md`, updatedAt: null };
}
function usage(slug: string, fired30d: number, fired90d: number, firedTotal: number, lastFiredAt: string | null): SkillUsageRow {
  return { slug, installed: null, fired30d, fired90d, firedTotal, suggestedTotal: 0, lastFiredAt };
}
function run(at: string): CareerRun {
  return { id: at, at, dayOnly: false, archived: false, mark: "clean", why: "" };
}
type Job = AtlasInput["automations"][number];
function job(id: string, over: Partial<Job> = {}): Job {
  const label = `com.stephane.${id}`;
  return { id, kind: "launchd", launchdLabel: label, skill: null, schedule: null, description: null, lastRunAt: null, loaded: true, plistPath: `/LA/${label}.plist`, ...over };
}
function input(over: Partial<AtlasInput> = {}): AtlasInput {
  return { nowMs: NOW, bundleTexts: new Map(), bundleCounts: new Map(), skills: { installed: [], usage: [], candidates: [] }, historyReady: true, agents: [], automations: [], workers: [], subagents: [], clis: [], ...over };
}
const cli = (name: string, entry: string) => ({ name, tool: "t", purpose: "p", entry, language: "sh", created: "2026-09-30", author: "agent" as const, tests: null });

describe("atlas-lib countMentions", () => {
  it("counts /name, [[name]] and the bare hyphenated name as whole words only", () => {
    expect(countMentions("run /acme-ship then acme-ship again, see [[acme-ship]]", "acme-ship")).toBe(3);
    expect(countMentions("acme-shipping and not-acme-ship", "acme-ship")).toBe(0);
  });

  it("a plain one-word name counts only as /name or [[name]], never as prose or a path segment", () => {
    expect(countMentions("we are done. Done when ~/.claude/skills/done/ exists", "done")).toBe(0);
    expect(countMentions("type /done or see [[done|the done skill]]", "done")).toBe(2);
    // review L1: real prose words that are also skill names
    const prose = "Keep the schedule; be careful, simplify and compress the benchmark numbers.";
    for (const name of ["schedule", "careful", "simplify", "compress", "benchmark"]) expect(countMentions(prose, name), name).toBe(0);
    expect(countMentions("run /benchmark and [[benchmark]]", "benchmark")).toBe(2);
    expect(countMentions("last30days found it", "last30days")).toBe(1); // a digit makes it distinctive
  });

  it("uses a plugin skill's own name and a Tower key without its clock", () => {
    expect(countMentions("the /triage-nda step", "legal:triage-nda")).toBe(1);
    expect(countMentions("rss-feed-obsidian runs hourly", "⏰ rss-feed-obsidian")).toBe(1);
  });
});

describe("atlas-lib classifyLeaf: mention > keyword > unfiled", () => {
  const texts = new Map<AtlasDeptId, string>([
    ["acme-gtm", "use /linear for tickets; /linear again"],
    ["infra", "/linear once; the hermes-loop skill"],
    ["rituals", "hermes-loop before the day starts"],
  ]);

  it("the department with the most mentions wins", () => {
    expect(classifyLeaf("linear", "", texts)).toEqual({ dept: "acme-gtm", reason: "mentioned 2× in ACME GTM" });
  });

  it("a tie goes to the earlier department", () => {
    expect(classifyLeaf("hermes-loop", "", texts)).toEqual({ dept: "infra", reason: "mentioned 1× in Infra + Claude" });
  });

  it("a mention beats a keyword that points elsewhere", () => {
    const t = new Map<AtlasDeptId, string>([["rituals", "then /acme-lab runs"]]);
    expect(classifyLeaf("acme-lab", "", t)).toEqual({ dept: "rituals", reason: "mentioned 1× in Rituals" });
  });

  it("falls back to the keyword table: name tokens before the description", () => {
    expect(classifyLeaf("acme-lab", "", new Map())).toEqual({ dept: "acme-gtm", reason: "keyword acme" });
    expect(classifyLeaf("legal:triage-nda", "helps sales", new Map())).toEqual({ dept: "side-projects", reason: "keyword legal" });
    expect(classifyLeaf("zeta", "Writes SEO copy", new Map())).toEqual({ dept: "acme-website", reason: "keyword seo (description)" });
  });

  it("nothing matches: unfiled", () => {
    expect(classifyLeaf("zeta", "does a thing", new Map())).toEqual({ dept: "unfiled", reason: "unfiled" });
  });
});

describe("atlas-lib fileLeaf: mention > pack > keyword > Jev > unfiled, each with its reason", () => {
  const GS = "/h/.claude/skills/gstack";
  const gtm = new Map<AtlasDeptId, string>([["acme-gtm", "ship it with /hyperframes-seo and /qa-lab"]]);

  it("a bundle mention beats the pack and the keyword that point elsewhere", () => {
    expect(fileLeaf("qa-lab", "", gtm, { path: `${GS}/qa-lab/SKILL.md` })).toEqual({ dept: "acme-gtm", via: "mention", reason: "mentioned 1× in ACME GTM" });
  });

  it("the pack beats a keyword: HyperFrames' pack, not the 'seo' keyword", () => {
    expect(fileLeaf("hyperframes-seo", "", new Map(), { path: "/h/.claude/skills-repo/hyperframes-seo/SKILL.md" })).toEqual({ dept: "research-studio", via: "pack", reason: "pack HyperFrames" });
  });

  it("the keyword table fills the three new departments", () => {
    expect(fileLeaf("senior-software-engineer", "", new Map())).toMatchObject({ dept: "build-ship", via: "keyword", reason: "keyword engineer" });
    expect(fileLeaf("deck-agent", "", new Map())).toMatchObject({ dept: "research-studio", via: "keyword", reason: "keyword deck" }); // before infra's "agent"
    expect(fileLeaf("memory-vector", "", new Map())).toMatchObject({ dept: "brain-vault", via: "keyword", reason: "keyword memory" });
    expect(fileLeaf("recall", "Full-text search", new Map())).toMatchObject({ dept: "brain-vault", reason: "keyword recall" });
    expect(fileLeaf("compress", "Compress natural language memory files", new Map())).toMatchObject({ dept: "brain-vault", reason: "keyword memory files (description)" });
    expect(fileLeaf("legal:brief", "", new Map())).toMatchObject({ dept: "side-projects", reason: "keyword legal" }); // "brief" alone no longer says ritual
    expect(fileLeaf("fleet-probe", "", new Map())).toMatchObject({ dept: "infra", reason: "keyword fleet" });
  });

  it("broad words no longer file: 'Claude', 'skill', 'agent' or 'code' in a description land nothing", () => {
    for (const d of ["Make Claude act like a pope", "a skill for the agent", "zoom out from the current code"]) expect(fileLeaf("zeta", d, new Map()).via, d).toBe("unfiled");
  });

  it("buildAtlas asks Jev only what no rule filed, shows its verdict, and keeps rule-filed leaves away from it", () => {
    const asked: string[] = [];
    const verdicts: Record<string, JevLookup> = {
      zeta: { kind: "answer", dept: "build-ship", confidence: 0.84 },
      eta: { kind: "answer", dept: "brain-vault", confidence: 0.42 },
      theta: { kind: "pending" },
      iota: { kind: "unavailable" },
      kappa: { kind: "answer", dept: null, confidence: 0 },
    };
    const names = ["zeta", "eta", "theta", "iota", "kappa", "tdd", "linear"];
    const r = buildAtlas(
      input({
        bundleTexts: new Map([["acme-gtm", "/linear"]]),
        skills: { installed: names.map((n) => skill(n, "does a thing")), usage: [], candidates: [] },
        jev: (a) => (asked.push(a.name), verdicts[a.name] ?? { kind: "unavailable" }),
      }),
    );
    const by = new Map(r.leaves.map((l) => [l.name, l]));
    expect(asked.sort()).toEqual(["eta", "iota", "kappa", "theta", "zeta"]); // never tdd (keyword) or linear (mention)
    expect(by.get("zeta")).toMatchObject({ dept: "build-ship", via: "jev", reason: "Jev 0.84" });
    expect(by.get("eta")).toMatchObject({ dept: "unfiled", via: "unfiled", reason: "Jev unsure (0.42)" });
    expect(by.get("theta")).toMatchObject({ dept: "unfiled", reason: "Jev pending" });
    expect(by.get("iota")).toMatchObject({ dept: "unfiled", reason: "Jev unavailable" });
    expect(by.get("kappa")).toMatchObject({ dept: "unfiled", reason: "Jev unsure (no answer)" });
    expect(by.get("tdd")).toMatchObject({ dept: "build-ship", via: "keyword" });
    expect(by.get("linear")).toMatchObject({ dept: "acme-gtm", via: "mention" });
    expect(r.jevAsks).toEqual([{ name: "theta", description: "does a thing" }]); // only the pending one is asked for
    expect(buildAtlas(input({ skills: { installed: [skill("zeta")], usage: [], candidates: [] } })).leaves[0]).toMatchObject({ dept: "unfiled", via: "unfiled", reason: "unfiled" }); // no Jev step at all
  });

  it("Jev sees the name (without the Tower's clock) and the capped description, never bundle text", () => {
    const secret = "the orange heron sleeps under bridge nine";
    const asks: { name: string; description: string }[] = [];
    buildAtlas(
      input({
        bundleTexts: new Map<AtlasDeptId, string>([["infra", `${secret} zeta`], ["rituals", secret]]),
        skills: { installed: [skill("zeta", "x".repeat(400))], usage: [], candidates: [] },
        workers: [{ key: "⏰ lonely-task", routine: null, lifetime: { total: 1, live: 0, archived: 0, clean: 1, wrote: 0, bad: 0 }, lastRunAt: daysAgo(1), runs: [run(daysAgo(1))] }],
        jev: (a) => (asks.push(a), { kind: "pending" }),
      }),
    );
    expect(asks.map((a) => a.name).sort()).toEqual(["lonely-task", "zeta"]);
    expect(asks.find((a) => a.name === "zeta")?.description).toHaveLength(280);
    expect(JSON.stringify(asks)).not.toContain("heron");
  });
});

describe("atlas-lib the ritual exception to 'mention wins'", () => {
  const infra = new Map<AtlasDeptId, string>([["infra", "incident: /daily-recap broke; /daily-recap again; brain-sync too"]]);

  it("a daily or weekly job the Infra bundle names, with a ritual name, files under Rituals and says why", () => {
    expect(fileLeaf("daily-recap", "", infra, { schedule: "daily 08:10" })).toEqual({ dept: "rituals", via: "ritual", reason: 'ritual: daily 08:10 + name "recap" (mentioned 2× in Infra + Claude)' });
    expect(fileLeaf("daily-recap", "", infra, { schedule: "Sunday 07:00" }).dept).toBe("rituals");
  });

  it("does not apply without a daily/weekly schedule, without a ritual name, or outside the Infra bundle", () => {
    expect(fileLeaf("daily-recap", "", infra)).toMatchObject({ dept: "infra", via: "mention" });
    expect(fileLeaf("daily-recap", "", infra, { schedule: "every 15 min" }).dept).toBe("infra");
    expect(fileLeaf("daily-recap", "", infra, { schedule: "monthly on the 1st 19:00" }).dept).toBe("infra");
    const odd = new Map<AtlasDeptId, string>([["infra", "odd-job broke"]]);
    expect(fileLeaf("odd-job", "", odd, { schedule: "daily 06:00" })).toMatchObject({ dept: "infra", via: "mention" }); // name doesn't say ritual
    const gtm = new Map<AtlasDeptId, string>([["acme-gtm", "/daily-recap"]]);
    expect(fileLeaf("daily-recap", "", gtm, { schedule: "daily 08:10" })).toMatchObject({ dept: "acme-gtm", via: "mention" });
    expect(ritualException("daily-recap", "daily 08:10", "rituals")).toBeNull();
  });

  it("schedule words: daily and weekly yes, intervals and monthly no", () => {
    for (const t of ["daily 08:00", "3x daily", "weekdays 09:00", "Mon/Thu 09:00", "Sunday 09:30"]) expect(isDailyOrWeekly(t), t).toBe(true);
    for (const t of ["every 5 min", "every 4h", "hourly at :15", "monthly on the 1st 19:00", "monthly on the 1st or Monday 19:00", "manual / unknown", ""]) expect(isDailyOrWeekly(t), t).toBe(false);
  });

  it("buildAtlas reads the schedule from the launchd job, paused or not, for the routine and its skill", () => {
    const r = buildAtlas(
      input({
        bundleTexts: new Map<AtlasDeptId, string>([["infra", "yalla-brief broke, then daily-recap and daily-recap"]]),
        automations: [
          job("daily-recap", { skill: "daily-recap", schedule: "daily 08:10" }),
          { ...job("yalla-brief"), launchdLabel: "dev.dashable.yalla-brief", skill: "yalla-brief", schedule: "daily 08:00", loaded: false },
        ],
        skills: { installed: [skill("daily-recap"), skill("yalla-brief")], usage: [], candidates: [] },
      }),
    );
    const by = new Map(r.leaves.map((l) => [l.id, l]));
    expect(by.get("routine:daily-recap")).toMatchObject({ dept: "rituals", via: "ritual" });
    expect(by.get("skill:daily-recap")).toMatchObject({ dept: "rituals", via: "ritual" });
    expect(by.get("skill:yalla-brief")).toMatchObject({ dept: "rituals", via: "ritual", reason: 'ritual: daily 08:00 + name "yalla-brief" (mentioned 1× in Infra + Claude)' });
  });
});

describe("atlas-lib the Infra yield: an Infra mention gives way to a new department's pack or name keyword", () => {
  const infra = new Map<AtlasDeptId, string>([["infra", "gotchas: /ingest, /humanizer, obsidian-markdown, brain-sync, /grill-me, /cli-forge, /grok-delegation, /tdd-lab, then daily-recap"]]);

  it("yields to a pack or a name keyword pointing at Build & ship, Research & studio or Brain & vault, and says both", () => {
    expect(fileLeaf("obsidian:obsidian-markdown", "", infra)).toEqual({ dept: "brain-vault", via: "yield", reason: "pack obsidian plugin (mentioned 1× in Infra + Claude)" });
    expect(fileLeaf("ingest", "", infra)).toEqual({ dept: "brain-vault", via: "yield", reason: "keyword ingest (mentioned 1× in Infra + Claude)" });
    expect(fileLeaf("humanizer", "", infra)).toMatchObject({ dept: "research-studio", via: "yield", reason: "keyword humanizer (mentioned 1× in Infra + Claude)" });
    expect(fileLeaf("brain-sync", "", infra)).toMatchObject({ dept: "brain-vault", via: "yield" });
    expect(fileLeaf("grill-me", "", infra)).toMatchObject({ dept: "build-ship", via: "yield" });
    expect(fileLeaf("tdd-lab", "", infra, { path: "/h/.claude/skills/gstack/tdd-lab/SKILL.md" })).toMatchObject({ dept: "build-ship", via: "yield", reason: "pack gstack (mentioned 1× in Infra + Claude)" });
  });

  it("does not yield to Infra's own words, an old department's keyword, a description word, or outside Infra", () => {
    expect(fileLeaf("cli-forge", "", infra)).toMatchObject({ dept: "infra", via: "mention" }); // its keyword is Infra's own
    expect(fileLeaf("grok:grok-delegation", "", infra)).toMatchObject({ dept: "infra", via: "mention" }); // its pack is Infra's
    expect(infraYield("acme-thing", null)).toBeNull(); // ACME GTM is not one of the three
    expect(infraYield("zeta", null)).toBeNull(); // a description never counts here
    const gtm = new Map<AtlasDeptId, string>([["acme-gtm", "/ingest"]]);
    expect(fileLeaf("ingest", "", gtm)).toMatchObject({ dept: "acme-gtm", via: "mention" });
  });

  it("the ritual exception is tried first", () => {
    const t = new Map<AtlasDeptId, string>([["infra", "/daily-research broke"]]);
    expect(fileLeaf("daily-research", "", t, { schedule: "daily 07:00" })).toMatchObject({ dept: "rituals", via: "ritual" });
    expect(fileLeaf("daily-research", "", t)).toMatchObject({ dept: "research-studio", via: "yield" });
  });
});

describe("atlas-lib mention ties and the override table", () => {
  const four = new Map<AtlasDeptId, string>([
    ["acme-website", "/memory-layer"],
    ["acme-gtm", "/memory-layer"],
    ["infra", "/memory-layer /zeta-tool"],
    ["side-projects", "/memory-layer /zeta-tool"],
    ["rituals", "/zeta-tool"],
  ]);

  it("a tie of three or more departments is no mention: the leaf falls through and says why", () => {
    expect(mentionWinner("memory-layer", four)).toEqual({ tie: 4, n: 1 });
    expect(fileLeaf("memory-layer", "", four)).toEqual({ dept: "brain-vault", via: "keyword", reason: "keyword memory (mentions tied: 1× in each of 4 departments)" });
    expect(fileLeaf("zeta-tool", "does a thing", four)).toMatchObject({ dept: "unfiled", via: "unfiled" }); // 3-way: on to Jev
    const r = buildAtlas(input({ bundleTexts: four, skills: { installed: [skill("zeta-tool", "does a thing")], usage: [], candidates: [] }, jev: () => ({ kind: "answer", dept: "research-studio", confidence: 0.9 }) }));
    expect(r.leaves[0]).toMatchObject({ dept: "research-studio", via: "jev", reason: "Jev 0.90" });
  });

  it("a tie of two still goes to the earlier department; a clear winner stays a mention", () => {
    const two = new Map<AtlasDeptId, string>([["acme-gtm", "/x-tool"], ["side-projects", "/x-tool"], ["rituals", "/y-tool /y-tool"], ["infra", "/y-tool"], ["acme-website", "/y-tool"]]);
    expect(fileLeaf("x-tool", "", two)).toMatchObject({ dept: "acme-gtm", via: "mention" });
    expect(fileLeaf("y-tool", "", two)).toMatchObject({ dept: "rituals", via: "mention", reason: "mentioned 2× in Rituals" }); // 2 beats three 1s
  });

  it("an override beats every rule, matches the name without the Tower's clock, and names a real department", () => {
    const all = new Map<AtlasDeptId, string>([["acme-gtm", "/connection-synthesis /connection-synthesis"]]);
    expect(fileLeaf("connection-synthesis", "Writes SEO copy", all, { path: "/h/.claude/skills/gstack/x/SKILL.md" })).toEqual({ dept: "brain-vault", via: "override", reason: "override" });
    expect(fileLeaf("⏰ connection-synthesis", "", new Map())).toMatchObject({ dept: "brain-vault", via: "override" });
    expect(fileLeaf("last30days", "", new Map([["infra", "last30days"]]))).toMatchObject({ dept: "research-studio", via: "override" });
    for (const [name, dept] of Object.entries(OVERRIDES)) expect(dept, name).not.toBe("unfiled");
    expect(Object.keys(OVERRIDES).length).toBeLessThanOrEqual(15); // small on purpose: a longer list means a rule is missing
    let asked = 0;
    buildAtlas(input({ automations: [job("connection-synthesis")], jev: () => (asked++, { kind: "pending" }) }));
    expect(asked).toBe(0); // an overridden leaf never reaches Jev
  });
});

describe("atlas-lib keyword hits that don't count (review L3: mislabels on real data)", () => {
  it("a negated description word doesn't count: 'not the ACME company account'", () => {
    expect(descriptionHit("posts for his personal account (not the acme company account, not a linkedin cross-post)", "acme")).toBe(false);
    expect(descriptionHit("posts for his personal account (not the acme company account, not a linkedin cross-post)", "linkedin")).toBe(false);
    for (const d of ["never acme", "no sales pitch", "it isn't a acme tool", "it isn’t a acme tool".replace(/’/g, "'"), "without any acme data"]) expect(descriptionHit(d, d.includes("sales") ? "sales" : "acme"), d).toBe(false);
    expect(descriptionHit("not for the big old acme account", "acme")).toBe(true); // four words back: out of reach
    expect(descriptionHit("not slow, acme first", "acme")).toBe(true); // a comma ends the negated clause
    expect(descriptionHit("not the acme account; built for acme sales", "acme")).toBe(true); // one live hit is enough
    expect(descriptionHit("a knotted rope and acme", "acme")).toBe(true); // "knotted" is not "not"
  });

  it("a short word that is one item of a slash list doesn't count; longer words and prose do", () => {
    expect(descriptionHit("the full a11y/seo/rtl/perf rulebook", "seo")).toBe(false);
    expect(descriptionHit("seo/geo audits", "seo")).toBe(false);
    expect(descriptionHit("writes seo copy", "seo")).toBe(true);
    expect(descriptionHit("legal/compliance research", "legal")).toBe(true); // 5+ letters: a real subject
  });

  it("the real mislabels' root causes are gone (names other than the overridden ones, so only the rules answer)", () => {
    const xPost = "Write X/Twitter-native posts and run the X reply-engagement engine for Alex's personal account (not the ACME company account, not a LinkedIn cross-post).";
    expect(fileLeaf("post-thing", xPost, new Map()).dept).not.toBe("acme-gtm");
    const ascii = "Premium ASCII / text-mode design system for the web: FIGlet-style wordmarks, box-drawing frames, and the full a11y/SEO/RTL/perf rulebook for shipping it.";
    expect(fileLeaf("glyph-kit", ascii, new Map()).dept).not.toBe("acme-website");
    expect(fileLeaf("some-world-model", "Reviews LLM-agent designs for missing world-model scaffolding.", new Map()).dept).not.toBe("infra");
    expect(fileLeaf("release-the-kraken", "Maximum-effort orchestration mode.", new Map([["infra", "/release-the-kraken"]]))).toMatchObject({ dept: "infra", via: "mention" }); // no yield on "release"
    expect(fileLeaf("acme-aeo-explainer", "", new Map())).toMatchObject({ dept: "acme-website", reason: "keyword acme-aeo" });
    expect(fileLeaf("zeta", "Writes SEO copy", new Map())).toMatchObject({ dept: "acme-website" }); // still a real hit
    expect(fileLeaf("zeta", "It isn’t a ACME tool", new Map()).dept).toBe("unfiled"); // a curly apostrophe negates too
  });

  it("the override table files the leaves no root rule gets right, and only names real departments", () => {
    const want: Record<string, string> = {
      "lexwiki-learn": "side-projects",
      "ai-claims-critic": "research-studio",
      "pick-model": "infra",
      "⏰ daily-legal-llm-benchmark": "side-projects",
      "⏰ pe-biotech-competitor-scan": "research-studio",
      "x-post": "side-projects",
      "ascii-art": "research-studio",
      "lecun-world-model": "build-ship",
      "model-spec-diff": "side-projects",
    };
    for (const [name, dept] of Object.entries(want)) expect(fileLeaf(name, "ACME legal marketing daily", new Map()), name).toEqual({ dept, via: "override", reason: "override" });
    for (const [name, dept] of Object.entries(OVERRIDES)) {
      expect(dept, name).not.toBe("unfiled");
      expect(name.startsWith("⏰"), name).toBe(false); // keys are names without the Tower's clock
    }
  });
});

describe("atlas-lib sources report failed reads (review L5), never a missing folder", () => {
  it.skipIf(AS_ROOT)("scanAgents: a missing folder is quiet; an unreadable folder or file reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-l5-"));
    const errors: unknown[] = [];
    expect(await scanAgents(join(dir, "nope"), (e) => errors.push(e))).toEqual([]);
    expect(errors).toEqual([]);
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "ok.md"), "---\nname: ok\n---\n");
    await writeFile(join(dir, "agents", "locked.md"), "---\nname: locked\n---\n");
    await chmod(join(dir, "agents", "locked.md"), 0o000);
    const some = await scanAgents(join(dir, "agents"), (e) => errors.push(e));
    expect(some.map((a) => a.name)).toEqual(["ok"]);
    expect(errors).toHaveLength(1);
    await chmod(join(dir, "agents"), 0o000);
    expect(await scanAgents(join(dir, "agents"), (e) => errors.push(e))).toEqual([]);
    expect(errors).toHaveLength(2);
    await chmod(join(dir, "agents"), 0o755);
    await chmod(join(dir, "agents", "locked.md"), 0o644);
  });

  it.skipIf(AS_ROOT)("scanCliRegistry: no registry or a folder without cli.json is quiet; an unreadable one reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-l5-cli-"));
    const errors: unknown[] = [];
    expect((await scanCliRegistry(join(dir, "nope"), (e) => errors.push(e))).registryPresent).toBe(false);
    await mkdir(join(dir, "clis", "empty"), { recursive: true });
    await mkdir(join(dir, "clis", "locked"));
    await writeFile(join(dir, "clis", "locked", "cli.json"), "{}");
    await chmod(join(dir, "clis", "locked", "cli.json"), 0o000);
    await scanCliRegistry(join(dir, "clis"), (e) => errors.push(e));
    expect(errors).toHaveLength(1); // the locked cli.json, not the empty folder
    await chmod(join(dir, "clis", "locked", "cli.json"), 0o644);
  });

  it.skipIf(AS_ROOT)("automations: an unreadable LaunchAgents folder marks the discovery incomplete; a missing one doesn't", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-l5-auto-"));
    const deps = { home: dir, skillsDir: join(dir, "skills"), scheduledTasksDir: join(dir, "tasks"), launchctlList: async (): Promise<string> => "" };
    const missing = await createAutomationsFeature({ ...deps, launchAgentsDir: join(dir, "nope") }).discover();
    expect(isIncompleteDiscovery(missing)).toBe(false);
    await mkdir(join(dir, "LA"));
    await chmod(join(dir, "LA"), 0o000);
    const locked = await createAutomationsFeature({ ...deps, launchAgentsDir: join(dir, "LA") }).discover();
    expect(isIncompleteDiscovery(locked)).toBe(true);
    await chmod(join(dir, "LA"), 0o755);
  });
});

describe("atlas-lib PACKS: the install origin", () => {
  const p = (name: string, path: string | null = null): string | null => {
    const m = packMatch(name, path);
    return m ? `${m.pack} → ${m.dept}` : null;
  };

  it("gstack by folder, with make-pdf and scrape split off to Research & studio", () => {
    expect(p("qa", "/h/.claude/skills/gstack/qa/SKILL.md")).toBe("gstack → build-ship");
    expect(p("gstack", "/h/.claude/skills/gstack/SKILL.md")).toBe("gstack → build-ship");
    expect(p("make-pdf", "/h/.claude/skills/gstack/make-pdf/SKILL.md")).toBe("gstack → research-studio");
    expect(p("scrape", "/h/.claude/skills/gstack/scrape/SKILL.md")).toBe("gstack → research-studio");
    expect(p("make-pdf", "/h/.claude/skills-repo/make-pdf/SKILL.md")).toBeNull(); // not gstack's copy
    expect(p("qa", "/h/notes/gstack-ideas/qa.md")).toBeNull();
  });

  it("name prefixes and plugin namespaces", () => {
    expect(p("hyperframes")).toBe("HyperFrames → research-studio");
    expect(p("hyperframes-keyframes")).toBe("HyperFrames → research-studio");
    expect(p("firecrawl-map")).toBe("Firecrawl → research-studio");
    expect(p("cs-create-prd")).toBe("CodeSpring → build-ship");
    expect(p("codespring")).toBe("CodeSpring → build-ship");
    expect(p("cso")).toBeNull(); // not "cs-"
    expect(p("obsidian:knap")).toBe("obsidian plugin → brain-vault");
    expect(p("grok:grok-delegation")).toBe("grok plugin → infra");
    expect(p("typesafe:typesafe-ai")).toBe("typesafe plugin → infra");
    expect(p("skillspec:skillspec")).toBe("skillspec plugin → infra");
    expect(p("legal:triage-nda")).toBeNull(); // legal plugin skills file by the 'legal' keyword
    expect(p("knap")).toBeNull();
  });

  it("every row names a real department (never Unfiled) and a pack split lists its exceptions first", () => {
    for (const row of PACKS) expect(row.dept).not.toBe("unfiled");
    const gstack = PACKS.filter((r) => r.pack === "gstack");
    expect(gstack[0]?.only).toBeDefined();
    expect(gstack[gstack.length - 1]?.only).toBeUndefined();
  });
});

describe("atlas-lib buildAtlas: the autonomy ladder carries its evidence", () => {
  it("skills: a loaded job or a scheduled task → autonomous; fired in 30 days → assisted; the Skills view's graveyard", () => {
    const r = buildAtlas(
      input({
        skills: {
          installed: [skill("brief"), skill("paused-one"), skill("tasked"), skill("says-so"), skill("busy"), skill("old"), skill("quiet"), skill("ghost")],
          usage: [usage("busy", 4, 9, 20, daysAgo(1)), usage("old", 0, 0, 3, daysAgo(120)), usage("quiet", 0, 2, 2, daysAgo(50))],
          candidates: [{ slug: "maybe", name: "maybe", description: "", queuedAt: null, evidenceCount: null, confidence: null, path: "/p/maybe/SKILL.md" }],
        },
        automations: [
          job("brief", { skill: "brief", schedule: "daily 08:00" }),
          job("paused-one", { skill: "paused-one", loaded: false }),
          { ...job("tasked"), kind: "skill", launchdLabel: null, skill: "tasked", scheduledBy: "scheduled-task", loaded: undefined, plistPath: undefined },
          { ...job("says-so"), kind: "skill", launchdLabel: null, skill: "says-so", scheduledBy: "self-described", loaded: undefined, plistPath: undefined },
        ],
      }),
    );
    const by = new Map(r.leaves.map((l) => [l.id, l]));
    expect(by.get("skill:brief")).toMatchObject({ autonomy: "autonomous", evidence: "run by launchd com.stephane.brief · daily 08:00" });
    expect(by.get("skill:paused-one")).toMatchObject({ autonomy: "manual", evidence: "graveyard: never fired" });
    expect(by.get("skill:tasked")).toMatchObject({ autonomy: "autonomous", evidence: "a scheduled task invokes it" });
    expect(by.get("skill:says-so")).toMatchObject({ autonomy: "manual" }); // review L6: its own description is not a scheduler
    expect(by.get("skill:busy")).toMatchObject({ autonomy: "assisted", evidence: "fired 4× in the last 30 days", uses: 20, uses30d: 4 });
    expect(by.get("skill:old")).toMatchObject({ autonomy: "manual", evidence: `graveyard: last fired ${daysAgo(120).slice(0, 10)}, none in 90 days` });
    expect(by.get("skill:quiet")).toMatchObject({ autonomy: "manual", evidence: `last fired ${daysAgo(50).slice(0, 10)}, none in 30 days` });
    expect(by.get("skill:ghost")).toMatchObject({ autonomy: "manual", evidence: "graveyard: never fired" }); // review L5: same graveyard as the Skills view
    expect(by.get("skill:maybe")).toMatchObject({ autonomy: "manual", evidence: "candidate in the review queue (not installed)" });
    expect(buildAtlas(input({ historyReady: false, skills: { installed: [skill("ghost")], usage: [], candidates: [] } })).leaves[0]?.evidence).toBe("no fires found yet (skill history still loading)");
  });

  it("routines: launchd's load state decides; unread is unknown (null), never autonomous (review M2)", () => {
    const r = buildAtlas(
      input({
        automations: [
          job("brief", { schedule: "daily 08:00" }),
          job("eulex-bench", { loaded: false }),
          job("unread", { loaded: undefined }),
          { ...job("yalla-brief"), launchdLabel: "dev.dashable.yalla-brief", skill: "yalla-brief", loaded: false },
          { ...job("odd"), plistPath: "/LA/odd-file-name.plist" },
        ],
        skills: { installed: [skill("yalla-brief")], usage: [], candidates: [] },
      }),
    );
    const by = new Map(r.leaves.map((l) => [l.id, l]));
    expect(by.get("routine:brief")).toMatchObject({ autonomy: "autonomous", evidence: "launchd com.stephane.brief · daily 08:00", path: "/LA/com.stephane.brief.plist" });
    expect(by.get("routine:eulex-bench")).toMatchObject({ autonomy: "manual", evidence: "paused: launchd has not loaded com.stephane.eulex-bench" });
    expect(by.get("routine:unread")).toMatchObject({ autonomy: null, evidence: "launchd com.stephane.unread (load state not read: launchctl list unavailable)" });
    expect(by.get("skill:yalla-brief")?.autonomy).toBe("manual"); // review L6: a paused dev.dashable job schedules nothing either
    expect(by.get("routine:odd")?.path).toBe("/LA/odd-file-name.plist"); // review L2: the scan's file, not a name built from the Label
  });

  it("agents, Tower workers and CLIs; ids stay unique (review L3)", () => {
    const r = buildAtlas(
      input({
        agents: [
          { name: "reviewer", description: "", path: "/a/reviewer.md" },
          { name: "reviewer", description: "", path: "/a/reviewer-2.md" },
          { name: "idle", description: "", path: "/a/idle.md" },
        ],
        subagents: [
          { agentType: "reviewer", startedAt: daysAgo(2) },
          { agentType: "reviewer", startedAt: daysAgo(60) },
        ],
        workers: [
          { key: "⏰ rss-feed", routine: null, lifetime: { total: 12, live: 0, archived: 0, clean: 12, wrote: 0, bad: 0 }, lastRunAt: daysAgo(1), runs: [run(daysAgo(1)), run(daysAgo(3))] },
          { key: "⏰ old-task", routine: null, lifetime: { total: 1, live: 0, archived: 1, clean: 0, wrote: 0, bad: 0 }, lastRunAt: daysAgo(90), runs: [run(daysAgo(90))] },
          { key: "/grill-me", routine: null, lifetime: { total: 5, live: 0, archived: 0, clean: 5, wrote: 0, bad: 0 }, lastRunAt: daysAgo(1), runs: [] },
        ],
        clis: [cli("recall", "/c/b/recall.py"), cli("recall", "/c/a/recall.py"), cli("jev", "/c/jev.py")],
      }),
    );
    const by = new Map(r.leaves.map((l) => [l.id, l]));
    expect(by.get("agent:reviewer")).toMatchObject({ autonomy: "assisted", evidence: "spawned 1× in the last 30 days", uses: 2 });
    expect(by.get("agent:reviewer-2")?.name).toBe("reviewer");
    expect(by.get("agent:idle")).toMatchObject({ autonomy: "manual", evidence: "never spawned as a subagent" });
    expect(by.get("routine:⏰ rss-feed")).toMatchObject({ autonomy: "autonomous", evidence: "scheduled task · ran 2× in the last 30 days", uses: 12 });
    expect(by.get("routine:⏰ old-task")).toMatchObject({ autonomy: "manual", evidence: `last ran ${daysAgo(90).slice(0, 10)}, none in 30 days` });
    expect(by.has("routine:/grill-me")).toBe(false); // a typed /skill is the skill's leaf, not a routine
    expect(by.get("cli:recall")?.path).toBe("/c/a/recall.py");
    expect(by.get("cli:recall@/c/b/recall.py")?.path).toBe("/c/b/recall.py");
    expect(by.get("cli:jev")).toMatchObject({ autonomy: "manual", evidence: "no run record: CLI runs aren't logged" });
    const rev = buildAtlas(input({ clis: [cli("recall", "/c/a/recall.py"), cli("recall", "/c/b/recall.py")].reverse() }));
    expect(rev.leaves.map((l) => l.id)).toEqual(["cli:recall", "cli:recall@/c/b/recall.py"]);
    expect(buildAtlas(input({ agents: [{ name: "x", description: "", path: "/x.md" }], subagents: null })).leaves[0]).toMatchObject({ evidence: "subagent history not read yet", uses: null });
  });

  it("empty inputs: every department listed with 0 leaves", () => {
    const r = buildAtlas(input({ workers: null, subagents: null }));
    expect(r.leaves).toEqual([]);
    expect(r.departments.map((d) => [d.id, d.leaves])).toEqual([
      ["acme-website", 0],
      ["acme-gtm", 0],
      ["infra", 0],
      ["rituals", 0],
      ["side-projects", 0],
      ["build-ship", 0],
      ["research-studio", 0],
      ["brain-vault", 0],
      ["unfiled", 0],
    ]);
  });
});

describe("atlas-lib fs readers", () => {
  it("missing dirs read as empty, never throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-none-"));
    const b = await readBundles(join(dir, "nope"));
    expect(b.texts.size).toBe(0);
    expect([...b.counts.values()].every((n) => n === 0)).toBe(true);
    expect(await scanAgents(join(dir, "nope"))).toEqual([]);
    expect(await countMemoryFiles(join(dir, "nope"))).toBeNull();
  });

  it("counts memory files like memory-layers, from the listing alone (review L4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-mem-"));
    for (const f of ["MEMORY.md", "a.md", "b.md", "notes.txt"]) await writeFile(join(dir, f), "x");
    await mkdir(join(dir, "_L2"));
    expect(await countMemoryFiles(dir)).toBe(2);
    expect((await scanSemanticMemory({ memoryDir: dir, now: NOW })).fileCount).toBe(2);
  });

  it("a malformed SKILL.md is skipped by the inventory; a malformed agent keeps its file name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-bad-"));
    await mkdir(join(dir, "skills", "good"), { recursive: true });
    await mkdir(join(dir, "skills", "bad"), { recursive: true });
    await writeFile(join(dir, "skills", "good", "SKILL.md"), "---\nname: good\ndescription: fine\n---\nbody");
    await writeFile(join(dir, "skills", "bad", "SKILL.md"), "---\nname good: [unclosed\nno closing fence");
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "broken.md"), "--\nname:\n");
    const installed = await scanInstalledSkills({ skillsDir: join(dir, "skills"), pluginsCacheDir: join(dir, "none"), repoRoots: [] });
    const r = buildAtlas(input({ skills: { installed, usage: [], candidates: [] }, agents: await scanAgents(join(dir, "agents")) }));
    expect(r.leaves.map((l) => l.id)).toEqual(["agent:broken", "skill:good"]);
    expect(r.leaves[0]).toMatchObject({ description: "", path: join(dir, "agents", "broken.md") });
  });
});
