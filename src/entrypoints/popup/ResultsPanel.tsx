import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ListenerRecord } from "../../shared/contracts/records";
import { createLogger } from "../../shared/logger";
import { projectResults } from "./results";

const logger = createLogger("popup.results");

function optionValue(value: boolean | null | undefined) {
  return value == null ? "Неизвестно" : String(value);
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function RecordDetails({ record }: { record: ListenerRecord }) {
  const lifecycle = {
    active: "Активен (active)",
    removed: "Удалён (removed)",
    unknown: "Неизвестно (unknown)",
  }[record.lifecycle];

  return (
    <details className="listener-record">
      <summary>
        <strong className="record-event">{record.eventType}</strong>
        <span className="record-context">
          {record.source.path} · frame {record.frameId} · document{" "}
          {record.documentId}
        </span>
        <span className="record-description">{record.description}</span>
        <span className="record-lifecycle">{lifecycle}</span>
      </summary>
      <dl className="record-metadata">
        <MetadataRow label="Цель (target)">{record.source.target}</MetadataRow>
        <MetadataRow label="Путь (path)">{record.source.path}</MetadataRow>
        <MetadataRow label="Источник (sourceKind)">
          {record.source.sourceKind ?? "Неизвестно"}
        </MetadataRow>
        <MetadataRow label="Расположение скрипта (scriptLocation)">
          {record.source.scriptLocation ?? "Неизвестно"}
        </MetadataRow>
        <MetadataRow label="Фрейм (frameId)">{record.frameId}</MetadataRow>
        <MetadataRow label="Документ (documentId)">
          {record.documentId}
        </MetadataRow>
        <MetadataRow label="Контекст (contextKind)">
          {record.contextKind}
        </MetadataRow>
        <MetadataRow label="capture">
          {optionValue(record.listenerOptions?.capture)}
        </MetadataRow>
        <MetadataRow label="passive">
          {optionValue(record.listenerOptions?.passive)}
        </MetadataRow>
        <MetadataRow label="once">
          {optionValue(record.listenerOptions?.once)}
        </MetadataRow>
        <MetadataRow label="Состояние (lifecycle)">{lifecycle}</MetadataRow>
        <MetadataRow label="Навигация (navigationKind)">
          {record.navigationKind ?? "Неизвестно"}
        </MetadataRow>
        <MetadataRow label="Идентификатор навигации (navigationId)">
          {record.navigationId ?? "Неизвестно"}
        </MetadataRow>
        {record.source.options && record.source.options.length > 0 && (
          <MetadataRow label="Параметры источника (source.options)">
            <ul className="record-values">
              {record.source.options.map((option, index) => (
                <li key={index}>{option}</li>
              ))}
            </ul>
          </MetadataRow>
        )}
        {record.reasonCodes.length > 0 && (
          <MetadataRow label="Причины ограничений (reasonCodes)">
            <ul className="record-values">
              {record.reasonCodes.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </MetadataRow>
        )}
        {record.limitations.length > 0 && (
          <MetadataRow label="Ограничения (limitations)">
            <ul className="record-values">
              {record.limitations.map((limitation, index) => (
                <li key={index}>{limitation}</li>
              ))}
            </ul>
          </MetadataRow>
        )}
        <MetadataRow label="Идентификатор записи (id)">{record.id}</MetadataRow>
        <MetadataRow label="Вкладка (tabId)">{record.tabId}</MetadataRow>
        <MetadataRow label="Браузер (browser)">{record.browser}</MetadataRow>
        <MetadataRow label="Время захвата (capturedAt)">
          {record.capturedAt}
        </MetadataRow>
        {record.listenerKey !== undefined && (
          <MetadataRow label="Идентификатор обработчика (listenerKey)">
            {record.listenerKey}
          </MetadataRow>
        )}
      </dl>
    </details>
  );
}

export function ResultsPanel({
  records,
  partial,
}: {
  records: ListenerRecord[];
  partial: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () => projectResults(records, query),
    [records, query],
  );

  useEffect(() => {
    logger.debug("Обновлены результаты", {
      totalCount: results.totalCount,
      matchedCount: results.matchedCount,
      groupCount: results.groups.length,
    });
  }, [results]);

  return (
    <section className="results-panel" aria-labelledby={titleId}>
      <h2 id={titleId}>Полученные записи</h2>
      <div className="results-search">
        <label htmlFor={searchId}>Поиск по метаданным</label>
        <input
          id={searchId}
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.length > 0 && (
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            Сбросить поиск
          </button>
        )}
      </div>
      <p className="results-count" aria-live="polite" aria-atomic="true">
        Показано записей: {results.matchedCount} из {results.totalCount}.
      </p>
      {results.totalCount === 0 ? (
        <p>
          {partial
            ? "Пока нет данных об обработчиках."
            : "Обработчики событий не найдены."}
        </p>
      ) : results.matchedCount === 0 ? (
        <p>По запросу ничего не найдено.</p>
      ) : (
        results.groups.map((group) => (
          <section className="results-group" key={group.eventType}>
            <h3>
              {group.eventType} · {group.records.length}
            </h3>
            {group.records.map((record) => (
              <RecordDetails
                key={JSON.stringify([
                  record.frameId,
                  record.documentId,
                  record.contextKind,
                  record.id,
                ])}
                record={record}
              />
            ))}
          </section>
        ))
      )}
    </section>
  );
}
