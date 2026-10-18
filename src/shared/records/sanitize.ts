import type { ListenerReasonCode, ListenerRecord } from "../contracts/records";
import { isSupportedEventType } from "../event-catalog/catalog";
import { normalizeRecord } from "./normalize";

const reasonCodes = new Set<ListenerReasonCode>([
  "HOOK_LATE",
  "SURFACE_UNVERIFIED",
  "RECORD_TRUNCATED",
  "RECORD_LIMIT_REACHED",
  "SOURCE_UNAVAILABLE",
  "UNSUPPORTED_CONTEXT",
  "FRAME_UNAVAILABLE",
  "NAVIGATION_RESET",
]);

export function safeMetadataId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,160}$/.test(value)
    ? value
    : undefined;
}

// Отбираем поля и до локального кэширования, и на границе background.
export function sanitizeListenerRecord(
  value: unknown,
  context: { tabId: number; frameId: number; documentId: string },
): ListenerRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as ListenerRecord;
  if (!isSupportedEventType(record.eventType)) return undefined;
  const source = record.source;
  if (!source || typeof source !== "object") return undefined;
  const safeBoolean = (flag: unknown) =>
    typeof flag === "boolean" ? flag : null;
  return normalizeRecord({
    ...context,
    id: safeMetadataId(record.id),
    eventType: record.eventType,
    browser: "unknown",
    capturedAt:
      Number.isFinite(record.capturedAt) && record.capturedAt >= 0
        ? record.capturedAt
        : undefined,
    contextKind:
      record.contextKind === "shadow-root" ? "shadow-root" : "document",
    source: {
      target: ["window", "document", "element"].includes(source.target)
        ? source.target
        : "unknown",
      path:
        typeof source.path === "string" &&
        /^[a-z][a-z0-9:-]{0,79}$/.test(source.path)
          ? source.path
          : "unknown",
      sourceKind:
        source.sourceKind === "inline-attribute" ||
        source.sourceKind === "event-handler-property"
          ? source.sourceKind
          : "add-event-listener",
    },
    lifecycle:
      record.lifecycle === "removed" || record.lifecycle === "unknown"
        ? record.lifecycle
        : "active",
    listenerKey: safeMetadataId(record.listenerKey),
    listenerOptions: {
      capture: safeBoolean(record.listenerOptions?.capture),
      passive: safeBoolean(record.listenerOptions?.passive),
      once: safeBoolean(record.listenerOptions?.once),
    },
    reasonCodes: [
      ...new Set<ListenerReasonCode>([
        ...(Array.isArray(record.reasonCodes)
          ? record.reasonCodes
              .slice(0, 16)
              .filter((code) => reasonCodes.has(code))
          : []),
        "HOOK_LATE",
      ]),
    ],
  });
}
