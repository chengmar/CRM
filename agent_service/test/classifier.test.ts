import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { classifyInbound } from "../src/inbound/classifier.js";

const disabledLlm = { isConfigured: () => false } as never;
const config = loadConfig({});

describe("classifyInbound", () => {
  it("classifies a quotation request as P1 and requires takeover", async () => {
    const result = await classifyInbound(
      {
        from: "buyer@example.com",
        subject: "sample components quotation",
        body: "Please quote 500 pcs and confirm MOQ and lead time.",
      },
      disabledLlm,
      config,
    );
    expect(result.classification).toBe("P1_INQUIRY");
    expect(result.shouldTakeover).toBe(true);
    expect(result.shouldStopAutomation).toBe(true);
  });

  it("classifies unsubscribe and stops automation", async () => {
    const result = await classifyInbound(
      { from: "buyer@example.com", subject: "", body: "Please remove me from your list." },
      disabledLlm,
      config,
    );
    expect(result.classification).toBe("UNSUBSCRIBE");
    expect(result.shouldStopAutomation).toBe(true);
  });

  it("separates permanent and temporary delivery failures", async () => {
    const hard = await classifyInbound(
      {
        from: "mailer-daemon@example.com",
        subject: "Delivery Status Notification (Failure)",
        body: "Final-Recipient: rfc822; buyer@example.com\nStatus: 5.1.1\n550 mailbox does not exist",
      },
      disabledLlm,
      config,
    );
    expect(hard).toMatchObject({ classification: "BOUNCE", shouldStopAutomation: true });

    const soft = await classifyInbound(
      {
        from: "mailer-daemon@example.com",
        subject: "Delivery Status Notification (Delay)",
        body: "Final-Recipient: rfc822; buyer@example.com\nStatus: 4.2.0\nDelivery delayed temporarily",
      },
      disabledLlm,
      config,
    );
    expect(soft).toMatchObject({ classification: "SOFT_BOUNCE", shouldStopAutomation: false });
  });

  it("conservatively stops on a matched non-text reply", async () => {
    const result = await classifyInbound(
      {
        from: "buyer@example.com",
        subject: "WhatsApp message",
        body: "",
        headers: { matchedInbound: true, hasNonTextContent: true, messageType: "image" },
      },
      disabledLlm,
      config,
    );
    expect(result).toMatchObject({
      classification: "OTHER_REPLY",
      shouldNotify: true,
      shouldStopAutomation: true,
    });
  });
});
