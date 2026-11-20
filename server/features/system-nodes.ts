// Turns the settled sources of the "system" feature into the eight planes of the System view.
// Pure: every value shown comes from a source, a failed source makes its nodes "unknown".
// Unit-tested in system-nodes.test.ts (status mapping).

import type { SystemFact, SystemNode, SystemPlane, SystemStatus } from "../../shared/features/system.js";
import type { LaunchdInfo, LaunchdJob, TunnelInfo } from "./system-collectors.js";
import { ageStatus, ageText, loadStatus, makePlane, plural, statusFromRatio, unknownNode, uptimeText, type Settled } from "./system-lib.js";

const DAY = 24 * 3_600_000;

export interface HostInfo { load1: number; cpus: number; uptimeSec: number }
export interface SettingsInfo { model: string | null; effort: string | null; hookCount: number; hookEvents: string[]; hookByEvent: Array<{ event: string; count: number }>; permissionHook: boolean; denyCount: number; allowCount: number }
export interface HarnessInfo { skills: number; agents: number; mcp: number; mcpNames: string[] }
export interface MemoryInfo { files: number; byType: Record<string, number>; indexLines: number | null }
export interface VaultInfo { path: string; notes: number | null; lastCommitMs: number | null; mirrorMs: number | null; ahead: number | null; brainGraphMs: number | null }
export interface MiniInfo { configured: boolean; reachable: boolean | null }
export interface RoutinesInfo { total: number; loaded: number; paused: number; running: number; failed: number; firedToday: number; voiceLoaded: boolean | null }
/** `managed: false` in services.yml = started by hand or an alias of another entry; never counted as an outage. */
export interface ServiceHost { host: string; port: number; managed: boolean; up: boolean; dir: string | null; public: boolean }
export interface PromptsInfo { sessionsToday: number; liveNow: number | null }
export interface OutputsInfo { prsToday: number | null; shippedToday: number | null; artifactsToday: number | null }

export interface SystemSources {
  host: Settled<HostInfo>;
  claudeVersion: Settled<string | null>;
  settings: Settled<SettingsInfo>;
  harness: Settled<HarnessInfo>;
  memory: Settled<MemoryInfo>;
  vault: Settled<VaultInfo>;
  mini: Settled<MiniInfo>;
  routines: Settled<RoutinesInfo>;
  launchd: Settled<LaunchdInfo>;
  tunnel: Settled<TunnelInfo>;
  services: Settled<ServiceHost[]>;
  prompts: Settled<PromptsInfo>;
  outputs: Settled<OutputsInfo>;
}

type Base = Pick<SystemNode, "id" | "plane" | "label" | "source">;
const f = (label: string, value: string, isPrivate = false): SystemFact => (isPrivate ? { label, value, private: true } : { label, value });

/** `src` failed → grey node naming why; else build from its value. */
function from<T>(src: Settled<T>, base: Base, make: (v: T) => Pick<SystemNode, "value" | "status" | "facts">): SystemNode {
  return src.ok ? { ...base, ...make(src.value) } : unknownNode(base, src.error);
}

const jobText = (j: LaunchdJob): string => `${j.schedule} · ${j.loaded === null ? "load unknown" : j.loaded ? (j.running ? "running" : "loaded") : "not loaded"}${j.lastExit !== null && j.lastExit !== 0 ? ` · last exit ${j.lastExit}` : ""}`;

