import { describe, expect, it } from "vitest";
import { helpHtml, LEGEND, SHORTCUTS, TRY_FIRST } from "./help";

describe("help content", () => {
  it("lists every global shortcut main.ts handles", () => {
    const keys = SHORTCUTS.filter((s) => !s.where).flatMap((s) => s.keys);
    for (const k of ["⌘K", "?", "B", "1", "2", "Esc", "H", "F", "Z"]) expect(keys).toContain(k);
  });
  it("legend covers each thing on the planet", () => {
    const names = LEGEND.map((l) => l.name).join(" ");
    for (const n of ["City", "House", "Car", "Plane", "Moon", "Factories", "beam", "ring"]) expect(names).toContain(n);
  });
  it("offers exactly three things to try first", () => {
    expect(TRY_FIRST).toHaveLength(3);
  });
  it("renders the role-legend slot and escapes text", () => {
    const html = helpHtml();
    expect(html).toContain('id="hud-legend"');
    expect(html).toContain('id="help-welcome"');
    expect(html).toContain('id="help-tour"');
    expect(html).not.toMatch(/<script/i);
  });
});
