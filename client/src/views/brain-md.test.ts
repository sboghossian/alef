import { describe, expect, it } from "vitest";
import { parseWikilink, renderMarkdown, safeUrl } from "./brain-md";

const html = (md: string): string => renderMarkdown(md).html;

describe("renderMarkdown", () => {
  it("escapes raw HTML everywhere: text, headings, code, links, tables, callouts", () => {
    const evil = '<script>alert(1)</script> <img src=x onerror="alert(2)">';
    const cases = [
      evil,
      `# ${evil}`,
      `- ${evil}`,
      "```html\n" + evil + "\n```",
      `\`${evil}\``,
      `> [!note] ${evil}\n> ${evil}`,
      `| a | b |\n|---|---|\n| ${evil} | x |`,
      `[${evil}](https://x.dev)`,
      `[[${evil}]]`,
      `**${evil}**`,
    ];
    for (const c of cases) {
      const out = html(c);
      expect(out, c).not.toMatch(/<script|<img|onerror="alert/);
      expect(out, c).toContain("&lt;");
    }
  });

  it("refuses javascript: and data: urls", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(" data:text/html,x")).toBeNull();
    const out = html("[click](javascript:alert(1)) ![i](data:image/png;base64,AAA)");
    expect(out).not.toContain("href=\"javascript");
    expect(out).not.toContain("data:image");
    expect(html("[ok](https://a.b/c?d=1&e=2)")).toContain('href="https://a.b/c?d=1&amp;e=2"');
  });

  it("attribute values cannot break out of quotes", () => {
    const out = html('[[x" onmouseover="alert(1)]]');
    expect(out).not.toContain('" onmouseover="');
    expect(out).toContain("&quot;");
  });

  it("wikilinks: target, alias, heading, embed", () => {
    expect(parseWikilink("Note#Part|Shown")).toEqual({ target: "Note", heading: "Part", alias: "Shown" });
    const r = renderMarkdown("See [[20-Projects/agent-world/plan|the plan]] and [[Other#Sec]] and ![[pic.png]]");
    expect(r.links).toEqual(["20-Projects/agent-world/plan", "Other", "pic.png"]);
    expect(r.html).toContain('data-target="20-Projects/agent-world/plan">the plan</a>');
    expect(r.html).toContain('data-heading="Sec"');
    expect(r.html).toContain("md-embed");
  });

  it("relative markdown links become note links", () => {
    const r = renderMarkdown("[x](../50-Wiki/testing.md)");
    expect(r.links).toEqual(["../50-Wiki/testing"]);
  });

  it("frontmatter tags + aliases are pulled out and not rendered", () => {
    const r = renderMarkdown("---\ntags: [ai, growth]\naliases:\n  - Foo\n---\n# Title\nbody #inline-tag");
    expect(r.tags).toEqual(["ai", "growth"]);
    expect(r.aliases).toEqual(["Foo"]);
    expect(r.html).not.toContain("aliases");
    expect(r.html).toContain('<span class="md-tag">#inline-tag</span>');
    expect(r.headings[0]).toMatchObject({ level: 1, text: "Title", id: "title" });
  });

  it("lists nest; tasks render boxes; ordered lists keep their start", () => {
    const out = html("- a\n  - b\n- [x] done\n- [ ] todo\n\n3. three\n4. four");
    expect(out).toMatch(/<ul><li>a<ul><li>b<\/li><\/ul><\/li>/);
    expect(out).toContain("md-done");
    expect(out).toContain('<ol start="3">');
  });

  it("tables, callouts (foldable), code with highlighting, rules, inline styles", () => {
    expect(html("| a | b |\n|:--|--:|\n| 1 | [[x|y]] |")).toMatch(/<table>.*<th>a<\/th>.*text-align:right.*data-target="x">y<\/a>/s);
    expect(html("> [!warning]- Careful\n> body")).toMatch(/<details class="md-callout" data-callout="warning"><summary>.*Careful.*<\/summary><p>body<\/p><\/details>/s);
    expect(html("> plain quote")).toBe("<blockquote><p>plain quote</p></blockquote>");
    expect(html("```ts\nconst x = 1\n```")).toContain('<span class="sx-kw">const</span>');
    expect(html("---")).toBe("<hr>");
    expect(html("**b** *i* ~~s~~ ==h== `c`")).toBe("<p><strong>b</strong> <em>i</em> <del>s</del> <mark>h</mark> <code>c</code></p>");
  });

  it("drops html and obsidian comments like Obsidian's reading view", () => {
    expect(html("a <!-- hidden --> b %%secret%% c")).toBe("<p>a  b  c</p>");
  });

  it("bare urls and autolinks become safe links; empty note is empty", () => {
    expect(html("go https://x.dev/a.")).toContain('<a href="https://x.dev/a"');
    expect(html("")).toBe("");
  });
});
