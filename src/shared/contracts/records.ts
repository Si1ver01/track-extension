export type BrowserName = "chrome" | "firefox" | "unknown";
export type ListenerTarget = "window" | "document" | "element" | "unknown";
export type PageContextKind = "document" | "shadow-root" | "worker" | "unknown";
export type NavigationKind = "initial" | "spa" | "full" | "unknown";
export type ListenerLifecycle = "active" | "removed" | "unknown";
export type ListenerSourceKind =
  "add-event-listener" | "event-handler-property" | "inline-attribute";
export type ListenerReasonCode =
  | "HOOK_LATE"
  | "SURFACE_UNVERIFIED"
  | "RECORD_TRUNCATED"
  | "RECORD_LIMIT_REACHED"
  | "SOURCE_UNAVAILABLE"
  | "UNSUPPORTED_CONTEXT"
  | "FRAME_UNAVAILABLE"
  | "NAVIGATION_RESET";

export interface ListenerOptions {
  capture: boolean | null;
  passive: boolean | null;
  once: boolean | null;
}

export interface SourceMetadata {
  target: ListenerTarget;
  path: string;
  options?: string[];
  scriptLocation?: string;
  sourceKind?: ListenerSourceKind;
}

export interface ListenerRecord {
  id: string;
  eventType: string;
  description: string;
  tabId: number;
  frameId: number;
  documentId: string;
  contextKind: PageContextKind;
  navigationId?: string;
  navigationKind?: NavigationKind;
  source: SourceMetadata;
  browser: BrowserName;
  capturedAt: number;
  limitations: string[];
  lifecycle: ListenerLifecycle;
  reasonCodes: ListenerReasonCode[];
  listenerKey?: string;
  listenerOptions?: ListenerOptions;
}

export interface ListenerMessage {
  type:
    | "listener-record"
    | "scan-status"
    | "get-tab-state"
    | "context-navigation"
    | "context-reset";
  record?: ListenerRecord;
  tabId?: number;
  frameId?: number;
  documentId?: string;
  contextKind?: PageContextKind;
  navigationId?: string;
  navigationKind?: NavigationKind;
  reasonCodes?: ListenerReasonCode[];
}

export interface BridgeHandshake {
  source: "listener-lens";
  type: "install-bridge";
  nonce: string;
  documentId?: string;
}

export interface BridgeRecordMessage extends ListenerMessage {
  source: "listener-lens";
  nonce: string;
}

export function isListenerMessage(value: unknown): value is ListenerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ListenerMessage>;
  if (message.type === "get-tab-state")
    return Number.isInteger(message.tabId) && message.tabId! >= 0;
  if (message.type === "scan-status") return true;
  if (message.type === "context-navigation" || message.type === "context-reset")
    return (
      typeof message.documentId === "string" && message.documentId.length > 0
    );
  if (message.type !== "listener-record" || !message.record) return false;
  const record = message.record;
  return (
    typeof record.id === "string" &&
    typeof record.eventType === "string" &&
    Number.isInteger(record.tabId) &&
    record.tabId >= 0 &&
    Number.isInteger(record.frameId) &&
    record.frameId >= 0 &&
    typeof record.documentId === "string" &&
    record.documentId.length > 0 &&
    typeof record.contextKind === "string" &&
    typeof record.source?.path === "string"
  );
}

export interface TabState {
  tabId: number;
  records: ListenerRecord[];
  status: "scanning" | "ready" | "limited" | "error";
  contexts?: Record<
    string,
    {
      documentId: string;
      frameId: number;
      contextKind: PageContextKind;
      navigationId?: string;
    }
  >;
}

export interface ContextCapability {
  contextKind: PageContextKind;
  supported: boolean;
  reasonCodes: ListenerReasonCode[];
}

export const contextCapabilities: ContextCapability[] = [
  { contextKind: "document", supported: true, reasonCodes: [] },
  { contextKind: "shadow-root", supported: true, reasonCodes: [] },
  {
    contextKind: "worker",
    supported: false,
    reasonCodes: ["UNSUPPORTED_CONTEXT"],
  },
];
