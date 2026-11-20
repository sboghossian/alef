// A tiny syntax tokenizer for the read-only Code view (no new deps). Line-based with a carried
// state for multi-line comments / strings, so a file of any size is tokenized in one pass.
// Languages: ts/js (tsx/jsx/mjs/cjs), json, md, py, css, html (+svg/xml/vue), sh. Everything
// else is plain text. Pure: tested in code-tokenize.test.ts.

import { escapeHtml } from "../ui/fuzzy";

export type Lang = "ts" | "json" | "md" | "py" | "css" | "html" | "sh" | "text";
export type TokKind = "plain" | "kw" | "str" | "com" | "num" | "fn" | "type" | "punct" | "tag" | "attr" | "key" | "head" | "var";

export interface Tok {
  k: TokKind;
  v: string;
}

const EXT_LANG: Record<string, Lang> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  json: "json", jsonc: "json", webmanifest: "json",
  md: "md", mdx: "md", markdown: "md",
  py: "py", pyi: "py",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", svg: "html", xml: "html", vue: "html", svelte: "html",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
};

export function langFromPath(path: string): Lang {
  const base = path.split("/").pop() ?? "";
  if (/^(Dockerfile|Makefile)$/.test(base) || /^\.(zshrc|bashrc|profile|bash_profile)$/.test(base)) return "sh";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "text";
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? "text";
}

/** Lower-case extension without the dot ("" when none). */
export function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

interface Rule {
  re: RegExp; // sticky
  k: TokKind;
  /** When the match opens a block that continues on later lines, the text that closes it. */
  open?: string;
  /** Only at the start of the line (after indentation). */
  bol?: boolean;
}

const words = (list: string): RegExp => new RegExp(`\\b(?:${list.trim().split(/\s+/).join("|")})\\b`, "y");

