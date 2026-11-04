import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, RefreshCw, RotateCcw } from "lucide-react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import type { ListenerRecord } from "../../shared/contracts/records";
import type { ComparisonBaseline } from "../../shared/contracts/site-access";
import { compareSnapshots, recordIdentity } from "./comparison";
import type { SnapshotContext } from "./snapshots";

function RecordLabel({ record }: { record: ListenerRecord }) {
  return (
    <span>
      {record.eventType} · {record.source.path} · frame {record.frameId} ·
      document {record.documentId}
    </span>
  );
}

function ComparisonMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className={"comparison-metric metric-" + tone}>
      <span>{value}</span>
      <span>{label}</span>
    </div>
  );
}

export function SnapshotComparison({
  records,
  context,
  onRefresh,
  baseline,
  onBaselineChange,
  hideCaptureAction = false,
}: {
  records: ListenerRecord[];
  context: SnapshotContext;
  onRefresh?: () => void;
  baseline: ComparisonBaseline | null;
  onBaselineChange?: (capture: boolean) => Promise<boolean>;
  hideCaptureAction?: boolean;
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
  const comparison = useMemo(
    () => (baseline ? compareSnapshots(baseline.records, records) : null),
    [baseline, records],
  );

  return (
    <section
      className="snapshot-tools comparison-panel"
      aria-label="Сравнение снимков"
      aria-busy={busy}
    >
      <div className="comparison-actions">
        {!hideCaptureAction && (
          <Button
            variant="default"
            size="sm"
            disabled={busy || !onBaselineChange}
            onClick={() => void changeBaseline(true)}
          >
            <Camera />
            {baseline ? "Заменить базовый снимок" : "Запомнить снимок"}
          </Button>
        )}
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshCw />
            Обновить снимок
          </Button>
        )}
        {baseline && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !onBaselineChange}
            onClick={() => void changeBaseline(false)}
          >
            <RotateCcw />
            Сбросить сравнение
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Не удалось изменить базовый снимок. Повторите попытку.
          </AlertDescription>
        </Alert>
      )}
      {baseline && comparison && (
        <>
          <p className="comparison-baseline">
            Базовый снимок:{" "}
            <time dateTime={new Date(baseline.capturedAt).toISOString()}>
              {new Date(baseline.capturedAt).toLocaleTimeString("ru-RU")}
            </time>
          </p>
          <p className="sr-only" role="status" aria-live="polite">
            Добавлено: {comparison.added.length}. Нет в текущем снимке:{" "}
            {comparison.missing.length}. Изменено: {comparison.changed.length}.
            Без изменений: {comparison.unchanged}.
          </p>
          <div className="comparison-metrics">
            <ComparisonMetric
              label="Добавлено"
              value={comparison.added.length}
              tone="success"
            />
            <ComparisonMetric
              label="Нет в текущем снимке"
              value={comparison.missing.length}
              tone="warning"
            />
            <ComparisonMetric
              label="Изменено"
              value={comparison.changed.length}
              tone="info"
            />
            <ComparisonMetric
              label="Без изменений"
              value={comparison.unchanged}
              tone="neutral"
            />
          </div>
          <p className="scope">Сравниваем все записи независимо от фильтров.</p>
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
