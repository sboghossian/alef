#!/usr/bin/env node
// Collects, per live (non-dormant, or already-noted) project, one capped evidence file for the
// "refresh project notes" summarizers: identity, README head, package.json description, recent
// commits, the project's Obsidian folder, matching memory-file descriptions, and the CURRENT
// (possibly stale) note so it can be corrected. Read-only on everything it touches: it only calls
// `git log` (5 s timeout), reads text files, and writes into the output dir. Files named like
// secrets (.env*, *secret*, *token*, *credential*, keychain) are never read, and any line that
// looks like a key or token is dropped. Also writes manifest.json ([[id x20], ...]) and names.json
// ({ id: project name }; the notes file is keyed by name, so merge-project-notes.mjs takes it).
//
//   node scripts/project-notes-evidence.mjs [apiUrl] [outDir]

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const VAULT = join(homedir(), "Documents/Code/alex_claude/20-Projects");
const MEMORY = join(homedir(), ".claude/projects/-Users-alexboghossian/memory");
const FILE_CAP = 12_000;
const BATCH = 20;

const SECRET_NAME = /^\.env|secret|token|credential|keychain/i;
const SECRET_LINE = /sk-[A-Za-z0-9]|ghp_|xox[a-z]-|AKIA[0-9A-Z]|-----BEGIN/;

/** Lines of a text, secret-looking ones dropped, capped to `n` lines. */
export function headLines(text, n) {
  return text
    .split("\n")
    .filter((l) => !SECRET_LINE.test(l))
    .slice(0, n)
    .join("\n")
    .trimEnd();
}

function readText(path, maxBytes = 40_000) {
  try {
    if (SECRET_NAME.test(path.split("/").pop() ?? "")) return null;
    const st = statSync(path);
    if (!st.isFile() || (st.size > 0 && st.blocks === 0)) return null;
    return readFileSync(path, "utf8").slice(0, maxBytes);
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function recentCommits(path) {
  try {
    const { stdout } = await run("git", ["-C", path, "log", "--since=60.days", "--pretty=%ad%x09%s", "--date=short", "-n", "40"], { timeout: 5000, maxBuffer: 1 << 20 });
    return headLines(stdout, 40);
  } catch {
    return "";
  }
}

function readmeHead(path) {
  const name = listDir(path).filter((f) => /^readme/i.test(f)).sort()[0];
  const t = name ? readText(join(path, name)) : null;
  return t ? headLines(t, 60) : "";
}

function pkgDescription(path) {
  const t = readText(join(path, "package.json"), 200_000);
  if (!t) return "";
  try {
    const d = JSON.parse(t).description;
    return typeof d === "string" && !SECRET_LINE.test(d) ? d.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** The vault folder for a project: vaultNote from the API, then id, then name, case-insensitively. */
function vaultSection(p) {
  const dirs = new Map(listDir(VAULT).map((d) => [d.toLowerCase(), d]));
  const key = [p.vaultNote, p.id, p.name].filter((x) => typeof x === "string" && x).map((x) => x.toLowerCase()).find((k) => dirs.has(k));
  if (!key) return { label: null, text: "" };
  const dir = join(VAULT, dirs.get(key));
  const files = listDir(dir).filter((f) => f.endsWith(".md") && !SECRET_NAME.test(f));
  const withTime = files.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  const picks = files.includes("_index.md") ? ["_index.md"] : withTime.slice(0, 2).map((x) => x.f);
  const body = picks.map((f) => `### ${f}\n${headLines(readText(join(dir, f)) ?? "", 40)}`).join("\n\n");
  return { label: `vault 20-Projects/${dirs.get(key)}`, text: `Files: ${files.slice(0, 40).join(", ")}\n\n${body}` };
}

/** Memory files whose name or description line mentions the project id or name. */
function memorySection(p) {
  const needles = [...new Set([p.id, p.name].map((s) => String(s).toLowerCase().replace(/[-\s]+/g, "[-_ ]")))].filter((s) => s.length >= 4);
  if (!needles.length) return [];
  const re = new RegExp(`\\b(${needles.join("|")})\\b`, "i");
  const out = [];
  for (const f of listDir(MEMORY).filter((x) => x.endsWith(".md") && x !== "MEMORY.md" && !SECRET_NAME.test(x)).sort()) {
    const head = readText(join(MEMORY, f), 2000) ?? "";
    const desc = /^description:\s*(.*)$/m.exec(head)?.[1] ?? "";
    if (SECRET_LINE.test(desc)) continue;
    if (re.test(f) || re.test(desc)) out.push(`- ${f}: ${desc.slice(0, 240)}`);
    if (out.length >= 8) break;
  }
  return out;
}

async function evidenceFor(p) {
  const vault = vaultSection(p);
  const mem = memorySection(p);
  const parts = [
    `# Evidence: ${p.name} (id ${p.id})`,
    `## Identity\n- name: ${p.name}\n- path: ${p.path}\n- stage: ${p.stage}\n- category: ${p.category}\n- git remote: ${p.git?.remote ?? "none"}\n- last commit: ${p.git?.lastCommit ?? "none"}\n- commits: ${p.git?.commits ?? "unknown"}`,
    `## README head [label: README]\n${readmeHead(p.path) || "(none)"}`,
    `## package.json description [label: package.json]\n${pkgDescription(p.path) || "(none)"}`,
    `## Recent commits, 60 days (date<TAB>subject) [label: git log]\n${(await recentCommits(p.path)) || "(none)"}`,
    `## Vault project files [label: ${vault.label ?? "none"}]\n${vault.text || "(none)"}`,
    `## Memory files [label: memory <file>]\n${mem.join("\n") || "(none)"}`,
    `## CURRENT note (may be stale: correct it, do not copy figures)\n${p.notes ? JSON.stringify(p.notes, null, 1) : "(none)"}`,
  ];
  return parts.join("\n\n").slice(0, FILE_CAP);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const api = process.argv[2] ?? "http://localhost:5178/api/projects";
  const outDir = process.argv[3] ?? mkdtempSync(join(tmpdir(), "notes-evidence-"));
  const items = (await (await fetch(api)).json()).items;
  const picked = items.filter((p) => p.stage !== "dormant" || p.notes != null);
  mkdirSync(outDir, { recursive: true });
  const ids = [];
  const names = {};
  for (const p of picked) {
    const safe = String(p.id).replace(/[^\w.-]/g, "_");
    writeFileSync(join(outDir, `${safe}.md`), await evidenceFor(p));
    ids.push(p.id);
    names[p.id] = p.name;
  }
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(batches));
  writeFileSync(join(outDir, "names.json"), JSON.stringify(names, null, 1));
  console.log(`evidence: ${ids.length} files, ${batches.length} batches -> ${outDir}`);
}