const TS_KW = words(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum
  export extends false finally for from function get if implements import in infer instanceof interface is keyof
  let namespace new null of package private protected public readonly return satisfies set static super switch
  this throw true try type typeof undefined unique var void while with yield`);
const PY_KW = words(`
  and as assert async await break class continue def del elif else except False finally for from global if
  import in is lambda None nonlocal not or pass raise return self True try while with yield print`);
const SH_KW = words(`if then else elif fi for while until do done case esac function in return export local readonly echo exit set unset source`);

const STR_D = /"(?:[^"\\]|\\.)*"?/y;
const STR_S = /'(?:[^'\\]|\\.)*'?/y;
const NUM = /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b/y;
const IDENT = /[A-Za-z_$][\w$]*/y;

const RULES: Record<Exclude<Lang, "text">, Rule[]> = {
  ts: [
    { re: /\/\/.*/y, k: "com" },
    { re: /\/\*/y, k: "com", open: "*/" },
    { re: /`(?:[^`\\]|\\.)*`/y, k: "str" },
    { re: /`/y, k: "str", open: "`" },
    { re: STR_D, k: "str" },
    { re: STR_S, k: "str" },
    { re: NUM, k: "num" },
    { re: TS_KW, k: "kw" },
    { re: /[A-Za-z_$][\w$]*(?=\s*(?:<[^>]*>)?\()/y, k: "fn" },
    { re: /[A-Z][\w$]*/y, k: "type" },
    { re: IDENT, k: "plain" },
    { re: /[{}()[\];,.:?=<>!+\-*/%&|^~@]+/y, k: "punct" },
  ],
  json: [
    { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, k: "key" },
    { re: STR_D, k: "str" },
    { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, k: "num" },
    { re: /\b(?:true|false|null)\b/y, k: "kw" },
    { re: /\/\/.*/y, k: "com" },
    { re: /[{}[\],:]/y, k: "punct" },
  ],
  py: [
    { re: /#.*/y, k: "com" },
    { re: /[rbfuRBFU]{0,2}"""/y, k: "str", open: '"""' },
    { re: /[rbfuRBFU]{0,2}'''/y, k: "str", open: "'''" },
    { re: /[rbfuRBFU]{0,2}"(?:[^"\\]|\\.)*"?/y, k: "str" },
    { re: /[rbfuRBFU]{0,2}'(?:[^'\\]|\\.)*'?/y, k: "str" },
    { re: /@[\w.]+/y, k: "attr" },
    { re: NUM, k: "num" },
    { re: PY_KW, k: "kw" },
    { re: /[A-Za-z_]\w*(?=\s*\()/y, k: "fn" },
    { re: /[A-Z]\w*/y, k: "type" },
    { re: /[A-Za-z_]\w*/y, k: "plain" },
    { re: /[{}()[\];,.:=<>!+\-*/%&|^~]+/y, k: "punct" },
  ],
  sh: [
    { re: /#!.*/y, k: "com", bol: true },
    { re: /(?:^|(?<=\s))#.*/y, k: "com" },
    { re: STR_D, k: "str" },
    { re: STR_S, k: "str" },
    { re: /\$\{[^}]*\}?|\$[\w@#?$!*-]/y, k: "var" },
    { re: SH_KW, k: "kw" },
    { re: /[A-Za-z_][\w-]*(?==)/y, k: "attr" },
    { re: /--?[\w-]+/y, k: "type" },
    { re: NUM, k: "num" },
    { re: /[A-Za-z_][\w.-]*/y, k: "plain" },
    { re: /[|&;<>()[\]{}=]+/y, k: "punct" },
  ],
  css: [
    { re: /\/\*/y, k: "com", open: "*/" },
    { re: STR_D, k: "str" },
    { re: STR_S, k: "str" },
    { re: /@[\w-]+/y, k: "kw" },
    { re: /#[\da-fA-F]{3,8}\b/y, k: "num" },
    { re: /-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr|ch)?/y, k: "num" },
    { re: /--[\w-]+/y, k: "var" },
    { re: /[\w-]+(?=\s*:(?!:))/y, k: "attr" },
    { re: /[\w-]+(?=\()/y, k: "fn" },
    { re: /[.#][\w-]+/y, k: "type" },
    { re: /!important\b/y, k: "kw" },
    { re: /[\w-]+/y, k: "plain" },
    { re: /[{}();:,>+~*=[\]]+/y, k: "punct" },
  ],
  html: [
    { re: /<!--/y, k: "com", open: "-->" },
    { re: /<\/?[\w:-]+/y, k: "tag" },
    { re: /\/?>/y, k: "tag" },
    { re: /[\w:@.-]+(?==)/y, k: "attr" },
    { re: STR_D, k: "str" },
    { re: STR_S, k: "str" },
    { re: /&[#\w]+;/y, k: "num" },
    { re: /[^<&"'=\s]+/y, k: "plain" },
  ],
  md: [
    { re: /#{1,6}\s.*/y, k: "head", bol: true },
    { re: /```.*/y, k: "str", bol: true, open: "```" },
    { re: /(?:[-*+]|\d+\.)\s(?:\[[ xX]\]\s)?/y, k: "punct", bol: true },
    { re: />+/y, k: "com", bol: true },
    { re: /`[^`]*`/y, k: "str" },
    { re: /\[\[[^\]]*\]\]/y, k: "fn" },
    { re: /!?\[[^\]]*\]\([^)]*\)/y, k: "fn" },
    { re: /\*\*[^*]+\*\*|__[^_]+__/y, k: "kw" },
    { re: /(?<![\w&])#[A-Za-z][\w/-]*/y, k: "type" },
    { re: /[^`[*_#!]+/y, k: "plain" },
  ],
};

function push(out: Tok[], k: TokKind, v: string): void {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.k === k) last.v += v;
  else out.push({ k, v });
}

/** Tokenizes `text` into lines of tokens. Joining every token's `v` per line gives back the line exactly. */
export function tokenize(text: string, lang: Lang): Tok[][] {
  const lines = text.split(/\r?\n/);
  if (lang === "text") return lines.map((l) => (l ? [{ k: "plain" as const, v: l }] : []));
  const rules = RULES[lang];
  const out: Tok[][] = [];
  let block: { close: string; k: TokKind } | null = null;
  for (const line of lines) {
    const toks: Tok[] = [];
    let i = 0;
    const firstNonWs = line.search(/\S/);
    while (i < line.length) {
      if (block) {
        // The fence close in md must be a line of its own.
        const at = block.close === "```" ? (line.trimStart().startsWith("```") ? line.length : -1) : line.indexOf(block.close, i);
        if (at < 0) {
          push(toks, block.k, line.slice(i));
          i = line.length;
          break;
        }
        const end = block.close === "```" ? line.length : at + block.close.length;
        push(toks, block.k, line.slice(i, end));
        i = end;
        block = null;
        continue;
      }
      let matched = false;
      for (const r of rules) {
        if (r.bol && i !== Math.max(0, firstNonWs)) continue;
        r.re.lastIndex = i;
        const m = r.re.exec(line);
        if (!m || m[0].length === 0) continue;
        const v = m[0];
        if (r.open) {
          // Did the block close on this same line (after the opener)?
          const rest = line.slice(i + v.length);
          const closeAt = r.open === "```" ? -1 : rest.indexOf(r.open);
          if (closeAt >= 0) {
            push(toks, r.k, v + rest.slice(0, closeAt + r.open.length));
            i += v.length + closeAt + r.open.length;
          } else {
            push(toks, r.k, r.open === "```" ? line.slice(i) : v + rest);
            i = line.length;
            block = { close: r.open, k: r.k };
          }
        } else {
          push(toks, r.k, v);
          i += v.length;
        }
        matched = true;
        break;
      }
      if (!matched) {
        push(toks, "plain", line[i] ?? "");
        i++;
      }
    }
    out.push(toks);
  }
  return out;
}

/** One tokenized line as escaped HTML spans (plain text is escaped too, never raw). */
export function lineHtml(toks: readonly Tok[]): string {
  let s = "";
  for (const t of toks) s += t.k === "plain" ? escapeHtml(t.v) : `<span class="sx-${t.k}">${escapeHtml(t.v)}</span>`;
  return s;
}
