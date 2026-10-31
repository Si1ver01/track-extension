import type { PageContextKind } from "./records";

export type RevealStatus =
  | "REVEALED"
  | "SHADOW_HOST"
  | "TARGET_UNAVAILABLE"
  | "NO_ELEMENT"
  | "DOCUMENT_CHANGED"
  | "ACCESS_DENIED"
  | "REVEAL_FAILED"
  | "TIMEOUT"
  | "CANCELLED";

export interface RevealResult {
  status: RevealStatus;
}

export interface RevealTargetRequest {
  type: "reveal-listener-target";
  tabId: number;
  frameId: number;
  mainDocumentId: string;
  documentId: string;
  contextKind: PageContextKind;
  recordId: string;
}

const statuses = new Set<RevealStatus>([
  "REVEALED",
  "SHADOW_HOST",
  "TARGET_UNAVAILABLE",
  "NO_ELEMENT",
  "DOCUMENT_CHANGED",
  "ACCESS_DENIED",
  "REVEAL_FAILED",
  "TIMEOUT",
  "CANCELLED",
]);

export function isRevealResult(value: unknown): value is RevealResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    statuses.has((value as RevealResult).status),
  );
}
