import type { ListenerRecord } from "../contracts/records";

export function copySnapshotRecords(records: readonly ListenerRecord[]) {
  // Копируем только подтверждённые метаданные без дополнительных полей
  // и без вызова нормализатора, который пишет контекст каждой записи в DEBUG.
  return records.map((record): ListenerRecord => ({
    id: record.id,
    eventType: record.eventType,
    description: record.description,
    tabId: record.tabId,
    frameId: record.frameId,
    documentId: record.documentId,
    contextKind: record.contextKind,
    browser: record.browser,
    capturedAt: record.capturedAt,
    lifecycle: record.lifecycle,
    source: {
      target: record.source.target,
      path: record.source.path,
      sourceKind: record.source.sourceKind,
    },
    listenerOptions: record.listenerOptions && {
      capture: record.listenerOptions.capture,
      passive: record.listenerOptions.passive,
      once: record.listenerOptions.once,
    },
    reasonCodes: [...record.reasonCodes],
    limitations: [],
  }));
}
