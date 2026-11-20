// Obsidian-flavoured markdown → HTML for the 🧠 Brain note pane. Safe by construction: every
// piece of source text goes through escapeHtml; the only tags in the output are the ones this
// file writes. Raw HTML in a note is shown as text, never parsed. Link URLs are allow-listed
// (http, https, mailto); anything else becomes plain text.
//
// Supports: YAML frontmatter (tags/aliases pulled out), ATX headings, paragraphs, bullet /
// numbered / task lists (nested by indent), fenced code (highlighted by code-tokenize), block
// quotes and callouts (> [!note] Title, foldable with +/-), tables, rules, and inline code,
// bold, italic, ~~strike~~, ==highlight==, [text](url), ![img](url) (as a link, no remote load),
// <autolinks>, bare URLs, [[wikilinks]] / [[target|alias]] / [[target#heading]], ![[embeds]]
// (as links) and #tags. Pure; tested in brain-md.test.ts.

import { escapeHtml } from "../ui/fuzzy";
import { langFromPath, lineHtml, tokenize } from "./code-tokenize";

export interface RenderedNote {
  html: string;
  tags: string[];
  aliases: string[];
  /** Wikilink targets in order of appearance (raw, without alias/heading). */
  links: string[];
  headings: Array<{ level: number; text: string; id: string }>;
}

const esc = escapeHtml;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

export function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  return null;
}

/** Splits "target#heading|alias" into its parts. */
export function parseWikilink(inner: string): { target: string; heading: string | null; alias: string | null } {
  const bar = inner.indexOf("|");
  const main = bar >= 0 ? inner.slice(0, bar) : inner;
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() || null : null;
  const hash = main.indexOf("#");
  const target = (hash >= 0 ? main.slice(0, hash) : main).trim();
  const heading = hash >= 0 ? main.slice(hash + 1).trim() || null : null;
  return { target, heading, alias };
}

// ---------------------------------------------------------------- inline

const INLINE = new RegExp(
  [
    "(`+)([\\s\\S]*?[^`])\\1(?!`)", // 1,2 code
    "(!?)\\[\\[([^\\]\\n]+)\\]\\]", // 3,4 wikilink / embed
    "(!?)\\[([^\\]\\n]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)", // 5,6,7 link / image
    "<(https?://[^>\\s]+)>", // 8 autolink
    "(https?://[^\\s<>()\\]]+[^\\s<>()\\].,;:!?'\"])", // 9 bare url
    "\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*", // 10 bold
    "__(?=\\S)([\\s\\S]*?\\S)__", // 11 bold
    "~~(?=\\S)([\\s\\S]*?\\S)~~", // 12 strike
    "==(?=\\S)([\\s\\S]*?\\S)==", // 13 highlight
    "\\*(?=[^\\s*])([^*]*?[^\\s*])\\*", // 14 italic
    "(?<![\\w])_(?=\\S)([^_]*?\\S)_(?![\\w])", // 15 italic
    "(?<![\\w&/#])#([A-Za-z][\\w/-]*)", // 16 tag
  ].join("|"),
  "g",
);

function inline(text: string, links: string[]): string {
  let out = "";
  let last = 0;
  // matchAll clones the regex, so the recursive calls below cannot disturb this loop.
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== undefined) out += `<code>${esc(m[2])}</code>`;
    else if (m[4] !== undefined) {
      const { target, heading, alias } = parseWikilink(m[4]);
      links.push(target);
      const label = alias ?? (heading ? `${target || "this note"} › ${heading}` : target);
      const embed = m[3] === "!";
      out += `<a href="#" class="md-wikilink${embed ? " md-embed" : ""}" data-target="${esc(target)}"${heading ? ` data-heading="${esc(heading)}"` : ""}>${embed ? "↳ " : ""}${esc(label)}</a>`;
    } else if (m[7] !== undefined) {
      const url = safeUrl(m[7]);
      const label = m[6] ?? "";
      const img = m[5] === "!";
      if (url) out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="md-link${img ? " md-img" : ""}">${img ? "🖼 " : ""}${inline(label || url, links)}</a>`;
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(m[7])) {
        // A relative link: treat it as a note path inside the vault.
        const target = decodeURIComponentSafe(m[7]).replace(/\.md$/i, "");
        links.push(target);
        out += `<a href="#" class="md-wikilink" data-target="${esc(target)}">${inline(label || target, links)}</a>`;
      } else out += esc(label || m[7]);
    } else if (m[8] !== undefined || m[9] !== undefined) {
      const url = safeUrl(m[8] ?? m[9] ?? "");
      out += url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="md-link">${esc(url)}</a>` : esc(m[0]);
    } else if (m[10] !== undefined || m[11] !== undefined) out += `<strong>${inline(m[10] ?? m[11] ?? "", links)}</strong>`;
    else if (m[12] !== undefined) out += `<del>${inline(m[12], links)}</del>`;
    else if (m[13] !== undefined) out += `<mark>${inline(m[13], links)}</mark>`;
    else if (m[14] !== undefined || m[15] !== undefined) out += `<em>${inline(m[14] ?? m[15] ?? "", links)}</em>`;
    else if (m[16] !== undefined) out += `<span class="md-tag">#${esc(m[16])}</span>`;
    else out += esc(m[0]);
  }
  return out + esc(text.slice(last));
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------- frontmatter

