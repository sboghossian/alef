// Why an agent's city isn't simply its cwd, from the snapshot alone (for the agent panel):
//   - a catch-all session re-homed by its touched files (server/home-placement.ts)
//   - a session whose cwd is a subfolder or a linked worktree of its city's repo
//     (server/canonical-repo.ts)

import type { Island, WorldAgent } from "../../../shared/types";

export function placementNote(agent: Pick<WorldAgent, "cwd" | "islandId">, islands: Iterable<Island>): string | undefined {
  const all = [...islands];
  const home = all.find((i) => i.path === agent.cwd);
  const current = all.find((i) => i.id === agent.islandId);
  if (home) return home.id !== agent.islandId && current ? `placed by touched files: ${current.name}` : undefined;
  if (!current?.path || agent.cwd === current.path || agent.cwd === "/") return undefined;
  if (agent.cwd.startsWith(`${current.path}/`)) return `in ${agent.cwd.slice(current.path.length + 1)}`;
  if (current.path.startsWith(`${agent.cwd}/`)) return undefined; // a catch-all ancestor (home dir)
  // A linked worktree: name it by what follows the part of the path it shares with the repo,
  // minus the worktrees folder itself (~/.acme-worktrees/tick-1791 → "tick-1791").
  const a = agent.cwd.split("/");
  const b = current.path.split("/");
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  const rest = a.slice(common);
  return `worktree: ${(rest.length > 1 ? rest.slice(1) : rest).join("/")}`;
}
