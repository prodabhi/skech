import { describe, expect, test } from "bun:test";
import { redact } from "./rpc";

describe("a private RPC", () => {
  test("its token never reaches a log", () => {
    expect(redact("https://example-name.solana-devnet.quiknode.pro/7a0bdeadbeef/")).toBe("https://example-name.solana-devnet.quiknode.pro/…");
    expect(redact("https://api.devnet.solana.com")).toBe("https://api.devnet.solana.com");
    expect(redact("https://devnet.helius-rpc.com/?api-key=secret")).toBe("https://devnet.helius-rpc.com/…");
    expect(redact("not a url")).toBe("<rpc>");
  });
});
