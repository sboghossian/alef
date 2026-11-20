// Builds the layered System map (shared SystemLayers) from the settled sources plus the planes that
// system-nodes.ts already made. Pure: a failed source makes only its own items "unknown".
// Unit-tested in server/test/system-layers.test.ts.

import type { LayerItem, SystemFact, SystemLayers, SystemNode, SystemPlane, SystemPlaneId, SystemStatus } from "../../shared/features/system.js";
import { ageStatus, ageText, plural, unknownNode, type Settled } from "./system-lib.js";
import { categoryCounts, hostedGroup, hostedLabel, jobStatus, pluginLabel } from "./system-layers-lib.js";
import type { ConductInfo, FleetApp, JevInfo, McpMeta, MemoryExtra, RecallInfo, RuntimeInfo, SkillMeta } from "./system-layers-probe.js";
import type { SystemSources } from "./system-nodes.js";

export interface LayerSources {
  conduct: Settled<ConductInfo>;
  runtimes: Settled<RuntimeInfo[]>;
  fleet: Settled<FleetApp[]>;
  jev: Settled<JevInfo>;
  skillMeta: Settled<SkillMeta[]>;
  mcpMeta: Settled<McpMeta>;
  memoryExtra: Settled<MemoryExtra>;
  recall: Settled<RecallInfo>;
}

const DAY = 86_400_000;
const f = (label: string, value: string, isPrivate = false): SystemFact => (isPrivate ? { label, value, private: true } : { label, value });
type Make = Pick<LayerItem, "value" | "status" | "facts"> & Partial<Pick<LayerItem, "sub" | "count" | "private">>;

/** One item from one source; a failed source gives the grey item with the reason. */
function item<T>(src: Settled<T>, id: string, label: string, source: string, make: (v: T) => Make): LayerItem {
  if (!src.ok) {
    const u = unknownNode({ id, plane: "engine", label, source }, src.error);
    return { id, label, value: u.value, status: "unknown", facts: u.facts, source };
  }
  return { id, label, source, ...make(src.value) };
}

const plain = (id: string, label: string, source: string, make: Make): LayerItem => ({ id, label, source, ...make });

/** A node of an existing plane re-labelled as a layer item. */
function fromNode(n: SystemNode | undefined, id: string, label?: string, sub?: string): LayerItem {
  if (!n) return plain(id, label ?? id, "not built", { value: "unknown", status: "unknown", facts: [] });
  return { id, label: label ?? n.label, value: n.value, status: n.status, facts: n.facts, source: n.source, ...(sub ? { sub } : {}) };
}

/** Skill count shown in L3: the SKILL.md folders when known, else the harness's own count; both go in the facts. Pure. */
export function skillCounts(folders: number | null, harness: number | null): Make & { count: number } {
  const n = folders ?? harness;
  const facts = [f("SKILL.md folders", folders === null ? "unknown" : String(folders)), f("Loaded by the harness", harness === null ? "unknown" : String(harness))];
  if (n === null) return { value: "unknown", status: "unknown", count: 0, facts };
  return { value: `${n} skills`, status: n > 0 ? "ok" : "warn", count: n, facts };
}

/** Recall card from the vector store's chunk count and DB mtime. Pure. */
export function recallMake(v: RecallInfo, nowMs: number): Make {
  const age = ageText(nowMs - v.mtimeMs);
  return { value: `${v.chunks.toLocaleString("en-US")} chunks`, status: v.chunks > 0 ? "ok" : "warn", count: v.chunks, sub: `DB updated ${age}`, facts: [f("Chunks", String(v.chunks)), f("DB updated", age), f("Store", "memory-vector skill (sqlite, read-only)")] };
}

