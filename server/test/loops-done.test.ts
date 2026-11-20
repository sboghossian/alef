// "Mark done" ticks exactly the one open line the scan read as this todo, nothing else in the file.

import { describe, expect, it } from "vitest";
import { tickTodoLine } from "../features/loops-done.js";

describe("tickTodoLine", () => {
  it("ticks the matching open line only, and leaves fences, done and deferred sections alone", () => {
    const text = [
      "# Todo",
      "```",
      "- [ ] Ship the thing",
      "```",
      "## Now",
      "- [ ] Ship the **thing**.",
      "- [ ] Something else",
      "## Someday",
      "- [ ] Ship the thing!",
      "",
    ].join("\n");
    const r = tickTodoLine(text, "Ship the thing");
    expect(r).toEqual({ ok: true, line: 6, text: text.replace("- [ ] Ship the **thing**.", "- [x] Ship the **thing**.") });
  });

  it("keeps CRLF endings and matches whatsup's wording of a merged item by its dedup key", () => {
    const r = tickTodoLine("## Now\r\n- [ ] Align the FAQ with the DPA\r\n", "align the faq with the dpa");
    expect(r).toEqual({ ok: true, line: 2, text: "## Now\r\n- [x] Align the FAQ with the DPA\r\n" });
  });

  it("refuses a todo that is gone or written twice", () => {
    expect(tickTodoLine("- [x] Ship the thing\n", "Ship the thing")).toEqual({ ok: false, error: "that todo is no longer open in its todo.md" });
    const twice = tickTodoLine("- [ ] Ship the thing\n- [ ] Ship the thing\n", "Ship the thing");
    expect(twice.ok).toBe(false);
  });
});
