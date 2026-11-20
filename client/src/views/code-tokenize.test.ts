import { describe, expect, it } from "vitest";
import { extOf, langFromPath, lineHtml, tokenize } from "./code-tokenize";

const kinds = (line: { k: string; v: string }[] | undefined): string[] => (line ?? []).filter((t) => t.v.trim()).map((t) => `${t.k}:${t.v.trim()}`);

describe("tokenize", () => {
  it("picks a language from the path", () => {
    expect(langFromPath("src/a.tsx")).toBe("ts");
    expect(langFromPath("README.md")).toBe("md");
    expect(langFromPath("x/Makefile")).toBe("sh");
    expect(langFromPath("data.bin")).toBe("text");
    expect(extOf("a/b.test.TS")).toBe("ts");
    expect(extOf(".gitignore")).toBe("");
  });

  it("round-trips every line exactly", () => {
    const src = 'const a = "x"; // hi\n/* multi\nline */ fn(1_000)\n`tpl\nstill`\n';
    const lines = tokenize(src, "ts");
    expect(lines.map((l) => l.map((t) => t.v).join("")).join("\n")).toBe(src);
  });

  it("colours ts keywords, strings, comments, numbers, calls and types", () => {
    const [l] = tokenize('export const x: Foo = bar(42, "s"); // note', "ts");
    expect(kinds(l)).toEqual(expect.arrayContaining(["kw:export", "kw:const", "type:Foo", "fn:bar", "num:42", 'str:"s"', "com:// note"]));
  });

  it("carries block comments and template strings across lines", () => {
    const lines = tokenize("/* a\nb */ let y\nconst t = `one\ntwo`", "ts");
    expect(lines[1]?.[0]).toEqual({ k: "com", v: "b */" });
    expect(kinds(lines[1])).toContain("kw:let");
    expect(lines[3]?.[0]).toEqual({ k: "str", v: "two`" });
  });

  it("json keys vs values", () => {
    const [l] = tokenize('{"name": "x", "n": 3, "ok": true}', "json");
    expect(kinds(l)).toEqual(expect.arrayContaining(['key:"name"', 'str:"x"', "num:3", "kw:true"]));
  });

  it("python comments, triple quotes, decorators", () => {
    const lines = tokenize('@app.get\ndef f():\n    """doc\n    more"""\n    return None # c', "py");
    expect(kinds(lines[0])).toEqual(["attr:@app.get"]);
    expect(kinds(lines[1])).toEqual(expect.arrayContaining(["kw:def", "fn:f"]));
    expect(lines[3]?.[0]?.k).toBe("str");
    expect(kinds(lines[4])).toEqual(expect.arrayContaining(["kw:return", "kw:None", "com:# c"]));
  });

  it("shell vars, flags, comments", () => {
    const [l] = tokenize('echo "$HOME" --force ${X} # done', "sh");
    expect(kinds(l)).toEqual(expect.arrayContaining(["kw:echo", "type:--force", "var:${X}", "com:# done"]));
  });

  it("css and html", () => {
    const [c] = tokenize(".a { color: #fff; --x: 3px }", "css");
    expect(kinds(c)).toEqual(expect.arrayContaining(["type:.a", "attr:color", "num:#fff", "var:--x", "num:3px"]));
    const [h] = tokenize('<a href="x">hi</a>', "html");
    expect(kinds(h)).toEqual(expect.arrayContaining(["tag:<a", "attr:href", 'str:"x"', "tag:</a>"]));
  });

  it("markdown headings, fences, wikilinks", () => {
    const lines = tokenize("# Title\n```ts\nconst x\n```\nsee [[Note]] #tag", "md");
    expect(lines[0]?.[0]?.k).toBe("head");
    expect(lines[2]?.[0]?.k).toBe("str");
    expect(kinds(lines[4])).toEqual(expect.arrayContaining(["fn:[[Note]]", "type:#tag"]));
  });

  it("escapes everything in the html it produces", () => {
    const [l] = tokenize('<img src=x onerror="alert(1)">', "text");
    const html = lineHtml(l ?? []);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    const [t] = tokenize('const s = "<script>"', "ts");
    expect(lineHtml(t ?? [])).not.toContain("<script>");
  });
});