export function buildLayers(nowMs: number, s: SystemSources, l: LayerSources, planes: readonly SystemPlane[]): SystemLayers {
  const nodeOf = (plane: SystemPlaneId, name: string): SystemNode | undefined => planes.find((p) => p.id === plane)?.nodes.find((n) => n.id === `${plane}.${name}`);
  const hookCount = (events: string[]): number => (s.settings.ok ? s.settings.value.hookByEvent.filter((e) => events.includes(e.event)).reduce((n, e) => n + e.count, 0) : 0);

  // ---- prompt
  const prompt = [fromNode(nodeOf("prompts", "sessions"), "prompt.sessions", "You", "typed in a session"), fromNode(nodeOf("prompts", "voice"), "prompt.voice", "Voice", "spoken"), fromNode(nodeOf("prompts", "schedule"), "prompt.schedule", "Schedule", "launchd routines")];

  // ---- L1
  const machines = {
    items: [
      fromNode(nodeOf("machines", "mac"), "l1.mac", "This Mac", "primary dev machine"),
      fromNode(nodeOf("machines", "mini"), "l1.mini", "Mac mini", "always-on host"),
      fromNode(nodeOf("machines", "vault"), "l1.vault", "iCloud vault", "where the vault lives"),
      fromNode(nodeOf("machines", "mirror"), "l1.mirror", "GitHub mirror", "off-site backup"),
    ],
    links: ["agent mesh", "vault sync", "off-site backup"],
  };

  // ---- L2
  const guardrails: LayerItem[] = [];
  if (s.settings.ok) {
    for (const e of s.settings.value.hookByEvent) guardrails.push(plain(`l2.hook.${e.event}`, e.event, "~/.claude/settings.json (hooks)", { value: plural(e.count, "hook"), status: "ok", count: e.count, facts: [f("Event", e.event), f("Hooks", String(e.count))] }));
    const v = s.settings.value;
    guardrails.push(
      plain("l2.deny", "Deny rules", "~/.claude/settings.json (permissions)", { value: `${v.denyCount} deny · ${v.allowCount} allow`, status: v.denyCount > 0 ? "ok" : "warn", count: v.denyCount, facts: [f("Deny", String(v.denyCount)), f("Allow", String(v.allowCount))] }),
      plain("l2.permission", "PermissionRequest hook", "~/.claude/settings.json (hooks.PermissionRequest)", { value: v.permissionHook ? "installed" : "not installed", status: v.permissionHook ? "ok" : "warn", facts: [f("Present", v.permissionHook ? "yes" : "no")] }),
    );
  } else guardrails.push(item(s.settings, "l2.hooks", "Hooks", "~/.claude/settings.json", () => ({ value: "", status: "unknown", facts: [] })));
  guardrails.push(
    item(l.conduct, "l2.constitution", "Constitution layers", "~/.claude/CLAUDE.md (# Layer N headings)", (v) => ({ value: v.constitution === null ? "file unreadable" : `${v.constitution} layers`, status: v.constitution === null ? "unknown" : "ok", count: v.constitution ?? 0, facts: [f("Layers", v.constitution === null ? "unreadable" : String(v.constitution))] })),
    item(l.conduct, "l2.conduct", "Conduct eval cases", "~/.claude/evals/agent-conduct/CASES.md (### Case N)", (v) => ({ value: v.cases === null ? "file unreadable" : `${v.cases} cases`, status: v.cases === null ? "unknown" : v.cases > 0 ? "ok" : "warn", count: v.cases ?? 0, facts: [f("Cases", v.cases === null ? "unreadable" : String(v.cases))] })),
    item(l.conduct, "l2.lint", "memory-claim-lint", "~/.claude/hooks/memory-claim-lint.py (presence)", (v) => ({ value: v.claimLint ? "present" : "missing", status: v.claimLint ? "ok" : "warn", facts: [f("Script", v.claimLint ? "present" : "missing")] })),
  );

  // ---- L3
  const model = item(s.settings, "l3.model", "Claude Code", "~/.claude/settings.json (model, effortLevel) + claude --version", (v) => {
    const ctx = v.model && /\[1m\]/i.test(v.model) ? "1M context" : "default context";
    const ver = s.claudeVersion.ok && s.claudeVersion.value ? `v${s.claudeVersion.value}` : "version unread";
    return { value: `${v.model ?? "model not set"}${v.effort ? ` @ ${v.effort}` : ""} · ${ctx}`, status: v.model ? "ok" : "warn", sub: ver, facts: [f("Model", v.model ?? "not set"), f("Effort", v.effort ?? "not set"), f("Context", ctx), f("CLI", ver)] };
  });
  const runtimes = l.runtimes.ok
    ? l.runtimes.value.map((r) => plain(`l3.rt.${r.name}`, r.name, "PATH + /Applications (no process started)", { value: r.present === null ? "n/a" : r.present ? "installed" : "absent", status: r.present === null ? "unknown" : r.present ? "ok" : "warn", facts: [f("Found", r.how)] }))
    : [item(l.runtimes, "l3.rt", "Runtimes", "PATH + /Applications", () => ({ value: "", status: "unknown", facts: [] }))];
  const fleet: LayerItem[] = [plain("l3.fleet.alef", "Alef", "this server", { value: "running (you are looking at it)", status: "ok", facts: [f("Role", "local agent cockpit")] })];
  fleet.push(...(l.fleet.ok
    ? l.fleet.value.filter((a) => !/^(alef|alef-.*)$/i.test(a.name)).map((a) => plain(`l3.fleet.${a.name}`, a.name, "~/Documents/Code folders named like agent apps", { value: `touched ${ageText(a.ageMs)}`, status: ageStatus(a.ageMs, 30 * DAY, 180 * DAY) === "bad" ? "unknown" : "ok", private: false, facts: [f("Folder", `~/Documents/Code/${a.name}`, true), f("Last touched", ageText(a.ageMs))] }))
    : [item(l.fleet, "l3.fleet", "Local agent apps", "~/Documents/Code", () => ({ value: "", status: "unknown", facts: [] }))]));
  const judgment = [
    item(l.jev, "l3.jev.router", "Jev router", "agent-world/hooks/jev-router.mjs (presence)", (v) => ({ value: v.router ? "hook present" : "hook missing", status: v.router ? "ok" : "warn", facts: [f("jev-router.mjs", v.router ? "present" : "missing")] })),
    item(l.jev, "l3.jev.cards", "Route cards today", "~/.claude/logs/route-card.jsonl (lines with today's ts)", (v) => ({ value: v.cardsToday === null ? "log unreadable" : `${v.cardsToday} today`, status: v.cardsToday === null ? "unknown" : "ok", count: v.cardsToday ?? 0, facts: [f("Today", String(v.cardsToday ?? "unreadable")), f("All time", String(v.cardsTotal ?? "unreadable"))] })),
  ];
  const agents = s.harness.ok ? s.harness.value.agents : null;
  const sk = skillCounts(l.skillMeta.ok ? l.skillMeta.value.length : null, s.harness.ok ? s.harness.value.skills : null);
  const chips = [
    item(s.harness, "l3.chip.skills", "Skills", "~/.claude/skills", () => ({ value: sk.value, status: sk.status, count: sk.count, facts: sk.facts })),
    item(s.harness, "l3.chip.agents", "Subagent types", "~/.claude/agents/*.md", (v) => ({ value: `${v.agents} types`, status: "ok", count: v.agents, facts: [f("Defined", String(v.agents))] })),
    item(l.memoryExtra, "l3.chip.workflows", "Workflows", "~/.claude/workflows", (v) => ({ value: v.workflows === null ? "no workflows folder" : `${v.workflows} files`, status: v.workflows === null ? "unknown" : "ok", facts: [f("Files", String(v.workflows ?? "folder absent"))] })),
  ];
  const mcpTotal = l.mcpMeta.ok ? l.mcpMeta.value.hosted.length + l.mcpMeta.value.local.length : null;
  const evHooks = (label: string, events: string[]): Make => ({ value: `${hookCount(events)} hooks`, status: s.settings.ok ? (hookCount(events) > 0 ? "ok" : "warn") : "unknown", facts: [f("Events", events.join(", ")), f("Hooks", s.settings.ok ? String(hookCount(events)) : "unknown")], sub: label });
  const step = (id: string, label: string, source: string, m: Make): LayerItem => plain(`l3.step.${id}`, label, source, m);
  const steps = [
    step("prompt", "Prompt", "world db sessions", { value: nodeOf("prompts", "sessions")?.value ?? "unknown", status: nodeOf("prompts", "sessions")?.status ?? "unknown", sub: "typed, voice or schedule", facts: [f("Sessions", nodeOf("prompts", "sessions")?.value ?? "unknown")] }),
    step("hook", "① Hook", "settings.json hooks", evHooks("intent + recall", ["SessionStart", "UserPromptSubmit"])),
    step("plan", "② Plan / Skill", "~/.claude/skills", { value: sk.value, status: sk.status, sub: "skill auto-matched", facts: sk.facts }),
    step("reason", "③ Reason", "settings.json model", { value: s.settings.ok ? (s.settings.value.model ?? "not set") : "unknown", status: s.settings.ok && s.settings.value.model ? "ok" : "unknown", sub: "the agent loop", facts: [f("Model", s.settings.ok ? (s.settings.value.model ?? "not set") : "unknown")] }),
    step("tools", "④ Tools", "~/.claude.json + connectors", { value: mcpTotal === null ? "unknown" : `${mcpTotal} MCP`, status: mcpTotal === null ? "unknown" : "ok", sub: "code, MCP, shell", facts: [f("MCP servers and connectors", String(mcpTotal ?? "unknown")), f("Live state", "not published to disk")] }),
    step("sub", "⑤ Subagents", "~/.claude/agents", { value: agents === null ? "unknown" : `${agents} types`, status: agents === null ? "unknown" : "ok", sub: "fleet, parallel", facts: [f("Agent types", String(agents ?? "unknown"))] }),
    step("verify", "⑥ Verify", "settings.json hooks + CASES.md", { ...evHooks("checked before done", ["Stop", "PostToolUse"]), count: l.conduct.ok ? (l.conduct.value.cases ?? 0) : 0 }),
    step("persist", "⑦ Persist", "memory folder", { value: s.memory.ok ? `${s.memory.value.files} memories` : "unknown", status: s.memory.ok ? "ok" : "unknown", sub: "memory + vault", facts: [f("Memory files", s.memory.ok ? String(s.memory.value.files) : "unknown")] }),
    step("response", "Response", "outputs", { value: nodeOf("outputs", "shipped")?.value ?? "unknown", status: nodeOf("outputs", "shipped")?.status ?? "unknown", sub: "answer + artifacts", facts: [f("Shipped", nodeOf("outputs", "shipped")?.value ?? "unknown")] }),
  ];

  // ---- L4: memory
  const memory = [
    item(s.memory, "l4.mem.atom", "One fact, one file", "~/.claude/projects/<home>/memory", (v) => ({ value: `${v.files} files`, status: v.files > 0 ? "ok" : "warn", count: v.files, sub: Object.entries(v.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · "), facts: Object.entries(v.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => f(`Type: ${t}`, String(n))) })),
    item(s.memory, "l4.mem.index", "The index", "MEMORY.md line count", (v) => ({ value: v.indexLines === null ? "unreadable" : `${v.indexLines} lines`, status: v.indexLines === null ? "unknown" : "ok", facts: [f("MEMORY.md lines", String(v.indexLines ?? "unreadable"))] })),
    item(l.memoryExtra, "l4.mem.graph", "The graph", "[[wikilinks]] in the memory folder", (v) => ({ value: v.wikilinks === null ? "not counted" : `${v.wikilinks.toLocaleString("en-US")} wikilinks`, status: v.wikilinks === null ? "unknown" : "ok", facts: [f("Wikilinks in memory files", String(v.wikilinks ?? "not counted"))] })),
    item(l.memoryExtra, "l4.mem.past", "What happened", "notes under vault 10-Sessions", (v) => ({ value: v.sessionsIndexed === null ? "not counted" : `${v.sessionsIndexed.toLocaleString("en-US")} sessions`, status: v.sessionsIndexed === null ? "unknown" : "ok", facts: [f("Session notes", String(v.sessionsIndexed ?? "not counted"))] })),
    fromNode(nodeOf("memory", "notes"), "l4.mem.vault", "The vault underneath"),
    item(l.recall, "l4.mem.recall", "Recall", "~/.gstack/memory/vectors.db (read-only chunk count)", (v) => recallMake(v, nowMs)),
    item(l.memoryExtra, "l4.mem.code", "The code graph", "~/.codegraph or vault .codegraph (presence)", (v) => ({ value: v.codegraph ? "index present" : "no index found", status: v.codegraph ? "ok" : "unknown", facts: [f("Index folder", v.codegraph ? "present" : "not found")] })),
  ];

  // ---- L4: skills
  const metas = l.skillMeta.ok ? l.skillMeta.value : [];
  const cats = categoryCounts(metas);
  const skills: SystemLayers["skills"] = {
    total: item(l.skillMeta, "l4.skills.total", "Skills", "~/.claude/skills/*/SKILL.md", (v) => ({ value: `${v.length} installed`, status: v.length > 0 ? "ok" : "warn", count: v.length, facts: [f("Installed", String(v.length)), f("Categorised", "by keywords in name then description")] })),
    categories: cats.map((c) => plain(`l4.skills.cat.${c.name}`, c.name, "keyword categories over SKILL.md name and description", { value: String(c.count), status: "ok", count: c.count, facts: [f("Skills", String(c.count)), f("Of total", `${Math.round((c.count / Math.max(1, metas.length)) * 100)}%`)] })),
    recent: [...metas].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3).map((m) => plain(`l4.skills.recent.${m.name}`, m.name, "SKILL.md mtime", { value: `edited ${ageText(nowMs - m.mtimeMs)}`, status: "ok", facts: [f("Edited", ageText(nowMs - m.mtimeMs)), f("Category", categoryCounts([m])[0]?.name ?? "Other")] })),
  };

  // ---- L4: jobs, live, mcp
  const jobs = s.launchd.ok
    ? s.launchd.value.jobs.filter((j) => j.kind === "scheduled").map((j) => {
        const st = !s.launchd.ok || !s.launchd.value.launchctlRead ? "unknown" : jobStatus(j.loaded, j.lastExit);
        return plain(`l4.job.${j.label}`, j.label.replace(/^(com\.stephane\.|dev\.dashable\.)/, ""), "~/Library/LaunchAgents + launchctl list", { value: j.lastExit === null || j.lastExit === 0 ? (j.loaded === false ? "not loaded" : "ok") : `exit ${j.lastExit}`, status: st, sub: j.schedule, facts: [f("Label", j.label), f("Schedule", j.schedule), f("Loaded", j.loaded === null ? "unknown" : j.loaded ? "yes" : "no"), f("Last exit", j.lastExit === null ? "none yet" : String(j.lastExit))] });
      })
    : [item(s.launchd, "l4.job", "Scheduled jobs", "~/Library/LaunchAgents", () => ({ value: "", status: "unknown", facts: [] }))];
  const live: LayerItem[] = [];
  if (s.services.ok) {
    const hosts = new Set(s.tunnel.ok ? s.tunnel.value.hostnames.map((h) => h.split(".")[0] ?? "") : []);
    for (const h of s.services.value) {
      const st: SystemStatus = h.up ? "ok" : h.managed ? "bad" : "unknown";
      live.push(plain(`l4.live.${live.length}`, h.host, "~/.dashable/services.yml + TCP connect (500 ms)", { value: h.up ? "answering" : h.managed ? "down" : "manual, off", status: st, sub: `:${h.port}${hosts.has(h.host) || h.public ? " · public" : " · local"}`, private: true, facts: [f("Port", String(h.port)), f("Folder", h.dir ?? "none", true), f("Public", hosts.has(h.host) || h.public ? "yes" : "no")] }));
    }
    if (s.tunnel.ok) {
      const known = new Set(s.services.value.map((h) => h.host));
      for (const host of s.tunnel.value.hostnames) if (!known.has(host.split(".")[0] ?? "")) live.push(plain(`l4.live.${live.length}`, host, "~/.cloudflared/dashable/config.yml (hostname only)", { value: "tunnel host, no manifest entry", status: "unknown", sub: "public", private: true, facts: [f("Host", host, true)] }));
    }
  } else live.push(item(s.services, "l4.live", "Always-live fleet", "~/.dashable/services.yml", () => ({ value: "", status: "unknown", facts: [] })));

  const mcp: SystemLayers["mcp"] = [];
  if (l.mcpMeta.ok) {
    const live1 = "listed in ~/.claude.json; whether it is connected is not published to disk";
    const byGroup = new Map<string, LayerItem[]>();
    for (const n of l.mcpMeta.value.hosted) {
      const g = `Hosted · ${hostedGroup(n)}`;
      byGroup.set(g, [...(byGroup.get(g) ?? []), plain(`l4.mcp.hosted.${n}`, hostedLabel(n), "~/.claude.json (claudeAiMcpEverConnected)", { value: "ever connected", status: "unknown", facts: [f("Kind", "claude.ai hosted connector"), f("Live state", live1)] })]);
    }
    for (const [group, items] of byGroup) mcp.push({ group, items });
    mcp.push({ group: "Local servers", items: l.mcpMeta.value.local.map((n) => plain(`l4.mcp.local.${n}`, n, "~/.claude.json (mcpServers keys)", { value: "configured", status: "unknown", facts: [f("Kind", "local MCP server"), f("Live state", live1)] })) });
    mcp.push({ group: "Plugins", items: l.mcpMeta.value.plugins.map((n) => plain(`l4.mcp.plugin.${n}`, pluginLabel(n), "~/.claude/plugins/installed_plugins.json", { value: "installed", status: "ok", facts: [f("Package", n)] })) });
  } else mcp.push({ group: "Connectors", items: [item(l.mcpMeta, "l4.mcp", "MCP connectors", "~/.claude.json", () => ({ value: "", status: "unknown", facts: [] }))] });

  // ---- L5
  const pr = nodeOf("outputs", "prs");
  const outputs = [
    fromNode(nodeOf("prompts", "sessions"), "l5.response", "Response", "sessions started today"),
    fromNode(nodeOf("outputs", "artifacts"), "l5.artifacts", "Artifacts") ,
    plain("l5.deploys", "Deploys", "no deploy log read", { value: "not tracked", status: "unknown", facts: [f("Why", "no local record of deploys this view reads")] }),
    fromNode(pr, "l5.prs", "PRs"),
    item(l.memoryExtra, "l5.memory", "Memory written", "memory folder mtimes (today)", (v) => ({ value: `${v.memoryToday ?? 0} today`, status: v.memoryToday === null ? "unknown" : "ok", count: v.memoryToday ?? 0, facts: [f("Memory files touched today", String(v.memoryToday ?? "unknown"))] })),
    item(l.memoryExtra, "l5.vault", "Vault captured", "00-Inbox mtimes (today)", (v) => ({ value: `${v.inboxToday ?? 0} today`, status: v.inboxToday === null ? "unknown" : "ok", count: v.inboxToday ?? 0, facts: [f("Inbox notes touched today", String(v.inboxToday ?? "unknown"))] })),
  ];
  return { prompt, machines, guardrails, engine: { title: "Claude Code", model, runtimes, fleet, judgment, chips, steps }, memory, skills, jobs, live, mcp, outputs };
}
