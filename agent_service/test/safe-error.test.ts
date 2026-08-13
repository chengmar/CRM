import { describe, expect, it } from "vitest";
import { safeError, safeLogArguments } from "../src/safe-error.js";

describe("safe error logging", () => {
  it("redacts configured secrets and drops request configuration objects", () => {
    const secret = "secret-value-for-test";
    const error = Object.assign(new Error(`request failed app_secret=${secret}`), {
      code: "EAI_AGAIN",
      config: { data: JSON.stringify({ app_secret: secret }) },
      cause: Object.assign(new Error(`nested ${secret}`), { hostname: "open.feishu.cn" }),
    });

    const serialized = JSON.stringify(safeError(error, [secret]));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("config");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("open.feishu.cn");

    const sdkLog = JSON.stringify(safeLogArguments([["[ws]", error]], [secret]));
    expect(sdkLog).not.toContain(secret);
    expect(sdkLog).not.toContain("config");
  });
});
