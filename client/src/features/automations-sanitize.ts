// Allowlist sanitizer for automation outputs (yalla-brief HTML, daily-recap…) shown in the
// ⚡ Automations reader. The browser's DOMParser builds an INERT document (scripts never run
// there); `sanitizeTree` then walks it and copies only allowlisted tags + attributes into a
// plain-data tree, and `renderSafe` builds fresh DOM from that tree with createElement /
// textContent only. Raw HTML is never assigned to innerHTML anywhere on this path.
//
// The walker is typed against a tiny structural slice of the DOM (SrcNode), so it is unit-
// tested in node without a DOM library (automations-sanitize.test.ts).

/** The part of a DOM Node the walker reads. A real Element/Text satisfies it. */
export interface SrcNode {
  nodeType: number; // 1 element, 3 text, anything else ignored
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<SrcNode>;
  getAttribute?(name: string): string | null;
}

export type SafeNode = { text: string } | { tag: string; attrs: Record<string, string>; children: SafeNode[] };

export interface SanitizeOptions {
  /** Page origin used to resolve relative URLs (e.g. "http://127.0.0.1:5178"). */
  origin: string;
  /** Same-origin path prefixes an <img src> may point at (the preview endpoint). */
  imagePrefixes: readonly string[];
  /** Base URL of the document, for its relative image/link URLs (default: origin). */
  baseUrl?: string;
}

/** Kept (children sanitized recursively). */
const KEEP = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "ul", "ol", "li", "dl", "dt", "dd",
  "strong", "b", "em", "i", "u", "s", "small", "sup", "sub", "mark", "code", "pre", "kbd", "blockquote", "q", "abbr", "time",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "a", "img", "figure", "figcaption", "span", "div", "section", "article", "header", "footer", "main", "aside",
  "details", "summary",
]);

/** Dropped WITH everything inside them. Anything not in KEEP or DROP is unwrapped (children kept). */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template",
  "svg", "math", "canvas", "audio", "video", "source", "track", "picture",
  "form", "input", "button", "select", "option", "textarea", "label", "fieldset",
  "link", "meta", "base", "head", "title", "portal", "dialog", "nav",
]);

const VOID = new Set(["br", "hr", "img"]);

/** Per-tag attribute allowlist. Everything else (on*, style, id, srcset, data-*) is dropped.
 *  `class` is kept on every allowed tag but re-namespaced ("src-<name>", simple names only) so the
 *  reader can restyle the document's own structure without it ever matching Alef's CSS. */
const ATTRS: Record<string, readonly string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  ol: ["start"],
  time: ["datetime"],
  abbr: ["title"],
  details: ["open"],
};

const MAX_DEPTH = 40;
const MAX_NODES = 20_000;

function safeLink(raw: string, opts: SanitizeOptions): string | null {
  const v = raw.trim();
  if (!v || v.startsWith("#")) return null; // in-page anchors: ids are stripped, so they'd go nowhere
  let url: URL;
  try {
    url = new URL(v, opts.baseUrl ?? opts.origin);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href;
  return null; // javascript:, data:, vbscript:, file:, blob: …
}

function safeImage(raw: string, opts: SanitizeOptions): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), opts.baseUrl ?? opts.origin);
  } catch {
    return null;
  }
  const origin = new URL(opts.origin);
  if (url.origin !== origin.origin) return null;
  if (!opts.imagePrefixes.some((p) => url.pathname.startsWith(p))) return null;
  return url.pathname + url.search;
}

const CLASS_TOKEN = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/;

function sourceClasses(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .split(/\s+/)
    .filter((c) => CLASS_TOKEN.test(c))
    .slice(0, 4)
    .map((c) => `src-${c.toLowerCase()}`)
    .join(" ");
}

