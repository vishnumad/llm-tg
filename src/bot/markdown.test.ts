import { describe, expect, test } from "bun:test";
import {
  collapseHtml,
  markdownToTelegramHtml,
  splitMarkdown,
} from "./markdown";

describe("markdownToTelegramHtml", () => {
  test.each([
    ["empty input", "", ""],
    [
      "plain punctuation",
      "Hi! (test) #1 costs $10-$20",
      "Hi! (test) #1 costs $10-$20",
    ],
    [
      "brackets and braces",
      "Array[0] = {key: value}",
      "Array[0] = {key: value}",
    ],
    [
      "tildes and backslashes",
      "~/dir and C:\\Users\\Name",
      "~/dir and C:\\Users\\Name",
    ],
    ["a lone asterisk", "2 * 3 = 6", "2 * 3 = 6"],
    [
      "underscores inside words",
      "variable_name and another_one",
      "variable_name and another_one",
    ],
    ["exponents", "2**10 and 3**4", "2**10 and 3**4"],
    ["dunder names", "call __init__ first", "call __init__ first"],
    ["unclosed bold", "**bold", "**bold"],
    ["unclosed italic", "*italic", "*italic"],
    ["CRLF line endings", "one\r\ntwo", "one\ntwo"],
  ])("leaves %s alone", (_, input, expected) => {
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  test.each([
    ["HTML special characters", "Fish & Chips <3", "Fish &amp; Chips &lt;3"],
    ["a mid-line >", "Quote: > text", "Quote: &gt; text"],
    ["double quotes", 'say "hi"', "say &quot;hi&quot;"],
  ])("escapes %s", (_, input, expected) => {
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  test.each([
    ["bold", "This is **bold** text", "This is <b>bold</b> text"],
    ["asterisk italic", "This is *italic* text", "This is <i>italic</i> text"],
    ["underscore italic", "_italic_", "<i>italic</i>"],
    ["strikethrough", "This is ~~old~~ now", "This is <s>old</s> now"],
    [
      "single-character spans",
      "**B**, *i* and ~~s~~",
      "<b>B</b>, <i>i</i> and <s>s</s>",
    ],
    [
      "short bold spans side by side",
      "**a** and **b**",
      "<b>a</b> and <b>b</b>",
    ],
    [
      "italic nested in bold",
      "**This is *nested* text**",
      "<b>This is <i>nested</i> text</b>",
    ],
    [
      "bold and italic closing together",
      "**bold *italic***",
      "<b>bold <i>italic</i></b>",
    ],
    [
      "mixed spans",
      "**Bold** and *italic* with `code`",
      "<b>Bold</b> and <i>italic</i> with <code>code</code>",
    ],
    [
      "headings as bold lines",
      "# Title\n## Subtitle\n#### Details",
      "<b>Title</b>\n<b>Subtitle</b>\n<b>Details</b>",
    ],
    [
      "consecutive quote lines as one blockquote",
      "> first\n> second",
      "<blockquote>first\nsecond</blockquote>",
    ],
    [
      "bullets",
      "Ingredients:\n* blueberries\n- sugar\n+ salt",
      "Ingredients:\n• blueberries\n• sugar\n• salt",
    ],
    ["nested bullets", "- top\n  - nested", "• top\n  ◦ nested"],
    ["numbered lists, unchanged", "1. Install\n2. Run", "1. Install\n2. Run"],
  ])("renders %s", (_, input, expected) => {
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  test.each([
    ["inline code", "Use `code()` now", "Use <code>code()</code> now"],
    [
      "inline code with HTML",
      "Use `a < b && c > d`",
      "Use <code>a &lt; b &amp;&amp; c &gt; d</code>",
    ],
    [
      "inline code with formatting characters",
      "`*not italic*`",
      "<code>*not italic*</code>",
    ],
    [
      "double-backtick code containing a backtick",
      "Use ``code `tick`` here",
      "Use <code>code `tick</code> here",
    ],
    [
      "a code block",
      "Example:\n```\nconst x = 1;\n```",
      "Example:\n<pre><code>const x = 1;\n</code></pre>",
    ],
    [
      "a code block, dropping its language",
      "```c#\nif (x < 10) {}\n```",
      "<pre><code>if (x &lt; 10) {}\n</code></pre>",
    ],
    [
      "a code block, dropping its info string",
      "```ts title=main.ts\nconst n = a[i];\n```",
      "<pre><code>const n = a[i];\n</code></pre>",
    ],
    [
      "a code block without formatting inside",
      "```\n**kwargs and __init__\n```",
      "<pre><code>**kwargs and __init__\n</code></pre>",
    ],
  ])("renders %s", (_, input, expected) => {
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  test.each([
    ["a link", "See [text](url)", 'See <a href="url">text</a>'],
    [
      "a URL with parentheses",
      "See [a+b](https://ex.com/a(b))",
      'See <a href="https://ex.com/a(b)">a+b</a>',
    ],
    [
      "a URL with formatting characters",
      "[docs](https://ex.com/__init__)",
      '<a href="https://ex.com/__init__">docs</a>',
    ],
    [
      "a URL with a double quote",
      '[x](https://ex.com/"q")',
      '<a href="https://ex.com/&quot;q&quot;">x</a>',
    ],
    [
      "formatting in link text",
      "[**bold** link](url)",
      '<a href="url"><b>bold</b> link</a>',
    ],
  ])("renders %s", (_, input, expected) => {
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });
});

describe("collapseHtml", () => {
  test("wraps the HTML in an expandable blockquote, keeping its formatting", () => {
    expect(collapseHtml("<b>Title</b>\n• <code>x</code>")).toBe(
      "<blockquote expandable><b>Title</b>\n• <code>x</code></blockquote>",
    );
  });

  test("marks the lines of a quote inside instead of nesting it", () => {
    expect(
      collapseHtml(markdownToTelegramHtml("Intro\n> first\n> *second*\nEnd")),
    ).toBe(
      "<blockquote expandable>Intro\n▎ first\n▎ <i>second</i>\nEnd</blockquote>",
    );
  });
});

describe("splitMarkdown", () => {
  test("keeps text within the limit in one chunk", () => {
    expect(splitMarkdown("  short  ", 20)).toEqual(["short"]);
  });

  test("prefers the last line end over a later space", () => {
    expect(splitMarkdown("aaaa bbbb\ncccc dddd\neeee ffff gggg", 30)).toEqual([
      "aaaa bbbb\ncccc dddd",
      "eeee ffff gggg",
    ]);
  });

  test("falls back to a space when no line end fits", () => {
    expect(splitMarkdown("aaaa bbbb cccc dddd", 14)).toEqual([
      "aaaa bbbb",
      "cccc dddd",
    ]);
  });

  test("hard-cuts text with no break to use", () => {
    expect(splitMarkdown("a".repeat(25), 14)).toEqual([
      "a".repeat(10),
      "a".repeat(10),
      "a".repeat(5),
    ]);
  });

  test("closes a code block at a cut and reopens it in the next chunk", () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitMarkdown(`Intro\n\`\`\`ts\n${code}\n\`\`\``, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.split("```").length - 1).toBe(2);
    }
  });

  test("never exceeds the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) =>
      i % 7 === 0 ? "```" : `word${i} `.repeat(i % 13),
    ).join("\n");

    for (const chunk of splitMarkdown(text, 256)) {
      expect(chunk.length).toBeLessThanOrEqual(256);
    }
  });
});
