import { describe, expect, it } from "vitest";
import type { VaultNote } from "../../shared/features/vault.js";
import { inboundCounts } from "../features/vault-lib.js";
import { buildVaultSearchIndex, vaultSearch } from "../features/vault-search.js";

let seq = 0;
function note(p: Partial<VaultNote> = {}): VaultNote {
  seq++;
  return {
    id: `n${seq}`,
    path: `00-Inbox/n${seq}.md`,
    kind: "n",
    type: "",
    day: null,
    hour: null,
    project: "",
    umbrella: "",
    tags: [],
    links: [],
    ghosts: [],
    minutes: null,
    mentionWeeks: null,
    mentionLast: null,
    up: null,
    upRule: "",
    ...p,
  };
}

function search(notes: VaultNote[], q: string): ReturnType<typeof vaultSearch> {
  return vaultSearch(buildVaultSearchIndex(notes, inboundCounts(notes)), q);
}

describe("vaultSearch", () => {
  const person = note({ path: "40-Resources/People/Acme Advisor.md", mentionWeeks: new Map([[1, 2]]) });
  const company = note({ path: "40-Resources/Companies/Acme Holdings.md", mentionWeeks: new Map([[1, 1]]) });
  const notes = [
    note({ path: "20-Projects/acme/_index.md", project: "acme" }),
    note({ path: "10-Sessions/claude-code/2026-10-01-acme-pitch.md", project: "acme" }),
    note({ path: "10-Sessions/claude-code/2026-10-02-acme-legal.md", project: "acme" }),
    note({ path: "30-Knowledge/unacmey.md" }),
    person,
    company,
    note({ path: "40-Resources/img/acme.png", kind: "a" }),
    note({ path: "00-Inbox/acme-ideas.md", links: [person.id] }),
  ];

  it("puts the project first, then people, then notes; a word start beats a mid-word hit", () => {
    const hits = search(notes, "acme");
    expect(hits[0]).toEqual({ kind: "project", name: "acme", path: "20-Projects/acme/_index.md", meta: "3 notes" });
    expect(hits.slice(1, 3).map((h) => h.kind)).toEqual(["person", "company"]);
    expect(hits.at(-1)?.name).toBe("unacmey");
    // Attachments and the _index note itself are never their own rows.
    expect(hits.some((h) => h.path.endsWith(".png") || h.name === "_index")).toBe(false);
    expect(hits.find((h) => h.name === "Acme Advisor")?.meta).toBe("40-Resources");
  });

  it("is case-insensitive, ignores one-letter queries and caps the list", () => {
    expect(search(notes, "ACME-LEG").map((h) => h.name)).toEqual(["2026-10-02-acme-legal"]);
    expect(search(notes, "h")).toEqual([]);
    const lots = Array.from({ length: 40 }, (_, i) => note({ path: `00-Inbox/alpha ${i}.md` }));
    expect(search(lots, "alpha")).toHaveLength(12);
  });

  it("offers a project with no _index note, with nothing to open", () => {
    const hits = search([note({ project: "loose-end" })], "loose");
    expect(hits).toEqual([{ kind: "project", name: "loose-end", path: "", meta: "1 note" }]);
  });
});
