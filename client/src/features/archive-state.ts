// Archive feature state shared with the Orbit sidebar (views/orbit.ts) and the continent signs
// (features/topics.ts): the latest summary, whether fossils are shown, and the counts they add.
// features/archive.ts owns the data; this module has no THREE and no DOM.

import type { ArchiveSummary } from "../../../shared/features/archive";
import { archivedByGroup, withArchiveRows } from "./archive-lib";
import { autoLotRows, type AutoDistricts } from "./auto-districts-lib";
import type { FilterOption } from "../shell/views";
import { topicsState } from "./topics-state";

let summary: ArchiveSummary | null = null;
/** The AUTO continent's sub-districts: null until the archive list is in (see auto-districts-lib.ts). */
let auto: AutoDistricts | null = null;
let visible = true;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function archiveSummary(): ArchiveSummary | null {
  return summary;
}

export function setArchiveSummary(s: ArchiveSummary | null): void {
  summary = s;
  notify();
}

export function autoDistricts(): AutoDistricts | null {
  return auto;
}

export function setAutoDistricts(a: AutoDistricts | null): void {
  auto = a;
  notify();
}

/** "Show: archived" (default on). */
export function archiveVisible(): boolean {
  return visible;
}

export function setArchiveVisible(on: boolean): void {
  if (visible === on) return;
  visible = on;
  notify();
}

/** Called on a new summary and on every show/hide. Returns an unsubscribe. */
export function onArchiveChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const continentOf = (id: string): string | undefined => topicsState()?.layout.continentOf.get(id);

/** Archived sessions in a topic continent (0 before the archive loads). */
export function archivedInGroup(key: string): number {
  return summary ? (archivedByGroup(summary, continentOf).get(key) ?? 0) : 0;
}

/** Districts rows with archived counts added, plus the archived-only districts. */
export function districtRowsWithArchive(rows: readonly FilterOption[]): FilterOption[] {
  return [...withArchiveRows(rows, summary, continentOf), ...autoLotRows(auto)];
}