export function buildPlanes(nowMs: number, s: SystemSources): SystemPlane[] {
  const node = <T>(src: Settled<T>, id: string, plane: SystemNode["plane"], label: string, source: string, make: (v: T) => Pick<SystemNode, "value" | "status" | "facts">): SystemNode =>
    from(src, { id: `${plane}.${id}`, plane, label, source }, make);

  const prompts = [
    node(s.prompts, "sessions", "prompts", "Sessions today", "world db (sessions started since local midnight)", (v) => ({
      value: `${v.sessionsToday} started${v.liveNow === null ? "" : ` · ${v.liveNow} live`}`,
      status: "ok",
      facts: [f("Started today", String(v.sessionsToday)), f("Live now", v.liveNow === null ? "not read" : String(v.liveNow))],
    })),
    node(s.routines, "voice", "prompts", "Voice", "launchctl list (a voice or Aleph job)", (v) => ({
      value: v.voiceLoaded === null ? "no voice job found" : v.voiceLoaded ? "job loaded" : "job paused",
      status: v.voiceLoaded === null ? "unknown" : v.voiceLoaded ? "ok" : "warn",
      facts: [f("Voice job", v.voiceLoaded === null ? "none found among the routines" : v.voiceLoaded ? "loaded" : "not loaded")],
    })),
    node(s.routines, "schedule", "prompts", "Routines firing", "automations discovery (launchd logs and outputs)", (v) => ({
      value: `${v.firedToday} fired today`,
      status: v.loaded === 0 ? "warn" : "ok",
      facts: [f("Fired today", String(v.firedToday)), f("Loaded", `${v.loaded} of ${v.total}`)],
    })),
  ];

  const engine = [
    node(s.claudeVersion, "version", "engine", "Claude Code", "claude --version", (v) => ({
      value: v ? `v${v}` : "version unreadable",
      status: v ? "ok" : "unknown",
      facts: [f("Version", v ?? "claude did not answer")],
    })),
    node(s.settings, "model", "engine", "Default model", "~/.claude/settings.json (model, effortLevel)", (v) => ({
      value: v.model ? `${v.model}${v.effort ? ` @ ${v.effort}` : ""}` : "not set",
      status: v.model ? "ok" : "warn",
      facts: [f("Model", v.model ?? "not set"), f("Effort", v.effort ?? "not set")],
    })),
    node(s.settings, "hooks", "engine", "Hooks", "~/.claude/settings.json (hooks)", (v) => ({
      value: plural(v.hookCount, "hook"),
      status: v.hookCount > 0 ? "ok" : "bad",
      facts: [f("Hooks", String(v.hookCount)), f("Events", v.hookEvents.join(", ") || "none")],
    })),
  ];

  const machines = [
    node(s.host, "mac", "machines", "This Mac", "os.loadavg, os.cpus, os.uptime", (v) => ({
      value: `load ${v.load1.toFixed(1)} on ${v.cpus} cores`,
      status: loadStatus(v.load1, v.cpus),
      facts: [f("Load (1 min)", v.load1.toFixed(2)), f("Cores", String(v.cpus)), f("Uptime", uptimeText(v.uptimeSec))],
    })),
    node(s.mini, "mini", "machines", "Mac mini", "~/.ssh/config host + TCP 22 (500 ms)", (v) => ({
      value: !v.configured ? "no mini host known" : v.reachable === null ? "not probed" : v.reachable ? "reachable" : "not answering",
      status: !v.configured || v.reachable === null ? "unknown" : v.reachable ? "ok" : "bad",
      facts: [f("Host in ssh config", v.configured ? "yes" : "no")],
    })),
    node(s.vault, "vault", "machines", "Vault", "git log in the vault repo", (v) => {
      const age = v.lastCommitMs === null ? null : nowMs - v.lastCommitMs;
      return { value: `last commit ${ageText(age)}`, status: ageStatus(age, 2 * DAY, 7 * DAY), facts: [f("Path", v.path, true), f("Last commit", ageText(age))] };
    }),
    node(s.vault, "mirror", "machines", "GitHub mirror", "git log of the vault's upstream branch", (v) => {
      const age = v.mirrorMs === null ? null : nowMs - v.mirrorMs;
      const base = ageStatus(age, 2 * DAY, 7 * DAY);
      return {
        value: v.mirrorMs === null ? "no upstream" : `tip committed ${ageText(age)}`,
        status: v.ahead !== null && v.ahead > 0 && base === "ok" ? "warn" : base,
        facts: [f("Last commit on the mirror", ageText(age)), f("Commits not pushed", v.ahead === null ? "unknown" : String(v.ahead))],
      };
    }),
  ];

  const guardrails = [
    node(s.settings, "hooks", "guardrails", "Hooks by event", "~/.claude/settings.json (hooks)", (v) => ({
      value: `${plural(v.hookCount, "hook")} on ${plural(v.hookEvents.length, "event")}`,
      status: v.hookCount > 0 ? "ok" : "bad",
      facts: v.hookByEvent.map((e) => f(e.event, plural(e.count, "hook"))),
    })),
    node(s.settings, "permission", "guardrails", "Permission hook", "~/.claude/settings.json (hooks.PermissionRequest)", (v) => ({
      value: v.permissionHook ? "installed" : "not installed",
      status: v.permissionHook ? "ok" : "warn",
      facts: [f("PermissionRequest hook", v.permissionHook ? "present" : "absent")],
    })),
    node(s.settings, "deny", "guardrails", "Deny list", "~/.claude/settings.json (permissions.deny)", (v) => ({
      value: `${plural(v.denyCount, "rule")} · ${v.allowCount} allowed`,
      status: v.denyCount > 0 ? "ok" : "warn",
      facts: [f("Deny rules", String(v.denyCount)), f("Allow rules", String(v.allowCount))],
    })),
  ];

  const skills = [
    node(s.harness, "skills", "skills", "Skills", "~/.claude/skills (dirs with a SKILL.md)", (v) => ({ value: `${v.skills} installed`, status: v.skills > 0 ? "ok" : "warn", facts: [f("Installed", String(v.skills))] })),
    node(s.harness, "agents", "skills", "Agents", "~/.claude/agents/*.md", (v) => ({ value: `${v.agents} defined`, status: "ok", facts: [f("Defined", String(v.agents))] })),
    node(s.harness, "mcp", "skills", "MCP servers", "~/.claude.json + settings.json (mcpServers)", (v) => ({
      value: `${v.mcp} configured · not probed`,
      status: "unknown",
      facts: [f("Configured", String(v.mcp)), ...v.mcpNames.map((n) => f("Server", n)), f("Connected or failed", "not known here: Claude Code does not publish it to disk")],
    })),
  ];

  const memory = [
    node(s.memory, "files", "memory", "Memory files", "~/.claude/projects/<home>/memory", (v) => ({
      value: `${v.files} files${v.indexLines === null ? "" : ` · index ${v.indexLines} lines`}`,
      status: v.files > 0 ? "ok" : "warn",
      facts: [f("Memory files", String(v.files)), ...Object.entries(v.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => f(`Type: ${t}`, String(n))), f("MEMORY.md lines", v.indexLines === null ? "unreadable" : String(v.indexLines))],
    })),
    node(s.vault, "brain", "memory", "Brain graph", "60-Meta/brain-graph.json mtime in the vault", (v) => {
      const age = v.brainGraphMs === null ? null : nowMs - v.brainGraphMs;
      return { value: `built ${ageText(age)}`, status: ageStatus(age, 2 * DAY, 7 * DAY), facts: [f("Built", ageText(age))] };
    }),
    node(s.vault, "notes", "memory", "Vault notes", "git ls-files in the vault repo", (v) => ({
      value: v.notes === null ? "not counted" : `${v.notes.toLocaleString("en-US")} notes`,
      status: v.notes === null ? "unknown" : "ok",
      facts: [f("Markdown notes tracked", v.notes === null ? "not counted" : String(v.notes))],
    })),
  ];

  const services: SystemNode[] = [
    node(s.launchd, "scheduled", "services", "Scheduled jobs", "~/Library/LaunchAgents plists (StartInterval, StartCalendarInterval) + launchctl list", (v) => {
      const jobs = v.jobs.filter((j) => j.kind === "scheduled");
      const failed = jobs.filter((j) => j.lastExit !== null && j.lastExit !== 0).length;
      const off = jobs.filter((j) => j.loaded === false).length;
      return {
        value: `${jobs.length} jobs · ${off} off · ${failed} failed`,
        status: !v.launchctlRead ? "unknown" : failed > 0 ? "warn" : jobs.length === 0 ? "unknown" : "ok",
        facts: [...jobs.map((j) => f(j.label, jobText(j))), f("Run at load or on demand", String(v.jobs.filter((j) => j.kind === "other").length))],
      };
    }),
    node(s.launchd, "always", "services", "Always-on jobs", "~/Library/LaunchAgents plists (KeepAlive) + launchctl list", (v) => {
      const jobs = v.jobs.filter((j) => j.kind === "always-on");
      const running = jobs.filter((j) => j.running).length;
      return {
        value: `${running}/${jobs.length} running`,
        status: !v.launchctlRead ? "unknown" : jobs.length === 0 ? "unknown" : statusFromRatio(running, jobs.length),
        facts: jobs.map((j) => f(j.label, jobText(j))),
      };
    }),
    node(s.services, "live", "services", "Always-live", "~/.dashable/services.yml + TCP connect (500 ms)", (v) => {
      const managed = v.filter((h) => h.managed);
      const up = managed.filter((h) => h.up).length;
      const manual = v.length - managed.length;
      return {
        value: `${up}/${managed.length} answering${manual > 0 ? ` · ${manual} manual` : ""}`,
        status: statusFromRatio(up, managed.length),
        facts: v.map((h) => f(h.up ? "Up" : h.managed ? "Down" : "Manual, off", `${h.host} :${h.port} → ${h.dir ?? "no folder"} · ${h.public ? "public" : "local"}`, true)),
      };
    }),
    node(s.services, "down", "services", "Down now", "same TCP check", (v) => {
      const down = v.filter((h) => h.managed && !h.up);
      return { value: down.length === 0 ? "none" : `${down.length} not answering`, status: v.length === 0 ? "unknown" : down.length === 0 ? "ok" : down.length > 2 ? "bad" : "warn", facts: down.map((h) => f("Down", `${h.host} :${h.port}`, true)) };
    }),
  ];

  services.push(
    node(s.tunnel, "public", "services", "Public hosts", "~/.cloudflared/dashable/config.yml (ingress hostnames only)", (v) => {
      const byHost = new Map(s.services.ok ? s.services.value.map((h) => [h.host, h]) : []);
      const down = v.hostnames.filter((h) => {
        const svc = byHost.get(h.split(".")[0] ?? "");
        return svc !== undefined && svc.managed && !svc.up;
      });
      return {
        value: `${v.hostnames.length} public${down.length ? ` · ${down.length} down` : ""}`,
        status: v.hostnames.length === 0 ? "unknown" : down.length > 0 ? "warn" : "ok",
        facts: v.hostnames.map((h) => f(down.includes(h) ? "Down" : "Public", h, true)),
      };
    }),
  );

  const outputs = [
    node(s.outputs, "prs", "outputs", "PRs merged today", "census (gh pr list, merged)", (v) => ({
      value: v.prsToday === null ? "gh not read yet" : `${v.prsToday} merged`,
      status: v.prsToday === null ? "unknown" : "ok",
      facts: [f("Merged today", v.prsToday === null ? "not read yet" : String(v.prsToday))],
    })),
    node(s.outputs, "shipped", "outputs", "Sessions shipped", "outcomes (a session with a merged PR)", (v) => ({
      value: v.shippedToday === null ? "not read yet" : `${v.shippedToday} shipped today`,
      status: v.shippedToday === null ? "unknown" : "ok",
      facts: [f("Shipped today", v.shippedToday === null ? "not read yet" : String(v.shippedToday))],
    })),
    ...(s.outputs.ok && s.outputs.value.artifactsToday !== null
      ? [node(s.outputs, "artifacts", "outputs", "Artifacts published", "outcomes (claude.ai links in today's sessions)", (v) => ({ value: `${v.artifactsToday ?? 0} links today`, status: "ok" as SystemStatus, facts: [f("Links in today's sessions", String(v.artifactsToday ?? 0))] }))]
      : []),
  ];

  return [
    makePlane("prompts", "Prompts", "💬", prompts),
    makePlane("engine", "Engine", "⚙️", engine),
    makePlane("machines", "Machines & sync", "💻", machines),
    makePlane("guardrails", "Guardrails & hooks", "🛡️", guardrails),
    makePlane("skills", "Skills & agents", "✨", skills),
    makePlane("memory", "Memory & vault", "🧠", memory),
    makePlane("services", "Services & routines", "🛰️", services),
    makePlane("outputs", "Outputs", "📦", outputs),
  ];
}
