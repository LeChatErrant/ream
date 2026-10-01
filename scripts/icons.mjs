// Renders Ream's app icons from the shared mark geometry (src/lib/ream-mark.js).
// Re-run after changing the mark: `npm run icons`. Output lands in public/ and
// is committed — the build only copies it.
//
//   icon.svg              rounded tile — favicon + the manifest's "any" icon
//   pwa-192x192.png       the same tile as PNG, for platforms that skip SVG
//   pwa-512x512.png
//   maskable-512x512.png  full-bleed square for Android's adaptive icons; the
//                         mark sits well inside the safe zone (inner 80% circle)
//   apple-touch-icon.png  180×180 full-bleed — iOS ignores SVG and manifest
//                         icons and rounds this one itself
import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { markSvg, MARK_W, MARK_H } from "../src/lib/ream-mark.js";

const OUT = new URL("../public/", import.meta.url);
const BG = "#1a1e27"; // --page: the launch splash (manifest background_color) matches
const S = 512;
const MARK_SHARE = 0.5; // mark width as a share of the tile

function tile({ rounded }) {
  const k = (S * MARK_SHARE) / MARK_W;
  const x = (S - MARK_W * k) / 2;
  const y = (S - MARK_H * k) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">` +
    `<rect width="${S}" height="${S}"${rounded ? ' rx="112"' : ""} fill="${BG}"/>` +
    `<g transform="translate(${+x.toFixed(2)} ${+y.toFixed(2)}) scale(${+k.toFixed(4)})">${markSvg()}</g>` +
    `</svg>\n`
  );
}

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

const rounded = tile({ rounded: true });
const square = tile({ rounded: false });
writeFileSync(new URL("icon.svg", OUT), rounded);
writeFileSync(new URL("pwa-192x192.png", OUT), png(rounded, 192));
writeFileSync(new URL("pwa-512x512.png", OUT), png(rounded, 512));
writeFileSync(new URL("maskable-512x512.png", OUT), png(square, 512));
writeFileSync(new URL("apple-touch-icon.png", OUT), png(square, 180));
console.log("Icons written to public/");
