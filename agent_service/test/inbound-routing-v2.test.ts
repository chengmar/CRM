import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { classifyInbound } from "../src/inbound/classifier.js";

const disabledLlm = { isConfigured: () => false } as never;
const config = loadConfig({});

describe("WO-09/WO-16 inbound routing v2", () => {
  it("keeps commercial questions P1 even when the reply also contains negative wording", async () => {
    const classification = await classifyInbound({
      from: "buyer@example.com",
      subject: "Not relevant for this model",
      body: "We do not need that model. Please quote 500 sample components and confirm MOQ and lead time.",
    }, disabledLlm, config);

    expect(classification).toMatchObject({
      classification: "P1_INQUIRY",
      shouldTakeover: true,
      shouldStopAutomation: true,
    });
  });

  it("routes a named responsible-contact reply as REFERRAL and requires takeover", async () => {
    const classification = await classifyInbound({
      from: "operations@example.com",
      subject: "Re: sample application",
      body: "Please contact Maria Santos. Our procurement manager handles sample components.",
    }, disabledLlm, config);

    expect(classification).toMatchObject({
      classification: "REFERRAL",
      shouldNotify: true,
      shouldTakeover: true,
      shouldStopAutomation: true,
    });
  });

  it("separates wrong person from opt-out and stops only the active conversation", async () => {
    const classification = await classifyInbound({
      from: "engineer@example.com",
      subject: "Re: sample components",
      body: "I am not the right person and do not handle procurement.",
    }, disabledLlm, config);

    expect(classification).toMatchObject({
      classification: "WRONG_PERSON",
      shouldNotify: true,
      shouldTakeover: false,
      shouldStopAutomation: true,
    });
  });

  it("keeps an explicit do-not-contact request as UNSUBSCRIBE", async () => {
    const classification = await classifyInbound({
      from: "buyer@example.com",
      subject: "Stop",
      body: "I am the wrong person. Please do not contact us again.",
    }, disabledLlm, config);

    expect(classification.classification).toBe("UNSUBSCRIBE");
  });
});
