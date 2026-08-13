import type { AgentDatabase } from "../db.js";

export interface ContinuousAcquisitionScheduleResult {
  status: "ENQUEUED" | "BUSY" | "NO_ELIGIBLE_CAMPAIGN";
  campaignId: string | null;
  jobId: string | null;
}

interface EligibleCampaignRow {
  id: string;
}

/**
 * Keeps one discovery campaign feeding the research lane without creating an
 * unbounded queue. Campaign and send authorization gates remain authoritative.
 */
export function scheduleContinuousAcquisition(
  db: AgentDatabase,
  now = new Date(),
): ContinuousAcquisitionScheduleResult {
  const active = db.db.prepare(
    `SELECT id FROM jobs
     WHERE job_type='DISCOVER_CAMPAIGN' AND status IN ('QUEUED','RUNNING')
     ORDER BY created_at, id LIMIT 1`,
  ).get() as { id: string } | undefined;
  if (active) {
    return { status: "BUSY", campaignId: null, jobId: active.id };
  }

  const asOf = now.toISOString();
  const campaign = db.db.prepare(
    `SELECT campaign.id
     FROM campaigns campaign
     JOIN campaign_send_authorizations authorization
       ON authorization.campaign_id=campaign.id
     LEFT JOIN campaign_send_authorization_revocations revocation
       ON revocation.campaign_send_authorization_id=authorization.id
     LEFT JOIN jobs history
       ON history.job_type='DISCOVER_CAMPAIGN'
      AND json_extract(history.payload_json, '$.campaignId')=campaign.id
     WHERE revocation.id IS NULL
       AND authorization.valid_from<=? AND authorization.expires_at>?
       AND campaign.status IN ('ENRICHMENT_PENDING','RUNNING','ACTIVE')
       AND (SELECT count(*) FROM leads lead WHERE lead.campaign_id=campaign.id)<campaign.target_count
     GROUP BY campaign.id, campaign.target_count, campaign.created_at
     ORDER BY max(history.updated_at) IS NOT NULL,
              max(history.updated_at),
              campaign.target_count-(SELECT count(*) FROM leads lead WHERE lead.campaign_id=campaign.id) DESC,
              campaign.created_at,
              campaign.id
     LIMIT 1`,
  ).get(asOf, asOf) as EligibleCampaignRow | undefined;
  if (!campaign) {
    return { status: "NO_ELIGIBLE_CAMPAIGN", campaignId: null, jobId: null };
  }

  const jobId = db.enqueueJob(
    "DISCOVER_CAMPAIGN",
    {
      campaignId: campaign.id,
      trigger: "CONTINUOUS_OPERATIONS",
    },
    undefined,
    { dedupeKey: `continuous-discovery:${campaign.id}` },
  );
  db.recordEvent("system", "continuous_acquisition", "CONTINUOUS_DISCOVERY_SCHEDULED", "system", {
    campaignId: campaign.id,
    jobId,
  });
  return { status: "ENQUEUED", campaignId: campaign.id, jobId };
}
