// Folders macOS privacy controls (TCC) guard. The server must never open anything inside one from a
// background code path: launchd starts it with no Terminal or VS Code above it, so no app vouches
// for node, and open()/opendir()/readFile() of contents there blocks until someone answers a consent
// prompt. Called synchronously on the event loop, that froze the whole server before it listened
// (2026-09-29: canonical-repo.ts listed ~/Desktop for a deleted cwd under it on the director's first
// tick). Consumers: canonical-repo.ts, repo-root.ts, trust.ts.
//
// A CONSERVATIVE SUPERSET, not a model of TCC: TCC gates reading contents (open, opendir, readFile)
// inside these folders, not a stat or realpath of the folder itself, and which of them this node
// binary may read depends on the grants on the Mac. ~/Documents is left out on purpose: the live
// server loads its own node_modules, the dev data dir and the vault from there, so Alef cannot run
// at all without that grant.

import { resolve, sep } from "node:path";

/** Guarded folders directly under $HOME (~/Library covers iCloud Drive and other apps' containers). */
const GUARDED_HOME_DIRS = ["Desktop", "Downloads", "Library", "Movies", "Music", "Pictures"];
/** Removable and network volumes. */
const GUARDED_ROOTS = ["/Volumes"];
/** The writable data volume: /System/Volumes/Data/Users/x is the same folder as /Users/x. */
const DATA_VOLUME = "/System/Volumes/Data";

/** `p` resolved, lower-cased on a case-insensitive filesystem (macOS's default), and with the data
 *  volume's firmlink prefix dropped, so every spelling of one folder compares equal. */
function canonical(p: string, platform: NodeJS.Platform): string {
  const r = resolve(p);
  const folded = platform === "darwin" ? r.toLowerCase() : r;
  const data = platform === "darwin" ? DATA_VOLUME.toLowerCase() : DATA_VOLUME;
  if (folded === data) return sep;
  return folded.startsWith(data + sep) ? folded.slice(data.length) : folded;
}

/** True for `path` inside (or equal to) a guarded folder: ~/Desktop, ~/Downloads, ~/Library,
 *  ~/Movies, ~/Music, ~/Pictures, or /Volumes. On darwin the comparison ignores letter case. */
export function isPrivacyGuarded(path: string, homeDir: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = canonical(path, platform);
  const home = canonical(homeDir, platform);
  const roots = [...GUARDED_HOME_DIRS.map((d) => canonical(resolve(home, d), platform)), ...GUARDED_ROOTS.map((r) => canonical(r, platform))];
  return roots.some((root) => p === root || p.startsWith(root + sep));
}
