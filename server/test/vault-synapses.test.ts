import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { VaultNote } from "../../shared/features/vault.js";
import { SynapseReader, hiddenFromFiring, parseSynapses, synapsesOf, vaultFiring } from "../features/vault-synapses.js";

const T = 20_400; // any day index

function note(id: string, path: string, day: number | null): VaultNote {
  return {
    id, path, kind: "n", type: "", day, hour: null, project: "", umbrella: "", tags: [], links: [], ghosts: [],
    minutes: null, mentionWeeks: null, mentionLast: null, up: null, upRule: "",
  };
}

// A session today used neurons; neurons is wired to hebbian (strong) and graph theory (weak),
// plus a hub and a machine run that must never surface.
const TSV = [
  "sess\t10-Sessions/2026-11-10-brain.md\tneur:0.5",
  "neur\t30-Knowledge/concepts/neurons.md\tsess:0.5,hebb:0.6,grph:0.1,hub:0.5,auto:0.5",
  "hebb\t30-Knowledge/concepts/hebbian.md\tneur:0.6",
  "grph\t30-Knowledge/concepts/graph-theory.md\tneur:0.1",
  "hub\t20-Projects/brain/_index.md\tneur:0.5",
  "auto\t10-Sessions/automations/2026-11-10-run.md\tneur:0.5",
  "junk line without tabs",
].join("\n");

const g = parseSynapses(TSV);
const notes = [
  note("sess", "10-Sessions/2026-11-10-brain.md", T),
  note("neur", "30-Knowledge/concepts/neurons.md", null),
  note("hebb", "30-Knowledge/concepts/hebbian.md", T - 30),
  note("grph", "30-Knowledge/concepts/graph-theory.md", null),
  note("auto", "10-Sessions/automations/2026-11-10-run.md", T),
];

describe("synapses", () => {
  it("parses the cache and skips junk", () => {
    expect(g.byId.size).toBe(6);
    expect(g.byPath.get("30-knowledge/concepts/neurons.md")).toBe("neur");
  });

  it("lists a note's strongest synapses, hiding structure and machine notes", () => {
    const s = synapsesOf(g, "30-Knowledge/concepts/Neurons");
    expect(s.map((x) => x.path)).toEqual([
      "30-Knowledge/concepts/hebbian.md",
      "10-Sessions/2026-11-10-brain.md",
      "30-Knowledge/concepts/graph-theory.md",
    ]);
    expect(synapsesOf(g, "nowhere.md")).toEqual([]);
  });

  it("hiddenFromFiring", () => {
    expect(hiddenFromFiring("20-Projects/brain/_index.md")).toBe(true);
    expect(hiddenFromFiring("60-Meta/brain-synapses.md")).toBe(true);
    expect(hiddenFromFiring("10-Sessions/automations/x.md")).toBe(true);
    expect(hiddenFromFiring("30-Knowledge/concepts/neurons.md")).toBe(false);
  });
});

describe("vaultFiring", () => {
  it("today's notes fire and the signal spreads one hop past the threshold", () => {
    const f = vaultFiring(g, notes, T, 2);
    expect(f.seeds).toBe(1); // the machine run does not seed
    const byPath = new Map(f.notes.map((n) => [n.path, n]));
    expect(byPath.get("10-Sessions/2026-11-10-brain.md")?.hop).toBe(0);
    const neur = byPath.get("30-Knowledge/concepts/neurons.md");
    expect(neur?.hop).toBe(1);
    expect(neur?.via).toBe("10-Sessions/2026-11-10-brain.md");
    expect(byPath.has("30-Knowledge/concepts/hebbian.md")).toBe(false); // two hops away, not dated in window
  });

  it("an old note does not seed; a wider window lets it", () => {
    expect(vaultFiring(g, notes, T, 2).notes.some((n) => n.path.endsWith("hebbian.md"))).toBe(false);
    expect(vaultFiring(g, notes, T, 31).notes.find((n) => n.path.endsWith("hebbian.md"))?.hop).toBe(0);
  });
});

describe("SynapseReader", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null without a cache and re-reads when the mtime moves", async () => {
    const file = join(dir, ".synapses.tsv");
    const r = new SynapseReader(file);
    expect(await r.read()).toBeNull();
    writeFileSync(file, "a\tx.md\tb:0.5\n");
    expect((await r.read())?.byId.size).toBe(1);
    writeFileSync(file, "a\tx.md\tb:0.5\nb\ty.md\ta:0.5\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await r.read())?.byId.size).toBe(2);
  });
});
