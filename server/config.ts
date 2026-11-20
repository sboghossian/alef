// Where Alex's Obsidian vault lives. One answer for every feature, so Brain, Vault, recall
// and the shelf never read two different vaults: $ALEF_VAULT_DIR when set (a worktree or test
// copy), else ~/Documents/Code/alex_claude.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function vaultRoot(home: string = homedir()): string {
  return process.env.ALEF_VAULT_DIR || join(home, "Documents", "Code", "alex_claude");
}

/** The Claude Code working memory as Claude Code derives it: ~/.claude/projects/<home with / → ->/memory. */
export function derivedMemoryDir(home: string = homedir()): string {
  return join(home, ".claude", "projects", home.replace(/[\\/]/g, "-"), "memory");
}

/** The canonical working memory: the vault copy every Mac symlinks to
 *  (<vault>/60-Meta/claude-config/memory), else the derived ~/.claude path when the vault has none. */
export function memoryDir(home: string = homedir()): string {
  const canonical = join(vaultRoot(home), "60-Meta", "claude-config", "memory");
  return existsSync(canonical) ? canonical : derivedMemoryDir(home);
}
