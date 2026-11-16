import { describe, expect, it } from "vitest";
import { quillToMarkdown } from "../packages/trip-normaliser/src/index.js";
import { notesPreview, parseInlines, parseRichNotes } from "../apps/web/src/lib/rich-notes.js";

const bullet = { insert: "\n", attributes: { list: "bullet" } };
/** Shaped like the Suzuka Circuit notes in the Wanderlog export. */
const suzuka = {
  ops: [
    { insert: "Qualifying starts at 9AM\n\nSchedule:\n" },
    { insert: "08:50 – 09:20:", attributes: { bold: true } },
    { insert: " " },
    { insert: "Qualifying", attributes: { bold: true } },
    { insert: " – " },
    { insert: "Don't miss this!", attributes: { italic: true } },
    bullet,
    { insert: "14:30:", attributes: { bold: true } },
    { insert: " Race start" },
    bullet,
    { insert: "Tickets\n" },
    { insert: "Paddock Pass", attributes: { bold: true } },
    { insert: ": ¥16,500" },
    bullet,
  ],
};

const suzukaMarkdown = [
  "Qualifying starts at 9AM",
  "",
  "Schedule:",
  "",
  "- **08:50 – 09:20:** **Qualifying** – _Don't miss this!_",
  "- **14:30:** Race start",
  "",
  "Tickets",
  "",
  "- **Paddock Pass**: ¥16,500",
].join("\n");

describe("quillToMarkdown", () => {
  it("converts the Suzuka notes", () => {
    expect(quillToMarkdown(suzuka)).toBe(suzukaMarkdown);
  });

  it("handles links, ordered lists and empty deltas", () => {
    const md = quillToMarkdown({
      ops: [
        { insert: "See " },
        { insert: "site", attributes: { link: "https://example.com" } },
        { insert: "\nOne" },
        { insert: "\n", attributes: { list: "ordered" } },
        { insert: "Two" },
        { insert: "\n", attributes: { list: "ordered" } },
      ],
    });
    expect(md).toBe("See [site](https://example.com)\n\n1. One\n2. Two");
    expect(quillToMarkdown({ ops: [{ insert: "\n" }] })).toBeUndefined();
    expect(quillToMarkdown(undefined)).toBeUndefined();
  });
});

describe("parseRichNotes", () => {
  it("parses the Suzuka Markdown into paragraphs and lists", () => {
    const blocks = parseRichNotes(suzukaMarkdown);
    expect(blocks.map((block) => block.type)).toEqual(["p", "p", "ul", "p", "ul"]);
    const schedule = blocks[2];
    expect(schedule?.type === "ul" && schedule.items).toHaveLength(2);
    expect(schedule?.type === "ul" && schedule.items[0]).toEqual([
      { text: "08:50 – 09:20:", bold: true },
      { text: " " },
      { text: "Qualifying", bold: true },
      { text: " – " },
      { text: "Don't miss this!", italic: true },
    ]);
  });

  it("keeps single newlines in plain text as separate lines", () => {
    expect(parseRichNotes("Line one\nLine two")).toEqual([
      { type: "p", lines: [[{ text: "Line one" }], [{ text: "Line two" }]] },
    ]);
  });

  it("parses links, ignores unsafe hrefs and snake_case", () => {
    expect(parseInlines("[**Go**](https://x.io)")).toEqual([{ text: "Go", bold: true, href: "https://x.io" }]);
    expect(parseInlines("[x](javascript:alert(1))")[0]?.href).toBeUndefined();
    expect(parseInlines("my_file_name")).toEqual([{ text: "my_file_name" }]);
  });
});

describe("self-check edge cases", () => {
  it("skips embeds, balances markers across newlines and bolds headers", () => {
    expect(
      quillToMarkdown({
        ops: [
          { insert: { image: "x.png" } },
          { insert: "a\nb", attributes: { bold: true } },
          { insert: "\nTitle" },
          { insert: "\n", attributes: { header: 2 } },
        ],
      }),
    ).toBe("**a**\n\n**b**\n\n**Title**");
  });

  it("keeps literal markers and parenthesised URLs", () => {
    expect(parseInlines("2 ** 3")).toEqual([{ text: "2 ** 3" }]);
    expect(parseInlines("[Kyoto](https://en.wikipedia.org/wiki/Kyoto_(city))")).toEqual([
      { text: "Kyoto", href: "https://en.wikipedia.org/wiki/Kyoto_(city)" },
    ]);
  });
});

describe("notesPreview", () => {
  it("returns the first non-empty line without markers", () => {
    expect(notesPreview("\n- **08:50:** _Go_ [here](https://x.io)\nmore")).toBe("08:50: Go here");
    expect(notesPreview(suzukaMarkdown)).toBe("Qualifying starts at 9AM");
  });
});
