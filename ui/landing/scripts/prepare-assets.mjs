/**
 * Asset pipeline. Run: bun run assets
 *
 * The site draws its own chart, candles, meters and strokes, so there is very
 * little left to prepare. Three things come out of here:
 *
 *   1. logo-mark-alpha, the mark rebuilt as white-on-transparent so it can be
 *      used as a CSS mask and tinted with currentColor.
 *   2. logo-mark-ink, the same mark flattened to the ink colour, for the
 *      OG card. Satori cannot apply a CSS mask, so the tint has to be baked.
 *   3. src/app/icon.png, drawn rather than downscaled.
 *
 * public/assets/logo-mark.png is the only source input. Everything else that
 * used to live there was illustration the page no longer uses.
 */
import sharp from "sharp";

const DIR = "public/assets";

/**
 * The source mark is opaque ink on opaque black, so using it directly as a CSS
 * mask paints a solid rectangle: a mask reads the *alpha* channel and every
 * pixel is alpha 255. This rebuilds it as white-on-transparent with alpha taken
 * from luminance, which makes it tintable and freely dimmable.
 */
async function toAlphaMask(input, out, gain = 1.35) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const s = i * info.channels;
    const lum = 0.2126 * data[s] + 0.7152 * data[s + 1] + 0.0722 * data[s + 2];
    const d = i * 4;
    px[d] = 255;
    px[d + 1] = 255;
    px[d + 2] = 255;
    px[d + 3] = Math.min(255, Math.round(lum * gain));
  }
  await sharp(px, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).toFile(out);
}

// The mark floats in a lot of dead space; at 24px in the nav that would render
// as a speck, so trim to the ink first.
const trimmed = await sharp(`${DIR}/logo-mark.png`)
  .trim({ threshold: 12 })
  .toBuffer();
const { width, height } = await sharp(trimmed).metadata();
console.log(`trimmed logo-mark -> ${width}x${height}`);

await toAlphaMask(trimmed, `${DIR}/logo-mark-alpha.png`);
/**
 * The same mask flattened onto the ink colour, keeping its alpha.
 *
 * The OG card is drawn by Satori, which has no CSS masks, so it cannot do what
 * the site does and paint the mark with currentColor. On paper the white mask
 * would be invisible, hence a baked ink copy.
 */
async function toInk(input, out, [r, g, b]) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const d = i * 4;
    px[d] = r;
    px[d + 1] = g;
    px[d + 2] = b;
    px[d + 3] = data[i * info.channels + 3];
  }
  await sharp(px, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).toFile(out);
}

// #343433, the heading ink.
await toInk(`${DIR}/logo-mark-alpha.png`, `${DIR}/logo-mark-ink.png`, [52, 52, 51]);
console.log("wrote logo-mark-ink.png");

const webp = await sharp(`${DIR}/logo-mark-alpha.png`)
  .webp({ quality: 82, effort: 5 })
  .toFile(`${DIR}/logo-mark-alpha.webp`);
console.log(`wrote logo-mark-alpha.png and .webp (${Math.round(webp.size / 1024)}kb)`);

// App icon, drawn rather than downscaled.
//
// The source mark is a rendered squiggle with fine tapering ends; shrunk to
// 16px it turns to mush. This is the same gesture rebuilt as geometry with one
// bend and one lit head, at a stroke weight that still lands on a whole pixel
// at 16px (64/512 of the canvas is ~2px there).
//
// The ground stays dark even though the site is paper: a white favicon
// disappears into a light tab strip, and this warm near-black is the same one
// the product surfaces use, so it is on palette rather than a leftover. The
// stroke is the dark-card blue for the same reason.
const ICON = 512;
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1b1a18"/>
  <path d="M104 376 C 176 352, 220 314, 266 266 S 342 186, 376 152"
        fill="none" stroke="#8fb0ff" stroke-width="64" stroke-linecap="round"/>
  <circle cx="392" cy="140" r="46" fill="#fafaf9"/>
</svg>`;
await sharp(Buffer.from(iconSvg)).png().toFile("src/app/icon.png");
console.log(`wrote src/app/icon.png (${ICON}x${ICON}, drawn)`);

// The hero and section illustrations, as lossless WebP beside their PNGs: the
// same pixels (colour under transparency included, which the dark-mode filter
// reads) at about half the bytes. The page offers the WebP and keeps the PNG
// for a browser that cannot read it (src/components/site/illo.tsx).
const ILLO = `${DIR}/illo`;
const ART = ["hero-left", "hero-right", "scene-steps", "scene-example", "scene-redraw", "scene-faq"];
for (const name of ART.flatMap((n) => [n, `${n}-dark`])) {
  const out = await sharp(`${ILLO}/${name}.png`)
    .webp({ lossless: true, effort: 6, exact: true })
    .toFile(`${ILLO}/${name}.webp`);
  console.log(`wrote illo/${name}.webp (${Math.round(out.size / 1024)}kb)`);
}
