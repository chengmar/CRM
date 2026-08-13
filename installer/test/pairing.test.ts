import { describe, expect, it } from "vitest";
import { hasAuthorizedFeishuOperator } from "../src/main/runtime/pairing.js";

describe("Feishu installer pairing gate", () => {
  it("does not confuse an alert chat with an authorized operator", () => {
    expect(
      hasAuthorizedFeishuOperator(
        JSON.stringify({
          config: {
            feishuAlertDestinationConfigured: true,
            feishuAuthorizedUserCount: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it("continues only after at least one user is authorized", () => {
    expect(
      hasAuthorizedFeishuOperator(
        JSON.stringify({ config: { feishuAuthorizedUserCount: 1 } }),
      ),
    ).toBe(true);
    expect(hasAuthorizedFeishuOperator("not-json")).toBe(false);
  });
});
