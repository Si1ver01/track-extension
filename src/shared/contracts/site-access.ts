import type { ListenerRecord } from "./records";

export interface SiteScope {
  pattern: string;
  label: string;
}

export type SiteAccessStatus =
  | "unsupported"
  | "no-access"
  | "reload-required"
  | "recovering"
  | "ready"
  | "limited"
  | "error";

export interface SiteAccessSnapshot {
  tabId: number;
  site: SiteScope | null;
  status: SiteAccessStatus;
  records: ListenerRecord[];
  reason?: string;
}

export type SiteAccessRequest =
  | { type: "get-site-access"; tabId: number }
  | { type: "activate-site"; tabId: number; pattern: string }
  | { type: "revoke-site"; tabId: number; pattern: string };
