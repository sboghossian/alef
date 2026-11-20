import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../views/brain-md";
import { safeTags, safeText, sanitizeTree, type SafeNode, type SrcNode } from "./automations-sanitize";

// A tiny test-only HTML → SrcNode parser (the browser uses DOMParser). Handles tags, quoted /
// unquoted / bare attributes, void elements, comments and raw-text elements (script/style).
const decode = (t: string): string =>
  t.replace(/&(lt|gt|quot|#39|amp);/g, (_m, e: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e] ?? "");

function parse(html: string): SrcNode {
  type N = SrcNode & { attrs: Map<string, string>; kids: N[] };
  const mk = (nodeName: string, nodeType: number, text: string | null = null): N => {
    const kids: N[] = [];
    const attrs = new Map<string, string>();
    return { nodeName, nodeType, textContent: text, childNodes: kids, kids, attrs, getAttribute: (n: string) => attrs.get(n.toLowerCase()) ?? null };
  };
  const root = mk("BODY", 1);
  const stack: N[] = [root];
  const voids = new Set(["br", "hr", "img", "meta", "link", "input", "source", "base", "embed"]);
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]!;
    if (m[0].startsWith("<!--")) {
      top.kids.push(mk("#comment", 8, m[0]));
    } else if (m[1]) {
      const name = m[1].toLowerCase();
      const idx = stack.map((n) => n.nodeName.toLowerCase()).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      const el = mk(name.toUpperCase(), 1);
      const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[3] ?? ""))) el.attrs.set(a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
      top.kids.push(el);
      if (name === "script" || name === "style") {
        const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        const body = html.slice(re.lastIndex, end < 0 ? html.length : end);
        el.kids.push(mk("#text", 3, body));
        re.lastIndex = end < 0 ? html.length : end;
      } else if (!voids.has(name) && !m[0].endsWith("/>")) stack.push(el);
    } else if (m[4]) {
      top.kids.push(mk("#text", 3, decode(m[4])));
    }
  }
  return root;
}

const OPTS = { origin: "http://127.0.0.1:5178", imagePrefixes: ["/api/shelf/preview"] };
const run = (html: string): SafeNode[] => sanitizeTree(parse(html), OPTS);
const json = (html: string): string => JSON.stringify(run(html));

