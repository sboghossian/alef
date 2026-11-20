#!/usr/bin/env node
// One-off: copies the hand-written project notes (description, milestones, next steps, start date,
// live URL) out of the old roadmap service's PROJECT_META into data/projects-notes.json, which the
// Projects view reads. READ-ONLY on the roadmap, and it never runs any of its code: server.js is
// text, and the one object literal is read by the small literal-only parser below (objects, arrays,
// strings, plain template strings, numbers, true/false/null, comments). Anything else (a call, a
// variable, `${}`, a spread) stops the export. The output goes to this repo's data/ (git-ignored)
// because the notes hold internal business figures; only a count is printed.
//
//   node scripts/export-roadmap-notes.mjs [path/to/roadmap/server.js] [out.json]

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Parses one JS literal (JSON plus bare/quoted keys, single quotes, plain templates, comments, trailing commas). */
export function parseLiteral(src) {
  let i = 0;
  const fail = (what) => {
    throw new Error(`not a plain literal at offset ${i}: ${what}`);
  };
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("//", i)) {
        const nl = src.indexOf("\n", i);
        i = nl < 0 ? src.length : nl + 1;
      } else if (src.startsWith("/*", i)) {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) fail("unclosed comment");
        i = end + 2;
      } else return;
    }
  };
  const ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" };
  const string = () => {
    const q = src[i++];
    let out = "";
    while (i < src.length && src[i] !== q) {
      if (q === "`" && src.startsWith("${", i)) fail("template substitution");
      if (src[i] === "\\") {
        const c = src[i + 1];
        if (c === "u" || c === "x") {
          const m = c === "u" ? /^u(\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/.exec(src.slice(i + 1)) : /^x([0-9a-fA-F]{2})/.exec(src.slice(i + 1));
          if (!m) fail("bad escape");
          out += String.fromCodePoint(parseInt(m[1].replace(/[{}]/g, ""), 16));
          i += 1 + m[0].length;
          continue;
        }
        out += ESC[c] ?? c;
        i += 2;
        continue;
      }
      if (q !== "`" && src[i] === "\n") fail("newline in string");
      out += src[i++];
    }
    if (src[i] !== q) fail("unclosed string");
    i++;
    return out;
  };
  const value = () => {
    skip();
    const c = src[i];
    if (c === "{") {
      i++;
      const obj = Object.create(null);
      for (;;) {
        skip();
        if (src[i] === "}") {
          i++;
          return obj;
        }
        let key;
        if (src[i] === '"' || src[i] === "'") key = string();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
          if (!m) fail("key");
          key = m[0];
          i += key.length;
        }
        skip();
        if (src[i++] !== ":") fail("expected ':'");
        obj[key] = value();
        skip();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        skip();
        if (src[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        skip();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") fail("expected ',' or ']'");
      }
    }
    if (c === '"' || c === "'" || c === "`") return string();
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$])/.exec(src.slice(i));
    if (!m) fail("unsupported token");
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
  };
  const v = value();
  skip();
  if (i !== src.length) fail("trailing text");
  return v;
}

/** The PROJECT_META object literal of the roadmap's server.js, as data. */
export function projectMetaOf(code) {
  const head = "const PROJECT_META = ";
  const start = code.indexOf(head + "{");
  const end = code.indexOf("\n};\n", start);
  if (start < 0 || end < 0) throw new Error("PROJECT_META not found");
  return parseLiteral(code.slice(start + head.length, end + 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = resolve(process.argv[2] ?? join(homedir(), "Documents/Code/roadmap/server.js"));
  const out = resolve(process.argv[3] ?? join(repo, "data", "projects-notes.json"));
  const meta = projectMetaOf(readFileSync(src, "utf8"));
  const notes = {};
  for (const [name, m] of Object.entries(meta)) {
    notes[name] = { desc: m.desc ?? null, longDesc: m.longDesc ?? null, milestones: m.milestones ?? [], nextSteps: m.nextSteps ?? [], started: m.started ?? null, url: m.url ?? null };
  }
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes, null, 1));
  renameSync(tmp, out);
  console.log(`wrote ${Object.keys(notes).length} project notes`);
}
