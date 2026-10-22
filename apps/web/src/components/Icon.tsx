/**
 * Small 16x16 stroke icons in the same hand as the travel-mode glyphs. They
 * replace a word only where the shape is unambiguous next to its value, and
 * the word stays for screen readers.
 */
const ICON_PATHS = {
  pin: "M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8ZM8 8a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 8 8Z",
  clock: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 4.5V8l2.4 1.5",
  route:
    "M4 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4 4.5v1.5a2 2 0 0 0 2 2h4a2 2 0 0 1 2 2v1.5",
  sunset: "M1.5 12h13M4.5 12a3.5 3.5 0 0 1 7 0M8 2.5v3M3.2 5.6l1.3 1.3M12.8 5.6l-1.3 1.3M5.5 14.5h5",
  moon: "M13.5 9.6A5.5 5.5 0 0 1 6.4 2.5a5.5 5.5 0 1 0 7.1 7.1Z",
  map: "M1.5 3.6 5.5 2l5 2 4-1.6v10L10.5 14l-5-2-4 1.6v-10ZM5.5 2v10M10.5 4v10",
  hourglass:
    "M4 1.5h8M4 14.5h8M5 1.5v2.2a3 3 0 0 0 1.2 2.4L8 7.5l1.8-1.4A3 3 0 0 0 11 3.7V1.5M5 14.5v-2.2a3 3 0 0 1 1.2-2.4L8 8.5l1.8 1.4a3 3 0 0 1 1.2 2.4v2.2",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon(props: { name: IconName; class?: string }) {
  return (
    <svg class={`mode-glyph ${props.class ?? ""}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICON_PATHS[props.name]} />
    </svg>
  );
}

/** Keeps a word for screen readers where an icon stands in for it. */
export function Hidden(props: { children: string }) {
  return <span class="visually-hidden">{props.children}</span>;
}
