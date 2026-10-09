import { describe, expect, test } from "bun:test";
import { AVATAR_BYTES, avatarHeaders, parseAvatar, sniffImage } from "./avatar";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const png = (w: number, h: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...Buffer.from("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...Buffer.from("IEND"), 0xae, 0x42, 0x60, 0x82]);
const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const webp = (w: number, h: number) => {
  const chunk = [...Buffer.from("VP8X"), ...le32(10), 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0];
  return new Uint8Array([...Buffer.from("RIFF"), ...le32(4 + chunk.length + 8), ...Buffer.from("WEBP"), ...chunk, 0, 0, 0, 0, 0, 0, 0, 0]);
};
const url = (type: string, bytes: Uint8Array) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

describe("avatars", () => {
  test("PNG, JPEG and WebP are read from their bytes, with their size", () => {
    expect(sniffImage(png(256, 256))).toEqual({ type: "image/png", width: 256, height: 256 });
    expect(sniffImage(jpeg(200, 100))).toEqual({ type: "image/jpeg", width: 200, height: 100 });
    // A RIFF whose length is not the file's is refused; the fixture's is right.
    expect(sniffImage(webp(256, 128))?.type).toBe("image/webp");
    expect(sniffImage(webp(256, 128))?.width).toBe(256);
  });

  test("anything else is refused, whatever it says it is", () => {
    const html = new TextEncoder().encode(`<html><script>alert(1)</script>${" ".repeat(64)}</html>`);
    expect(sniffImage(html)).toBeNull();
    expect(() => parseAvatar(url("image/png", html))).toThrow("not the image it says");
    // A JPEG called a PNG.
    expect(() => parseAvatar(url("image/png", jpeg(10, 10)))).toThrow("not the image it says");
    expect(() => parseAvatar(url("image/svg+xml", png(10, 10)))).toThrow();
    expect(() => parseAvatar(url("image/gif", png(10, 10)))).toThrow();
    expect(() => parseAvatar("https://example.com/a.png")).toThrow();
    expect(() => parseAvatar(42)).toThrow();
  });

  test("a size cap on the bytes and on the pixels", () => {
    expect(parseAvatar(url("image/png", png(256, 256))).mime).toBe("image/png");
    expect(() => parseAvatar(url("image/png", png(40_000, 40_000)))).toThrow("pixels");
    const big = new Uint8Array(AVATAR_BYTES + 1);
    big.set(png(10, 10));
    expect(() => parseAvatar(url("image/png", big))).toThrow();
  });

  test("served as itself and never sniffed", () => {
    const h = avatarHeaders("image/png");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-type"]).toBe("image/png");
    expect(h["content-security-policy"]).toContain("sandbox");
  });
});
