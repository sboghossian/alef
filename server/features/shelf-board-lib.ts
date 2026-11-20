// Pure logic of the Shelf view: classify and normalise one URL or local path into an item key, pull
// mentions out of one raw transcript line, fold them into items. Transcript text is untrusted: it is
// matched and parsed, never run. A URL that carries a credential (a sensitive or signed query param,
// a token-looking value, a webhook path) is DROPPED, never redacted and kept.

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { strongerSource, type ShelfItemType, type ShelfSource } from "../../shared/features/shelf-board.js";
import { redactSecrets } from "../heuristics.js";
import { parseLine, type ToolUse } from "../jsonl-events.js";
import { isPrivacyGuarded } from "../privacy-guard.js";
import { isSecretPath } from "./safe-path.js";
import { ARTIFACT_RE, SENSITIVE_QUERY_KEYS, URL_RE } from "./shelf-lib.js";

export interface Classified {
  type: ShelfItemType;
  key: string;
  url: string;
  title: string;
  kind: string;
}

const TRACKING_KEYS = /^(utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|yclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|mkt_tok|ref|ref_src|ref_url|si|trk|trkCampaign|spm|src|source)$/i;
const SIGNED_KEYS = /^(x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|googleaccessid|expires|se|sp|sv|sr|st|skoid|hmac|hash|jwt|otp|client_secret|refresh_token|private_token|ticket|state|nonce|code_challenge|code_verifier|oauth_token|oauth_verifier|id_token_hint)$/i;
const TOKEN_IN_PATH = /(?:\b(?:sk|pk|rk|gh[pousr]|xox[abprs])[-_][A-Za-z0-9_-]{16,})|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}|_(?:live|test)_[A-Za-z0-9]{12,}/;
/** Param names that carry a credential whatever their exact spelling (authToken, api-key, sessionid…). */
const SECRET_KEY_PARTS = /token|secret|passw|signature|credential|api[-_]?key|private[-_]?key|access[-_]?key|resourcekey|^session(?:[-_]?id)?$|^sid$/i;
/** Webhook URLs: the URL itself is the credential. Applied to pins and seed rows too. */
const WEBHOOK_URLS = [
  /^hooks\.slack\.com\//, /^(?:discord|discordapp)\.com\/api\/webhooks\//, /^api\.telegram\.org\/bot/, /^outlook\.office\.com\/webhook/,
  /^[^/]*\.webhook\.office\.com\//, /^hooks\.zapier\.com\//, /^maker\.ifttt\.com\//, /^[^/]*\.logic\.azure\.com\//,
];
/** A path naming a hook with a long random-looking segment (a generic webhook secret). */
const isHookPath = (path: string): boolean => /hook/i.test(path) && path.split("/").some((seg) => seg.length >= 16 && /\d/.test(seg) && /[A-Za-z]/.test(seg));
const NOISE_HOSTS = [
  /^(?:localhost|0\.0\.0\.0|\[::1\]|example\.(?:com|org|net))$/,
  /^127\./, /^10\./, /^192\.168\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /\.local$/, /\.internal$/, /\.test$/,
  /^(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdn\.skypack\.dev|cdn\.tailwindcss\.com|code\.jquery\.com|ajax\.googleapis\.com)$/,
  /^fonts\.(?:googleapis|gstatic)\.com$/, /(?:^|\.)cloudfront\.net$/, /(?:^|\.)akamaihd\.net$/, /(?:^|\.)githubusercontent\.com$/,
  /^(?:www\.)?(?:w3\.org|schema\.org|json-schema\.org|googletagmanager\.com|google-analytics\.com)$/, /^registry\.(?:npmjs\.org|yarnpkg\.com)$/,
  /^api\./, /^(?:www\.)?gravatar\.com$/, /^img\.shields\.io$/, /^(?:www\.)?badgen\.net$/,
];
const ASSET_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|avif|bmp|tiff?|css|js|mjs|cjs|map|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|webm|mov|zip|tgz|gz|wasm|json|xml|txt)$/i;
const PLACEHOLDER = /[{}<>[\]*$]|\.\.\.|%7B|%7D|%3C|%3E|%24/i;
const GITHUB_RESERVED = new Set("settings orgs marketplace login logout join features about pricing sponsors topics collections explore notifications new apps search enterprise security site contact trending pulls issues codespaces account customer-stories readme team".split(" "));
const MAX_KEY = 600;

