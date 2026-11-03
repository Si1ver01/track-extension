import { useState } from "react";
import type { ListenerRecord } from "../../shared/contracts/records";
import { createLogger } from "../../shared/logger";
import {
  createSnapshotExport,
  downloadSnapshot,
  type SnapshotContext,
} from "./snapshots";
import { Download } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";

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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Download />
            Экспорт JSON
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => exportRecords("all")}>
            Экспорт всего снимка
            <DropdownMenuShortcut>{records.length}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => exportRecords("filtered")}>
            Экспорт выборки
            <DropdownMenuShortcut>{visibleRecords.length}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
