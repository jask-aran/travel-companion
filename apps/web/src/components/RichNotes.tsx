import { For, Show, type JSX } from "solid-js";
import { parseRichNotes, type NoteInline } from "../lib/rich-notes";

/** A pasted link labelled with its own URL reads as its site: "reddit.com/r/JapanTravel/…". */
function linkLabel(text: string, href: string | undefined): string {
  if (!href || text !== href) return text;
  try {
    const url = new URL(href);
    const path = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    return `${url.hostname.replace(/^www\./, "")}${path ? `/${path}/…` : ""}`;
  } catch {
    return text;
  }
}

/** One styled run: link, bold and italic wrap each other as needed. */
function NoteRun(props: { inline: NoteInline }): JSX.Element {
  const styled = (): JSX.Element => {
    let node: JSX.Element = linkLabel(props.inline.text, props.inline.href);
    if (props.inline.italic) node = <em>{node}</em>;
    if (props.inline.bold) node = <strong>{node}</strong>;
    return node;
  };
  return (
    <Show when={props.inline.href} fallback={styled()}>
      {(href) => (
        <a href={href()} target="_blank" rel="noopener noreferrer">
          {styled()}
        </a>
      )}
    </Show>
  );
}

/** A line of runs. */
function NoteLine(props: { inlines: NoteInline[] }): JSX.Element {
  return <For each={props.inlines}>{(inline) => <NoteRun inline={inline} />}</For>;
}

/** Notes text (Markdown subset from the importer) as paragraphs, lists, bold, italic and links. */
export function RichNotes(props: { text: string; class?: string }): JSX.Element {
  const blocks = () => parseRichNotes(props.text);
  return (
    <div class={props.class ? `rich-notes ${props.class}` : "rich-notes"}>
      <For each={blocks()}>
        {(block) => {
          if (block.type === "p") {
            return (
              <p>
                <For each={block.lines}>
                  {(line, index) => (
                    <>
                      <Show when={index() > 0}>
                        <br />
                      </Show>
                      <NoteLine inlines={line} />
                    </>
                  )}
                </For>
              </p>
            );
          }
          const items = (
            <For each={block.items}>
              {(item) => (
                <li>
                  <NoteLine inlines={item} />
                </li>
              )}
            </For>
          );
          return block.type === "ul" ? <ul>{items}</ul> : <ol>{items}</ol>;
        }}
      </For>
    </div>
  );
}
