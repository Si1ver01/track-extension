import { useEffect, useMemo, useRef, useState } from "react";
import type { ListenerRecord } from "../../shared/contracts/records";
import type { ComparisonBaseline } from "../../shared/contracts/site-access";
import {
  compareSnapshots,
  copySnapshotRecords,
  recordIdentity,
} from "./comparison";
import type { SnapshotContext } from "./snapshots";

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
  baseline,
  onBaselineChange,
}: {
  records: ListenerRecord[];
  context: SnapshotContext;
  onRefresh?: () => void;
  baseline: ComparisonBaseline | null;
  onBaselineChange?: (capture: boolean) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const changeBaseline = async (capture: boolean) => {
    if (pending.current || !onBaselineChange) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const success = await onBaselineChange(capture);
      if (mounted.current) setError(!success);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const current = useMemo(() => copySnapshotRecords(records), [records]);
  const comparison = useMemo(
    () => (baseline ? compareSnapshots(baseline.records, current) : null),
    [baseline, current],
  );

  return (
    <section
      className="snapshot-tools"
      aria-label="Сравнение снимков"
      aria-busy={busy}
    >
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || !onBaselineChange}
          onClick={() => void changeBaseline(true)}
        >
          {baseline ? "Заменить базовый снимок" : "Запомнить снимок"}
        </button>
        {onRefresh && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onRefresh}
          >
            Обновить снимок
          </button>
        )}
        {baseline && (
          <button
            type="button"
            className="secondary"
            disabled={busy || !onBaselineChange}
            onClick={() => void changeBaseline(false)}
          >
            Сбросить сравнение
          </button>
        )}
      </div>
      {error && (
        <p role="alert">
          Не удалось изменить базовый снимок. Повторите попытку.
        </p>
      )}
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
          снимок сохраняется при закрытии popup, но может сброситься, если
          браузер приостановит работу расширения.
        </p>
      )}
    </section>
  );
}
