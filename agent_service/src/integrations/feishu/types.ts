import type { InboundMessageInput } from "../../db.js";
import type { InboundClassification } from "../../types.js";

export type FeishuCommandHandler = (input: {
  text: string;
  senderId: string;
  chatId: string;
  messageId: string;
}) => Promise<string | { card: object }>;

export type FeishuActionHandler = (input: {
  action: unknown;
  senderId: string;
  chatId: string;
  messageId: string;
}) => Promise<string | { card: object }>;

export interface FeishuNotificationPayload {
  lead: Record<string, unknown>;
  inbound: InboundMessageInput;
  classification: InboundClassification;
}

export interface FeishuQuarantinePayload {
  intake: Record<string, unknown>;
  inbound: InboundMessageInput;
  classification: InboundClassification;
}

export interface FeishuDeliveryReconciliationPayload {
  message: Record<string, unknown>;
}

export interface FeishuImapHealthPayload {
  episode: number;
  state: string;
  reason: string;
  consecutiveFailures: number;
  failurePauseThreshold: number;
  lastPollSuccessAt: string | null;
  pausedAt: string | null;
  recovered: boolean;
  globalPauseRemains: boolean;
}

export interface FeishuImapMessageQuarantinePayload {
  failureId: string;
  uidValidity: string;
  uid: number;
  attempts: number;
  maxAttempts: number;
  quarantineEpisode: number;
  sourceSha256: string;
  sourceSize: number;
  preview: Record<string, unknown>;
  errorClass: string;
  errorMessage: string;
}

export interface ImapOperationsNotifier {
  stageImapRuntimeHealth(payload: FeishuImapHealthPayload): boolean;
  stageImapMessageQuarantine(payload: FeishuImapMessageQuarantinePayload): boolean;
}
