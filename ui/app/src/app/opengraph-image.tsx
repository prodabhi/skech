import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt =
  "skech. Draw the chart. Trade the line. A blue pen draws a looping price path beside green and red candlesticks. skech.trade";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The landing's share card, served as is. */
export default async function OpengraphImage() {
  const image = await readFile(join(process.cwd(), "public/assets/social/skech-trade-og.png"));
  return new Response(new Uint8Array(image), { headers: { "Content-Type": contentType } });
}
