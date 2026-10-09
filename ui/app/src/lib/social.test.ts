import { describe, expect, test } from "bun:test";
import { socialMoney } from "./social";

describe("socialMoney", () => {
  test("USDC millionths as dollars, rounded to the cent, signed when asked", () => {
    expect(socialMoney("0")).toBe("$0");
    expect(socialMoney("1250000")).toBe("$1.25");
    expect(socialMoney("1000000000", true)).toBe("+$1,000");
    expect(socialMoney("-2505000", true)).toBe("−$2.51");
    // Less than half a cent is nothing, without a sign.
    expect(socialMoney("-4000", true)).toBe("$0");
    // Beyond what a float holds exactly.
    expect(socialMoney("123456789012345678901")).toBe("$123,456,789,012,345.68");
  });
});
