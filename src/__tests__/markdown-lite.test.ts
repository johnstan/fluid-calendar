import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";

import {
  MarkdownLite,
  checklistProgress,
  parseMarkdownLite,
  toggleChecklistLine,
} from "@/lib/markdown-lite";

const html = (text: string) =>
  renderToStaticMarkup(createElement(MarkdownLite, { text }));

describe("parseMarkdownLite", () => {
  it("recognises checklists, bullets, numbers, headings and nesting", () => {
    const blocks = parseMarkdownLite(
      "# Plan\n- [ ] buy wood\n  - [x] measure\n- note\n1. first\n\nplain"
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "check",
      "check",
      "bullet",
      "ordered",
      "blank",
      "text",
    ]);
    expect(blocks[2]).toMatchObject({
      kind: "check",
      indent: 1,
      checked: true,
    });
  });
});

describe("toggleChecklistLine", () => {
  it("ticks and unticks the given line only", () => {
    const text = "- [ ] a\n- [ ] b";
    const once = toggleChecklistLine(text, 1);
    expect(once).toBe("- [ ] a\n- [x] b");
    expect(toggleChecklistLine(once, 1)).toBe(text);
  });

  it("leaves non-checklist lines alone", () => {
    expect(toggleChecklistLine("- plain [x]", 0)).toBe("- plain [x]");
  });

  it("counts progress", () => {
    expect(checklistProgress("- [x] a\n- [ ] b\n- [X] c")).toEqual({
      done: 2,
      total: 3,
    });
  });
});

describe("MarkdownLite rendering", () => {
  it("renders bold, italic, strikethrough and code", () => {
    const out = html("**bold** *it* ~~gone~~ `x`");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>it</em>");
    expect(out).toContain("<s>gone</s>");
    expect(out).toContain(">x</code>");
  });

  it("does not italicise inside snake_case words or paths", () => {
    const out = html("cd /Users/john/time_registration_tool");
    expect(out).not.toContain("<em>");
    expect(out).toContain("time_registration_tool");
  });

  it("links bare URLs and markdown links, without trailing punctuation", () => {
    const out = html(
      "See https://example.com/a_b. and [docs](https://docs.example.com)"
    );
    expect(out).toContain('href="https://example.com/a_b"');
    expect(out).toContain('href="https://docs.example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("never injects HTML from the description", () => {
    const out = html('<img src=x onerror="alert(1)"> **<b>hi</b>**');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("only allows http(s) links", () => {
    const out = html("[click](javascript:alert(1))");
    expect(out).not.toContain("href=");
  });

  it("renders checked items struck through", () => {
    const out = html("- [x] done");
    expect(out).toContain('checked=""');
    expect(out).toContain("line-through");
  });
});
