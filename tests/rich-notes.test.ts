import { describe, expect, it } from "vitest";
import { quillToMarkdown } from "../packages/trip-normaliser/src/index.js";
import { notesPreview, parseInlines, parseRichNotes } from "../apps/web/src/lib/rich-notes.js";

/** Suzuka Circuit notes, verbatim from the Wanderlog export. */
const suzuka = {
  "ops": [
    {
      "insert": "Qualifying starts at 9AM, try to be in by 8:50 AM\n\nSchedule:\n"
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "08:50 – 09:20:"
    },
    {
      "insert": " "
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "Qualifying (Round 12)"
    },
    {
      "insert": " – "
    },
    {
      "attributes": {
        "italic": true
      },
      "insert": "Don't miss this!"
    },
    {
      "attributes": {
        "list": "bullet"
      },
      "insert": "\n"
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "10:15 – 11:00:"
    },
    {
      "insert": " Pit Walk (requires Paddock/Pit Walk pass)"
    },
    {
      "attributes": {
        "list": "bullet"
      },
      "insert": "\n"
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "14:30:"
    },
    {
      "insert": " "
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "Round 12 Race Start"
    },
    {
      "insert": " (Season Finale)"
    },
    {
      "attributes": {
        "list": "bullet"
      },
      "insert": "\n"
    },
    {
      "insert": "\nTicket Options\n"
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "Advance Admission (2-Day)"
    },
    {
      "insert": ": ¥4,400 | Basic entry to the circuit (General Admission areas). No reserved seat."
    },
    {
      "attributes": {
        "list": "bullet"
      },
      "insert": "\n"
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "V1 / V2 Reserved Seat"
    },
    {
      "insert": ": ¥6,500 – ¥7,500 | Includes admission + a reserved seat in the Main Grandstand (lower/upper)."
    },
    {
      "attributes": {
        "list": "bullet"
      },
      "insert": "\n"
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "Q Area / B Area Ticket"
    },
    {
      "insert": ": ¥5,500 | Admission + specific grandstand access at the first corner (B) or Chicane (Q)."
    },
    {
      "attributes": {
        "list": "bullet"
      },
      "insert": "\n"
    },
    {
      "attributes": {
        "bold": true
      },
      "insert": "Paddock Pass"
    },
    {
      "insert": ": ¥16,500 | Includes admission, pit walk, and access to the paddock area (drivers/teams). "
    },
    {
      "insert": "\n",
      "attributes": {
        "list": "bullet"
      }
    },
    {
      "insert": "\n"
    }
  ]
};

const suzukaMarkdown = [
  "Qualifying starts at 9AM, try to be in by 8:50 AM",
  "",
  "Schedule:",
  "",
  "- **08:50 – 09:20:** **Qualifying (Round 12)** – _Don't miss this!_",
  "- **10:15 – 11:00:** Pit Walk (requires Paddock/Pit Walk pass)",
  "- **14:30:** **Round 12 Race Start** (Season Finale)",
  "",
  "Ticket Options",
  "",
  "- **Advance Admission (2-Day)**: ¥4,400 | Basic entry to the circuit (General Admission areas). No reserved seat.",
  "- **V1 / V2 Reserved Seat**: ¥6,500 – ¥7,500 | Includes admission + a reserved seat in the Main Grandstand (lower/upper).",
  "- **Q Area / B Area Ticket**: ¥5,500 | Admission + specific grandstand access at the first corner (B) or Chicane (Q).",
  "- **Paddock Pass**: ¥16,500 | Includes admission, pit walk, and access to the paddock area (drivers/teams).",
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
    expect(schedule?.type === "ul" && schedule.items).toHaveLength(3);
    expect(schedule?.type === "ul" && schedule.items[0]).toEqual([
      { text: "08:50 – 09:20:", bold: true },
      { text: " " },
      { text: "Qualifying (Round 12)", bold: true },
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
    expect(notesPreview(suzukaMarkdown)).toBe("Qualifying starts at 9AM, try to be in by 8:50 AM");
  });
});