function attrsFor(tag: string, node: SrcNode, opts: SanitizeOptions): Record<string, string> | null {
  const out: Record<string, string> = {};
  const cls = sourceClasses(node.getAttribute?.("class"));
  if (cls) out.class = cls;
  for (const name of ATTRS[tag] ?? []) {
    const v = node.getAttribute?.(name);
    if (v === null || v === undefined) continue;
    if (name === "href") {
      const href = safeLink(v, opts);
      if (href) out.href = href;
    } else if (name === "src") {
      const src = safeImage(v, opts);
      if (!src) return null; // an image we may not load is dropped entirely
      out.src = src;
    } else if (name === "width" || name === "height" || name === "colspan" || name === "rowspan" || name === "start") {
      if (/^\d{1,4}$/.test(v.trim())) out[name] = v.trim();
    } else if (name === "scope") {
      if (/^(?:row|col|rowgroup|colgroup)$/.test(v)) out.scope = v;
    } else if (name === "open") {
      out.open = "";
    } else {
      out[name] = v.slice(0, 300);
    }
  }
  if (tag === "img" && !out.src) return null;
  return out;
}

/** Sanitize the children of `root` (a <body> or any element) into a SafeNode list. */
export function sanitizeTree(root: SrcNode, opts: SanitizeOptions): SafeNode[] {
  let budget = MAX_NODES;
  const walk = (node: SrcNode, depth: number): SafeNode[] => {
    const out: SafeNode[] = [];
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (--budget < 0) return out;
      const child = kids[i];
      if (!child) continue;
      if (child.nodeType === 3) {
        const t = child.textContent ?? "";
        if (t) out.push({ text: t });
        continue;
      }
      if (child.nodeType !== 1) continue; // comments, processing instructions, CDATA
      const tag = child.nodeName.toLowerCase();
      if (DROP.has(tag) || tag.includes(":")) continue;
      if (depth >= MAX_DEPTH) continue;
      if (!KEEP.has(tag)) {
        out.push(...walk(child, depth + 1)); // unknown wrapper (font, center, custom-element…): keep its content
        continue;
      }
      const attrs = attrsFor(tag, child, opts);
      if (!attrs) continue;
      out.push({ tag, attrs, children: VOID.has(tag) ? [] : walk(child, depth + 1) });
    }
    return out;
  };
  return collapseWhitespace(walk(root, 0));
}

/** Drops text nodes that are only whitespace between block elements (keeps layout clean). */
function collapseWhitespace(nodes: SafeNode[]): SafeNode[] {
  return nodes
    .filter((n) => !("text" in n) || n.text.trim() !== "" || n.text.length < 3)
    .map((n) => ("text" in n ? n : { ...n, children: collapseWhitespace(n.children) }));
}

/** Plain text of a SafeNode list (search, speech, tests). */
export function safeText(nodes: readonly SafeNode[]): string {
  return nodes.map((n) => ("text" in n ? n.text : safeText(n.children))).join("");
}

/** Every tag used in a SafeNode list (tests / debugging). */
export function safeTags(nodes: readonly SafeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if ("tag" in n) {
      acc.add(n.tag);
      safeTags(n.children, acc);
    }
  }
  return acc;
}

/** Build DOM from a SafeNode list: createElement + setAttribute + text nodes only. */
export function renderSafe(nodes: readonly SafeNode[], doc: Document = document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const build = (n: SafeNode): Node => {
    if ("text" in n) return doc.createTextNode(n.text);
    const el = doc.createElement(n.tag);
    for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, v);
    if (n.tag === "a") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    if (n.tag === "img") {
      el.setAttribute("loading", "lazy");
      el.setAttribute("referrerpolicy", "no-referrer");
    }
    for (const c of n.children) el.appendChild(build(c));
    return el;
  };
  for (const n of nodes) frag.appendChild(build(n));
  return frag;
}

/** Browser entry point: parse (inert) → sanitize. Never executes anything in `html`. */
export function sanitizeHtml(html: string, opts: SanitizeOptions): SafeNode[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return sanitizeTree(doc.body, opts);
}