function frontmatter(md: string): { body: string; tags: string[]; aliases: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { body: md, tags: [], aliases: [] };
  const yaml = m[1] ?? "";
  const list = (key: string): string[] => {
    const inlineRe = new RegExp(`^${key}:[ \\t]*\\[(.*)\\][ \\t]*$`, "m").exec(yaml);
    if (inlineRe) return (inlineRe[1] ?? "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const scalar = new RegExp(`^${key}:[ \\t]*(\\S.*)$`, "m").exec(yaml);
    if (scalar) return (scalar[1] ?? "").split(/[,\s]+/).map((s) => s.replace(/^["'#]|["']$/g, "")).filter(Boolean);
    const block = new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]*-[ \\t]*.*(?:\\n|$))+)`, "m").exec(yaml);
    if (block) return (block[1] ?? "").split("\n").map((s) => s.replace(/^\s*-\s*/, "").trim().replace(/^["'#]|["']$/g, "")).filter(Boolean);
    return [];
  };
  return { body: md.slice(m[0].length), tags: list("tags"), aliases: list("aliases") };
}

// ---------------------------------------------------------------- blocks

const CALLOUT_ICON: Record<string, string> = {
  note: "📝", info: "ℹ️", tip: "💡", hint: "💡", important: "❗", success: "✅", check: "✅", done: "✅",
  question: "❓", help: "❓", faq: "❓", warning: "⚠️", caution: "⚠️", attention: "⚠️", failure: "❌", fail: "❌",
  missing: "❌", danger: "⛔", error: "⛔", bug: "🐞", example: "🧪", quote: "💬", cite: "💬", abstract: "📋",
  summary: "📋", tldr: "📋", todo: "☑️",
};

interface Ctx {
  links: string[];
  headings: RenderedNote["headings"];
  ids: Map<string, number>;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  // "|" inside [[a|b]] is not a column break.
  const cells: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c === "[" && s[i + 1] === "[") depth++;
    if (c === "]" && s[i + 1] === "]" && depth > 0) depth--;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "|" && depth === 0) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isTableSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("-");
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function renderBlocks(lines: string[], ctx: Ctx): string {
  let out = "";
  let i = 0;
  const para: string[] = [];
  const flushPara = (): void => {
    if (!para.length) return;
    out += `<p>${para.map((l) => inline(l, ctx.links)).join("<br>")}</p>`;
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // fenced code
    const fence = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2] ?? "```";
      const lang = (fence[3] ?? "").toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) body.push(lines[i++] ?? "");
      i++;
      const tl = lang ? langFromPath(`x.${lang === "typescript" ? "ts" : lang === "javascript" ? "js" : lang === "python" ? "py" : lang === "bash" || lang === "shell" ? "sh" : lang}`) : "text";
      const code = tokenize(body.join("\n"), tl).map(lineHtml).join("\n");
      out += `<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${code}</code></pre>`;
      continue;
    }
    // blank
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    // heading
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      const level = (h[1] ?? "#").length;
      const text = h[2] ?? "";
      const base = slugify(text) || "section";
      const n = ctx.ids.get(base) ?? 0;
      ctx.ids.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      ctx.headings.push({ level, text, id });
      out += `<h${level} id="md-${esc(id)}">${inline(text, ctx.links)}</h${level}>`;
      i++;
      continue;
    }
    // rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out += "<hr>";
      i++;
      continue;
    }
    // blockquote / callout
    if (/^\s*>/.test(line)) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) body.push((lines[i++] ?? "").replace(/^\s*>\s?/, ""));
      const co = /^\[!(\w+)\]([+-]?)\s*(.*)$/.exec(body[0] ?? "");
      if (co) {
        const type = (co[1] ?? "note").toLowerCase();
        const fold = co[2] ?? "";
        const title = co[3] || type.charAt(0).toUpperCase() + type.slice(1);
        const inner = renderBlocks(body.slice(1), ctx);
        const icon = CALLOUT_ICON[type] ?? "📝";
        const head = `<span class="md-callout-icon" aria-hidden="true">${icon}</span><span class="md-callout-title">${inline(title, ctx.links)}</span>`;
        if (fold) out += `<details class="md-callout" data-callout="${esc(type)}"${fold === "+" ? " open" : ""}><summary>${head}</summary>${inner}</details>`;
        else out += `<div class="md-callout" data-callout="${esc(type)}"><div class="md-callout-head">${head}</div>${inner}</div>`;
      } else out += `<blockquote>${renderBlocks(body, ctx)}</blockquote>`;
      continue;
    }
    // table
    if (line.includes("|") && isTableSep(lines[i + 1] ?? "")) {
      flushPara();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1] ?? "").map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) rows.push(splitRow(lines[i++] ?? ""));
      const cell = (tag: string, c: string, j: number): string => {
        const a = aligns[j];
        return `<${tag}${a ? ` style="text-align:${a}"` : ""}>${inline(c, ctx.links)}</${tag}>`;
      };
      out += `<div class="md-table-wrap"><table><thead><tr>${head.map((c, j) => cell("th", c, j)).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, j) => cell("td", r[j] ?? "", j)).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
      continue;
    }
    // list
    if (LIST_RE.test(line)) {
      flushPara();
      const items: string[] = [];
      const baseIndent = indentOf(line);
      const baseOrdered = /\d/.test(LIST_RE.exec(line)?.[2] ?? "");
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const lm = LIST_RE.exec(l);
        // A bullet list followed by a numbered one (or back) at the same depth is a new list.
        if (lm && items.length && indentOf(l) <= baseIndent && /\d/.test(lm[2] ?? "") !== baseOrdered) break;
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1] ?? "";
          if (LIST_RE.test(next) || /^\s{2,}\S/.test(next)) {
            i++;
            continue;
          }
          break;
        }
        if (!LIST_RE.test(l) && !/^\s{2,}\S/.test(l)) break;
        items.push(l);
        i++;
      }
      out += renderList(items, ctx);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out;
}

function indentOf(l: string): number {
  const m = /^(\s*)/.exec(l);
  return (m?.[1] ?? "").replace(/\t/g, "    ").length;
}

function renderList(lines: string[], ctx: Ctx): string {
  const first = LIST_RE.exec(lines[0] ?? "");
  if (!first) return "";
  const base = indentOf(lines[0] ?? "");
  const ordered = /\d/.test(first[2] ?? "");
  const startNum = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
  let out = ordered ? `<ol${startNum !== 1 ? ` start="${startNum}"` : ""}>` : "<ul>";
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] ?? "";
    const m = LIST_RE.exec(l);
    if (!m || indentOf(l) > base + 1) {
      i++;
      continue;
    }
    let text = m[3] ?? "";
    i++;
    const child: string[] = [];
    while (i < lines.length && indentOf(lines[i] ?? "") > base + 1) child.push(lines[i++] ?? "");
    const cont = child.filter((c) => !LIST_RE.test(c)).length === child.length && child.length > 0;
    if (cont) {
      text += ` ${child.map((c) => c.trim()).join(" ")}`;
      child.length = 0;
    }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    const body = task
      ? `<span class="md-task${task[1] !== " " ? " md-done" : ""}"><span class="md-box" aria-hidden="true">${task[1] !== " " ? "☑" : "☐"}</span> ${inline(task[2] ?? "", ctx.links)}</span>`
      : inline(text, ctx.links);
    const nested = child.length ? renderList(child, ctx) : "";
    out += `<li${task ? ' class="md-task-item"' : ""}>${body}${nested}</li>`;
  }
  return out + (ordered ? "</ol>" : "</ul>");
}

/** Renders a note. Every character of `md` reaches the output escaped. */
export function renderMarkdown(md: string): RenderedNote {
  // HTML and Obsidian (%% … %%) comments are hidden in Obsidian's reading view; drop them too.
  const fm = frontmatter(md.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").replace(/%%[\s\S]*?%%/g, ""));
  const ctx: Ctx = { links: [], headings: [], ids: new Map() };
  const html = renderBlocks(fm.body.split("\n"), ctx);
  return { html, tags: fm.tags, aliases: fm.aliases, links: ctx.links, headings: ctx.headings };
}
