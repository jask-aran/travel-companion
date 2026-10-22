/** One styled run of note text. */
export interface NoteInline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  href?: string;
}

/** A paragraph or list parsed from the notes Markdown subset. */
export type NoteBlock =
  | { type: "p"; lines: NoteInline[][] }
  | { type: "ul" | "ol"; items: NoteInline[][] };

const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
/** Links, bold and word-bounded italic, in that priority. */
const INLINE = /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*(.+?)\*\*|(?<![\w])_(.+?)_(?![\w])/g;

/** Parses inline markers; nested bold/italic inside links and bold is kept. */
export function parseInlines(text: string, style: Omit<NoteInline, "text"> = {}): NoteInline[] {
  const out: NoteInline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ ...style, text: text.slice(last, index) });
    const [, linkText, href, bold, italic] = match;
    if (linkText !== undefined && href) {
      const safe = /^(https?:|mailto:|tel:)/i.test(href) ? href : undefined;
      out.push(...parseInlines(linkText, safe ? { ...style, href: safe } : style));
    } else if (bold !== undefined) out.push(...parseInlines(bold, { ...style, bold: true }));
    else if (italic !== undefined) out.push(...parseInlines(italic, { ...style, italic: true }));
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) });
  return out;
}

/**
 * Splits notes into paragraphs and lists. Blank lines separate paragraphs;
 * single newlines inside a paragraph stay as separate lines.
 */
export function parseRichNotes(text: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let open: NoteBlock | undefined;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      open = undefined;
      continue;
    }
    const type = BULLET.test(line) ? "ul" : ORDERED.test(line) ? "ol" : "p";
    const content = type === "ul" ? line.replace(BULLET, "") : type === "ol" ? line.replace(ORDERED, "") : line;
    const inlines = parseInlines(content);
    if (open?.type === type) {
      if (open.type === "p") open.lines.push(inlines);
      else open.items.push(inlines);
      continue;
    }
    open = type === "p" ? { type, lines: [inlines] } : { type, items: [inlines] };
    blocks.push(open);
  }
  return blocks;
}

/** The first non-empty line as plain text, with list and inline markers stripped. */
export function notesPreview(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "";
  const content = line.replace(BULLET, "").replace(ORDERED, "").trim();
  return parseInlines(content).map((inline) => inline.text).join("");
}
