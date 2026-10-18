import type { ListenerRecord } from "./records";

export const MAX_COLLECTOR_RECORDS = 200;

export interface CollectorReply {
  stop?: boolean;
  recover?: boolean;
}

export interface CollectorSnapshot {
  type: "collector-snapshot";
  documentId: string;
  token: string;
  records: ListenerRecord[];
  partial: boolean;
  recordLimitReached: boolean;
  navigationId?: string;
}
