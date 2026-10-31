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

export type SiteCoverageReason = "FRAME_PARTIAL" | "RECORD_LIMIT_REACHED";

export interface SiteCoverage {
  reasons: SiteCoverageReason[];
  recordLimit: number;
}

export interface ComparisonBaseline {
  documentId: string;
  records: ListenerRecord[];
  capturedAt: number;
  partial: boolean;
}

export interface ComparisonBaselineResult {
  baseline: ComparisonBaseline | null;
}

export interface SiteAccessSnapshot {
  tabId: number;
  site: SiteScope | null;
  status: SiteAccessStatus;
  records: ListenerRecord[];
  documentId?: string;
  reason?: string;
  coverage?: SiteCoverage;
  baseline?: ComparisonBaseline;
}

export type SiteAccessRequest =
  | { type: "get-site-access"; tabId: number }
  | { type: "activate-site"; tabId: number; pattern: string }
  | { type: "revoke-site"; tabId: number; pattern: string }
  | {
      type: "set-comparison-baseline" | "clear-comparison-baseline";
      tabId: number;
      documentId: string;
    };