/** A URL as the shelf keeps it, or null: not http(s), carries credentials, or (unless `lenient`) noise.
 *  `lenient` (pins, seed rows): only the credential checks apply. */
export function classifyUrl(raw: string, opts: { lenient?: boolean } = {}): Classified | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/[.,;:!?*_~'"]+$/, ""));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (WEBHOOK_URLS.some((re) => re.test(`${host}${u.pathname}`)) || isHookPath(u.pathname)) return null;
  if (TOKEN_IN_PATH.test(u.pathname)) return null;
  for (const [k, v] of u.searchParams) {
    if (SENSITIVE_QUERY_KEYS.test(k) || SIGNED_KEYS.test(k) || SECRET_KEY_PARTS.test(k)) return null;
    if (redactSecrets(v) !== v) return null;
  }
  if (!opts.lenient) {
    if (!host.includes(".") || NOISE_HOSTS.some((re) => re.test(host))) return null;
    if (ASSET_EXT.test(u.pathname) || PLACEHOLDER.test(u.pathname + u.search)) return null;
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING_KEYS.test(k)) u.searchParams.delete(k);
  u.hash = "";
  u.hostname = host;
  const path = u.pathname.replace(/\/+$/, "");
  const clean = `${u.protocol}//${u.host}${path}${u.search}`;
  if (clean.length > MAX_KEY) return null;
  const seg = path.split("/").filter(Boolean);

  if (host === "claude.ai" && ARTIFACT_RE.test(`https://claude.ai${path}`)) {
    const id = seg[seg.length - 1] ?? "";
    return { type: "artifact", key: `artifact:${id}`, url: `https://claude.ai${path}`, title: "Artifact", kind: "artifact" };
  }
  if (host.endsWith(".dashable.dev")) {
    return { type: "dashable", key: `dashable:${host}`, url: `https://${host}`, title: host, kind: host.split(".")[0] ?? host };
  }
  if (host === "github.com" && seg.length >= 2 && !GITHUB_RESERVED.has((seg[0] ?? "").toLowerCase())) {
    const repo = `${seg[0]}/${(seg[1] ?? "").replace(/\.git$/, "")}`.toLowerCase();
    const n = /^(pull|issues)$/.test(seg[2] ?? "") && /^\d+$/.test(seg[3] ?? "") ? Number(seg[3]) : null;
    if (n !== null) {
      const pr = seg[2] === "pull";
      return { type: "github", key: `github:${repo}#${n}`, url: `https://github.com/${repo}/${pr ? "pull" : "issues"}/${n}`, title: `${repo}#${n}`, kind: pr ? `PR #${n}` : `issue #${n}` };
    }
    return { type: "github", key: `github:${repo}`, url: `https://github.com/${repo}`, title: repo, kind: "repo" };
  }
  if (host === "linear.app" && seg.length >= 3) {
    const [ws, what, ref] = seg as [string, string, string];
    if (what === "issue" && /^[A-Za-z]{1,10}-\d+$/.test(ref)) {
      const k = ref.toUpperCase();
      return { type: "linear", key: `linear:issue:${k}`, url: `https://linear.app/${ws}/issue/${k}`, title: k, kind: "issue" };
    }
    const m = /^(.*?)-?([0-9a-f]{12})$/.exec(ref);
    if ((what === "document" || what === "project") && m) {
      const name = (m[1] ?? "").replace(/-/g, " ").trim() || what;
      return { type: "linear", key: `linear:${what}:${m[2]}`, url: `https://linear.app/${ws}/${what}/${ref}`, title: name, kind: what === "document" ? "doc" : "project" };
    }
  }
  const title = `${host}${path}`.slice(0, 80);
  return { type: "link", key: `link:${clean}`, url: clean, title, kind: host };
}

export const itemIdOf = (key: string): string => createHash("sha1").update(key).digest("hex").slice(0, 16);

