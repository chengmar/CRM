import { describe, expect, it } from "vitest";
import { runAcquisitionFoundationShadow } from "../src/acquisition/foundation-shadow.js";
import { LATEST_SCHEMA_VERSION } from "../src/db.js";

describe("acquisition foundation shadow", () => {
  it("proves canonical, multi-play and inbound idempotency without external actions", () => {
    const result = runAcquisitionFoundationShadow();
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({
      canonicalAccountDeduplicated: true,
      multiPlayEnrollmentSupported: true,
      intakeIdempotent: true,
      opportunityIdempotent: true,
      salesTaskIdempotent: true,
      externalActionsAttempted: false,
    });
    expect(result.summary).toMatchObject({
      schemaVersion: LATEST_SCHEMA_VERSION,
      accounts: 1,
      plays: 2,
      playVersions: 2,
      playEnrollments: 2,
      inquiryIntakes: 1,
      opportunities: 1,
      openSalesTasks: 1,
    });
  });
});
