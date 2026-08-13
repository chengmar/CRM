import type { LeadStatus, MessageStatus } from "./types.js";

const leadTransitions: Record<LeadStatus, Set<LeadStatus>> = {
  NEW: new Set(["VERIFYING", "REJECTED", "DO_NOT_CONTACT"]),
  VERIFYING: new Set(["ENRICHING", "READY_FOR_REVIEW", "REJECTED", "DO_NOT_CONTACT"]),
  ENRICHING: new Set(["VERIFYING", "READY_FOR_REVIEW", "ENRICHMENT_EXHAUSTED", "REJECTED", "DO_NOT_CONTACT"]),
  ENRICHMENT_EXHAUSTED: new Set(["VERIFYING", "ENRICHING", "REJECTED", "DO_NOT_CONTACT"]),
  REJECTED: new Set(["VERIFYING", "DO_NOT_CONTACT"]),
  READY_FOR_REVIEW: new Set(["APPROVED", "REJECTED", "DO_NOT_CONTACT"]),
  APPROVED: new Set(["CONTACTED", "REJECTED", "DO_NOT_CONTACT"]),
  CONTACTED: new Set(["REPLIED", "INQUIRY_RECEIVED", "HUMAN_TAKEOVER", "DO_NOT_CONTACT"]),
  REPLIED: new Set(["INQUIRY_RECEIVED", "HUMAN_TAKEOVER", "DO_NOT_CONTACT"]),
  INQUIRY_RECEIVED: new Set(["HUMAN_TAKEOVER"]),
  HUMAN_TAKEOVER: new Set(["DO_NOT_CONTACT"]),
  DO_NOT_CONTACT: new Set(),
};

const messageTransitions: Record<MessageStatus, Set<MessageStatus>> = {
  DRAFT: new Set(["PENDING_APPROVAL", "CANCELLED"]),
  PENDING_APPROVAL: new Set(["APPROVED", "CANCELLED"]),
  APPROVED: new Set(["SCHEDULED", "SENDING", "CANCELLED"]),
  SCHEDULED: new Set(["SENDING", "CANCELLED"]),
  SENDING: new Set(["UNKNOWN_RECONCILIATION_REQUIRED", "SENT", "FAILED", "CANCELLED"]),
  UNKNOWN_RECONCILIATION_REQUIRED: new Set(["APPROVED", "SENT", "BOUNCED", "REPLIED", "CANCELLED"]),
  SENT: new Set(["DELIVERED", "BOUNCED", "REPLIED"]),
  DELIVERED: new Set(["BOUNCED", "REPLIED"]),
  BOUNCED: new Set(),
  REPLIED: new Set(),
  CANCELLED: new Set(),
  FAILED: new Set(["SCHEDULED", "CANCELLED"]),
};

export function assertLeadTransition(from: LeadStatus, to: LeadStatus): void {
  if (from === to) return;
  if (!leadTransitions[from].has(to)) {
    throw new Error(`Invalid lead transition: ${from} -> ${to}`);
  }
}

export function assertMessageTransition(from: MessageStatus, to: MessageStatus): void {
  if (from === to) return;
  if (!messageTransitions[from].has(to)) {
    throw new Error(`Invalid message transition: ${from} -> ${to}`);
  }
}

export function isAutomationLocked(status: LeadStatus, humanTakeover: boolean): boolean {
  return humanTakeover || ["INQUIRY_RECEIVED", "HUMAN_TAKEOVER", "DO_NOT_CONTACT"].includes(status);
}
