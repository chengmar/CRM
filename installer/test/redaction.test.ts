import { describe, expect, it } from "vitest";
import { redactText } from "../src/main/engine/redaction.js";

describe("redactText", () => {
  it("removes known credentials and common token patterns", () => {
    const openAiStyleToken = ["sk", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const facebookStyleToken = ["EA", "123456789", "abcdefgh"].join("");
    const output = redactText(
      `password=hunter2 api_key=${openAiStyleToken} token=${facebookStyleToken}`,
      ["hunter2"],
    );
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain(openAiStyleToken);
    expect(output).not.toContain(facebookStyleToken);
  });
});