describe("sanitizeTree: XSS vectors", () => {
  it("drops <script> and its body", () => {
    const out = run(`<p>hi</p><script>alert(1)</script><p>there</p>`);
    expect(safeTags(out).has("script")).toBe(false);
    expect(safeText(out)).toBe("hithere");
  });

  it("drops scripts hidden in unknown wrappers and upper case", () => {
    const out = run(`<font><SCRIPT>steal()</SCRIPT>ok</font>`);
    expect(safeText(out)).toBe("ok");
  });

  it("strips onerror= / onclick= / every on* handler", () => {
    const s = json(`<img src="/api/shelf/preview?p=a.png" onerror="alert(1)"><a href="https://x.dev" onclick="evil()">x</a><div onmouseover="e()">d</div>`);
    expect(s).not.toMatch(/onerror|onclick|onmouseover|alert|evil/);
    expect(s).toContain("/api/shelf/preview?p=a.png");
  });

  it("removes javascript:, data: and vbscript: hrefs (keeps the text)", () => {
    for (const href of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)"]) {
      const out = run(`<a href="${href.replace(/"/g, "&quot;")}">click</a>`);
      expect(JSON.stringify(out)).not.toMatch(/javascript|data:|vbscript/i);
      expect(safeText(out)).toBe("click");
    }
  });

  it("keeps http(s)/mailto links, resolved absolute", () => {
    const out = run(`<a href="https://example.com/a?b=1" title="t">ok</a><a href="mailto:x@y.z">m</a>`);
    expect(out[0]).toEqual({ tag: "a", attrs: { href: "https://example.com/a?b=1", title: "t" }, children: [{ text: "ok" }] });
    expect(out[1]).toMatchObject({ tag: "a", attrs: { href: "mailto:x@y.z" } });
  });

  it("drops <iframe>, <object>, <embed>, <svg>, <form>, <style> with their content", () => {
    const out = run(`<iframe src="https://evil"><p>in</p></iframe><object data="x">o</object><embed src="x"><svg><script>a()</script><text>s</text></svg><form><input value="v"></form><style>body{background:url(javascript:x)}</style><p>kept</p>`);
    expect([...safeTags(out)]).toEqual(["p"]);
    expect(safeText(out)).toBe("kept");
  });

  it("strips style= (url() and expression()), id, srcset, data-*", () => {
    const s = json(`<p style="background:url(javascript:alert(1))" id="i" data-x="1">t</p><div style="width:expression(alert(1))">u</div><img src="/api/shelf/preview?a" srcset="https://evil/x.png 2x">`);
    expect(s).not.toMatch(/style|url\(|expression|"id"|srcset|data-x|evil/);
  });

  it("namespaces class names (src-*) and drops odd tokens", () => {
    expect(run(`<div class="chip warm x&quot;y javascript:a">t</div>`)[0]).toEqual({ tag: "div", attrs: { class: "src-chip src-warm" }, children: [{ text: "t" }] });
  });

  it("drops <nav> (in-page anchors go nowhere once ids are stripped)", () => {
    expect(run(`<nav><a href="#x">Pulse</a></nav><p>a</p>`)).toEqual([{ tag: "p", attrs: {}, children: [{ text: "a" }] }]);
  });

  it("images: only same-origin preview URLs survive", () => {
    expect(run(`<img src="https://evil.example/pixel.gif">`)).toEqual([]);
    expect(run(`<img src="data:image/png;base64,AAAA">`)).toEqual([]);
    expect(run(`<img src="/etc/passwd">`)).toEqual([]);
    expect(run(`<img src="//evil.example/api/shelf/preview?x">`)).toEqual([]);
    expect(run(`<img alt="no src">`)).toEqual([]);
    expect(run(`<img src="/api/shelf/preview?p=chart.png" alt="chart" width="200" height="x">`)).toEqual([
      { tag: "img", attrs: { src: "/api/shelf/preview?p=chart.png", alt: "chart", width: "200" }, children: [] },
    ]);
  });

  it("ignores comments and namespaced tags", () => {
    expect(safeText(run(`<!-- <script>x()</script> -->a<x:foo>b</x:foo>`))).toBe("a");
  });
});

describe("sanitizeTree: keeps semantic content", () => {
  it("headings, paragraphs, lists, tables, details", () => {
    const out = run(`<article><h2>News</h2><p>One <b>two</b> <em>three</em></p><ul><li>a</li><li>b</li></ul><table><thead><tr><th scope="col">k</th></tr></thead><tbody><tr><td colspan="2">v</td></tr></tbody></table><details open><summary>more</summary>x</details></article>`);
    expect([...safeTags(out)].sort()).toEqual(["article", "b", "details", "em", "h2", "li", "p", "summary", "table", "tbody", "td", "th", "thead", "tr", "ul"].sort());
    expect(JSON.stringify(out)).toContain('"colspan":"2"');
    expect(JSON.stringify(out)).toContain('"scope":"col"');
  });

  it("unwraps unknown elements but keeps their text", () => {
    expect(safeText(run(`<center><blink>hello</blink></center>`))).toBe("hello");
  });
});

describe("markdown outputs (W2's Brain renderer → this allowlist)", () => {
  it("raw HTML inside markdown stays text, links stay http(s)", () => {
    const html = renderMarkdown("# Inbox sweep\n\n- **Reply** to <img src=x onerror=alert(1)>\n- [evil](javascript:alert(1)) and [ok](https://x.dev)\n").html;
    const out = run(html);
    const s = JSON.stringify(out);
    expect(safeTags(out).has("img")).toBe(false);
    expect(s).not.toMatch(/"onerror"|javascript:/);
    expect(safeText(out)).toContain("<img src=x onerror=alert(1)>");
    expect(s).toContain("https://x.dev");
  });
});
