import { useMemo, useState } from "react";
import type { ListenerRecord } from "../../shared/contracts/records";
import { createLogger } from "../../shared/logger";
import {
  compareSnapshots,
  copySnapshotRecords,
  recordIdentity,
} from "./comparison";
import type { SnapshotContext } from "./snapshots";

const logger = createLogger("popup.baseline");

function RecordLabel({ record }: { record: ListenerRecord }) {
  return (
    <span>
      {record.eventType} · {record.source.path} · frame {record.frameId} ·
      document {record.documentId}
    </span>
  );
}

export function SnapshotComparison({
  records,
  context,
  onRefresh,
}: {
  records: ListenerRecord[];
  context: SnapshotContext;
  onRefresh?: () => void;
}) {
  const [baseline, setBaseline] = useState<{
    records: ListenerRecord[];
    capturedAt: number;
    partial: boolean;
  } | null>(null);
  const current = useMemo(() => copySnapshotRecords(records), [records]);
  const comparison = useMemo(
    () => (baseline ? compareSnapshots(baseline.records, current) : null),
    [baseline, current],
  );

  return (
    <section className="snapshot-tools" aria-label="Сравнение снимков">
      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setBaseline({
              records: copySnapshotRecords(records),
              capturedAt: Date.now(),
              partial: context.partial,
            });
            logger.debug("Базовый снимок сохранён", { count: records.length });
          }}
        >
          {baseline ? "Заменить базовый снимок" : "Запомнить снимок"}
        </button>
        {onRefresh && (
          <button type="button" className="secondary" onClick={onRefresh}>
            Обновить снимок
          </button>
        )}
        {baseline && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setBaseline(null);
              logger.debug("Базовый снимок сброшен");
            }}
          >
            Сбросить сравнение
          </button>
        )}
      </div>
      {baseline && comparison && (
        <>
          <p className="scope">
            Базовый снимок:{" "}
            {new Date(baseline.capturedAt).toLocaleTimeString("ru-RU")}.
            Сравниваем все записи, независимо от фильтров.
          </p>
          <p className="comparison-count" role="status" aria-live="polite">
            Добавлено: {comparison.added.length}. Нет в текущем снимке:{" "}
            {comparison.missing.length}. Изменено: {comparison.changed.length}.
            Без изменений: {comparison.unchanged}.
          </p>
          <p className="scope">
            Отсутствие записи не доказывает удаление обработчика: возможны
            навигация фрейма или потеря данных.
          </p>
          {(baseline.partial || context.partial) && (
            <p className="scope">Один из снимков имеет неполное покрытие.</p>
          )}
          <ul className="comparison-changes">
            {comparison.added.map((record) => (
              <li
                key={`added-${recordIdentity(record)}`}
                data-change-kind="added"
              >
                Добавлено: <RecordLabel record={record} /> · {record.lifecycle}
              </li>
            ))}
            {comparison.missing.map((record) => (
              <li
                key={`missing-${recordIdentity(record)}`}
                data-change-kind="missing"
              >
                Нет в текущем снимке: <RecordLabel record={record} /> ·{" "}
                {record.lifecycle}
              </li>
            ))}
            {comparison.changed.map((change) => (
              <li
                key={`changed-${recordIdentity(change.after)}`}
                data-change-kind="changed"
              >
                <RecordLabel record={change.after} />
                <dl>
                  {change.fields.map((field) => (
                    <div key={field.name}>
                      <dt>{field.name}</dt>
                      <dd>
                        {field.before} → {field.after}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
      {!baseline && (
        <p className="scope">
          Запомните снимок, измените страницу и сравните регистрации. Базовый
          снимок хранится до закрытия popup или смены документа.
        </p>
      )}
    </section>
  );
}
