import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const publicFonts = resolve(dirname(fileURLToPath(import.meta.url)), "../public/fonts");

/**
 * Fonts that are not in git because they are licensed (scripts/vendor-fonts.ts
 * lists them): Druk Wide Super sets the trip title. A clone without the file
 * would preload and request a font that 404s on every load, so when it is
 * missing its preload link and @font-face rule are dropped and the title falls
 * back to Sora (`--font-display` in styles.css). With the file present nothing
 * changes.
 */
const OPTIONAL_FONTS = [{ file: "druk-wide-super.woff2", family: "Druk Wide Super" }];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function optionalFontsPlugin(): Plugin {
  const missing = () => OPTIONAL_FONTS.filter(({ file }) => !existsSync(resolve(publicFonts, file)));

  return {
    name: "optional-fonts",
    enforce: "pre",
    configResolved(config) {
      for (const { file } of missing()) {
        config.logger.info(`  ➜  fonts: public/fonts/${file} is not here (licensed, not in git); the title uses Sora.`);
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return missing().reduce(
          (page, { file }) =>
            page.replace(new RegExp(`\\s*<link\\s+rel="preload"\\s+href="\\./fonts/${escape(file)}"[^>]*>`, "g"), ""),
          html,
        );
      },
    },
    transform(code, id) {
      if (!id.split("?")[0]!.endsWith("/src/fonts.css")) return undefined;
      const gone = missing();
      if (!gone.length) return undefined;
      return gone.reduce(
        (css, { family }) => css.replace(new RegExp(`@font-face\\s*{[^}]*font-family:\\s*"${escape(family)}"[^}]*}\\s*`, "g"), ""),
        code,
      );
    },
  };
}
