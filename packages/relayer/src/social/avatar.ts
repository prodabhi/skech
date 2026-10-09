/**
 * An avatar, checked before it is kept and kept as bytes: PNG, JPEG or WebP only, at most AVATAR_BYTES, at most
 * AVATAR_PX a side, and the type read from the bytes themselves, which must agree with the type it says it is. The
 * app sends a 256-pixel square it has drawn again itself (which leaves out a photo's metadata); this is what a
 * request made by hand cannot get past. Served back with that type and `nosniff`, so a browser never guesses.
 */
export const AVATAR_BYTES = 96 * 1024;
export const AVATAR_PX = 1024;
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** What the bytes are and how big they draw, or null for anything else. */
export function sniffImage(b: Uint8Array): { type: AvatarType; width: number; height: number } | null {
  if (b.length < 32) return null;
  // PNG: the signature, IHDR first, IEND last.
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (ascii(b, 12, 4) !== "IHDR" || ascii(b, b.length - 8, 4) !== "IEND") return null;
    return { type: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  // JPEG: start and end of image, and the size from the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = u16be(b, at + 2);
      if (len < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "image/jpeg", width: u16be(b, at + 7), height: u16be(b, at + 5) };
      at += 2 + len;
    }
    return null;
  }
  // WebP: a RIFF whose length is the file's, then one of its three kinds of first chunk.
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    if (u32le(b, 4) + 8 !== b.length) return null;
    const kind = ascii(b, 12, 4);
    if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: "image/webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L" && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { type: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return null;
  }
  return null;
}

/** A data URL from the app, as bytes and type. Throws with what to tell the player. */
export function parseAvatar(value: unknown): { mime: AvatarType; bytes: Uint8Array } {
  const refuse = "Choose a PNG, JPEG or WebP picture under 96 KB";
  if (typeof value !== "string" || value.length > Math.ceil(AVATAR_BYTES / 3) * 4 + 32) throw new Error(refuse);
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m || m[2].length % 4 !== 0) throw new Error(refuse);
  const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
  if (bytes.length > AVATAR_BYTES) throw new Error(refuse);
  const seen = sniffImage(bytes);
  if (!seen || seen.type !== m[1]) throw new Error("This picture is not the image it says it is");
  if (!seen.width || !seen.height || seen.width > AVATAR_PX || seen.height > AVATAR_PX) throw new Error(`Choose a picture at most ${AVATAR_PX} pixels a side`);
  return { mime: seen.type, bytes };
}

/** How an avatar is served: its own type, never sniffed, never run, readable by the app's pages. */
export function avatarHeaders(mime: string): Record<string, string> {
  return {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": 'inline; filename="avatar"',
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "public, max-age=60",
  };
}
