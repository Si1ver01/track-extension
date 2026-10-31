import { useState } from "react";
import type { ListenerRecord } from "../../shared/contracts/records";
import { createLogger } from "../../shared/logger";
import {
  createSnapshotExport,
  downloadSnapshot,
  type SnapshotContext,
} from "./snapshots";

const logger = createLogger("popup.export");

export function SnapshotExport({
  records,
  visibleRecords,
  context,
}: {
  records: ListenerRecord[];
  visibleRecords: ListenerRecord[];
  context: SnapshotContext;
}) {
  const [message, setMessage] = useState("");
  function exportRecords(scope: "all" | "filtered") {
    try {
      const snapshot = createSnapshotExport({
        records: scope === "all" ? records : visibleRecords,
        totalCount: records.length,
        scope,
        context,
      });
      downloadSnapshot(snapshot);
      setMessage(`Файл подготовлен. Записей: ${snapshot.exportedCount}.`);
    } catch {
      logger.warn("Не удалось подготовить экспорт", { code: "EXPORT_FAILED" });
      setMessage("Не удалось сохранить JSON. Повторите попытку.");
    }
  }
  return (
    <section className="snapshot-tools" aria-label="Экспорт снимка">
      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() => exportRecords("all")}
        >
          Экспорт всего снимка
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => exportRecords("filtered")}
        >
          Экспорт выборки
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