const PATH_RE = /(?:^|[\s"'`(=:])((?:~|\/[A-Za-z0-9._-]+)(?:\/[^\s"'`<>()[\]{}|;,*?$\\]+)+)/g;

/** Home-rooted absolute paths named in `text` (`~/…` expanded), minus privacy-guarded folders,
 *  secret files, transcripts, node_modules and .git internals. Not checked on disk here. */
export function pathsIn(text: string, home: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    let p = (m[1] ?? "").replace(/[.:,!]+$/, "").replace(/\/+$/, "");
    if (p.startsWith("~")) p = home + p.slice(1);
    if (!isAbsolute(p) || p.includes("/../") || p.length > 400) continue;
    p = resolve(p);
    if (p === home || !p.startsWith(`${home}/`)) continue;
    if (isPrivacyGuarded(p, home) || isSecretPath(p)) continue;
    if (/\/(?:node_modules|\.git|\.Trash|\.cache)(?:\/|$)/.test(p) || p.startsWith(`${home}/.claude/projects/`)) continue;
    out.add(p);
  }
  return [...out];
}

export interface Mention {
  key: string;
  type: ShelfItemType;
  url: string | null;
  path: string | null;
  title: string;
  kind: string;
  source: ShelfSource;
}

const WRITE_TOOLS = /^(?:Write|Edit|MultiEdit|NotebookEdit|TodoWrite|Artifact|ArtifactData|ArtifactComments)$/;
const FETCH_TOOLS = /fetch|scrape|crawl|browse|navigate|search|extract|webtrips/i;
const FETCH_CMD = /\b(?:curl|wget|http(?:ie)?|\$B\s+(?:goto|newtab|open))\b/;
const INJECTED = /<(system-reminder|local-command-stdout|local-command-stderr|task-notification|bash-stdout|bash-stderr|command-stdout)>[\s\S]*?<\/\1>/g;
const SKIP_TEXT = /^(?:Base directory for this skill|Caveat: |This session is being continued from a previous conversation)/;

function toolSource(use: ToolUse): ShelfSource | null {
  if (WRITE_TOOLS.test(use.name)) return null;
  if (use.name === "Agent" || use.name === "Task" || use.name === "SendMessage") return "assistant";
  if (FETCH_TOOLS.test(use.name)) return "fetch";
  if (use.name === "Bash" && typeof use.input.command === "string" && FETCH_CMD.test(use.input.command)) return "fetch";
  return "tool";
}

function* stringsIn(v: unknown, depth = 0): Generator<string> {
  if (depth > 4) return;
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* stringsIn(x, depth + 1);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) yield* stringsIn(x, depth + 1);
}

export interface LineMentions {
  at: string | null;
  mentions: Mention[];
}

/** Mentions in one raw transcript line. Claude.ai artifact links are left to the artifacts feature;
 *  tool results and meta lines are skipped (they are what tools printed, not what anyone chose). */
export function lineMentions(raw: string, opts: { subagent: boolean; home: string }): LineMentions | null {
  if (raw.includes('"tool_result"') || raw.includes('"isMeta":true')) return null;
  const p = parseLine(raw);
  if (!p) return null;
  const found = new Map<string, Mention>();
  const add = (m: Mention): void => {
    const prev = found.get(m.key);
    if (!prev) found.set(m.key, m);
    else prev.source = strongerSource(prev.source, m.source);
  };
  const fromText = (text: string, source: ShelfSource, withPaths: boolean): void => {
    for (const m of text.matchAll(URL_RE)) {
      const c = classifyUrl(m[0]);
      if (c && c.type !== "artifact") add({ ...c, path: null, source });
    }
    if (withPaths) for (const path of pathsIn(text, opts.home)) add({ key: `path:${path}`, type: "file", url: null, path, title: path.split("/").pop() ?? path, kind: "path", source });
  };
  if (p.userText) {
    const text = p.userText.replace(INJECTED, " ");
    if (!SKIP_TEXT.test(text.trimStart())) fromText(text, opts.subagent ? "assistant" : "user", true);
  }
  if (p.assistantText) fromText(p.assistantText, "assistant", true);
  for (const use of p.toolUses) {
    const source = toolSource(use);
    if (!source) continue;
    for (const s of stringsIn(use.input)) fromText(s, source, false);
  }
  return found.size ? { at: p.timestamp, mentions: [...found.values()] } : null;
}
