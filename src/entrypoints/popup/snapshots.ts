import type { ListenerRecord } from "../../shared/contracts/records";
import type { SiteCoverage } from "../../shared/contracts/site-access";
import { createLogger } from "../../shared/logger";
import { sanitizeListenerRecord } from "../../shared/records/sanitize";

const logger = createLogger("popup.snapshots");

export interface SnapshotContext {
  partial: boolean;
  coverage?: SiteCoverage;
  documentId?: string;
}

export function createSnapshotExport({
  records,
  totalCount,
  scope,
  context,
  now = new Date(),
}: {
  records: readonly ListenerRecord[];
  totalCount: number;
  scope: "all" | "filtered";
  context: SnapshotContext;
  now?: Date;
}) {
  // Повторный whitelist на границе файла исключает дополнительные поля,
  // произвольные descriptions, options, scriptLocation и ограничения страницы.
  const safeRecords = records.flatMap((record) => {
    const safe = sanitizeListenerRecord(record, {
      tabId: record.tabId,
      frameId: record.frameId,
      documentId: record.documentId,
    });
    if (!safe) return [];
    safe.source.sourceKind = [
      "add-event-listener",
      "event-handler-property",
      "inline-attribute",
    ].includes(record.source.sourceKind ?? "")
      ? record.source.sourceKind
      : undefined;
    safe.browser = ["chrome", "firefox"].includes(record.browser)
      ? record.browser
      : "unknown";
    return [safe];
  });
  const reasons = (context.coverage?.reasons ?? []).filter(
    (reason) => reason === "FRAME_PARTIAL" || reason === "RECORD_LIMIT_REACHED",
  );
  const result = {
    format: "listener-lens-snapshot",
    version: 1,
    exportedAt: now.toISOString(),
    documentId: context.documentId,
    scope,
    totalCount,
    exportedCount: safeRecords.length,
    omittedCount: records.length - safeRecords.length,
    coverage: {
      partial: context.partial,
      recordLimit: context.coverage?.recordLimit ?? null,
      reasons: [...reasons],
    },
    warnings: [
      "Снимок содержит регистрации обработчиков, а не их срабатывания.",
      "Регистрации до запуска сборщика и недоступные контексты могут отсутствовать.",
      ...(context.partial ? ["Покрытие сбора неполное."] : []),
      ...(reasons.includes("RECORD_LIMIT_REACHED")
        ? ["Достигнут лимит: часть записей потеряна."]
        : []),
      ...(reasons.includes("FRAME_PARTIAL")
        ? ["Часть фреймов недоступна."]
        : []),
    ],
    records: safeRecords,
  };
  logger.debug("Снимок подготовлен", {
    scope,
    totalCount,
    exportedCount: result.exportedCount,
    omittedCount: result.omittedCount,
    partial: context.partial,
  });
  return result;
}

export function downloadSnapshot(
  snapshot: ReturnType<typeof createSnapshotExport>,
) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2) + "\n"], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = `listener-lens-${snapshot.scope}-${snapshot.exportedAt.replace(/[:.]/g, "-")}.json`;
    document.body.append(link);
    link.click();
    logger.debug("Запрошено скачивание", { count: snapshot.exportedCount });
  } finally {
    link.remove();
    // Браузеру даём обработать click до освобождения Blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
