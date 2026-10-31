import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ListenerRecord } from "../../shared/contracts/records";
import type { SiteCoverage } from "../../shared/contracts/site-access";
import { createLogger } from "../../shared/logger";
import { SnapshotExport } from "./SnapshotExport";
import { SnapshotComparison } from "./SnapshotComparison";
import { RevealTarget, type RevealAction } from "./RevealTarget";
import {
  DEFAULT_RESULT_FILTERS,
  getResultFrameIds,
  projectResults,
  type ResultFilters,
} from "./results";

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

function RecordDetails({
  record,
  onReveal,
}: {
  record: ListenerRecord;
  onReveal?: RevealAction;
}) {
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
      <RevealTarget record={record} onReveal={onReveal} />
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
  coverage,
  documentId,
  onRefresh,
  onReveal,
}: {
  records: ListenerRecord[];
  partial: boolean;
  coverage?: SiteCoverage;
  documentId?: string;
  onRefresh?: () => void;
  onReveal?: RevealAction;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ResultFilters>(DEFAULT_RESULT_FILTERS);
  const searchId = useId();
  const titleId = useId();
  const lifecycleId = useId();
  const sourceKindId = useId();
  const frameId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const frameIds = useMemo(() => getResultFrameIds(records), [records]);
  const activeFilterCount =
    Number(filters.lifecycle !== "all") +
    Number(filters.sourceKind !== "all") +
    Number(filters.frameId !== "all");
  const results = useMemo(
    () => projectResults(records, query, filters),
    [records, query, filters],
  );

  useEffect(() => {
    logger.debug("Обновлены результаты", {
      totalCount: results.totalCount,
      matchedCount: results.matchedCount,
      groupCount: results.groups.length,
      activeFilterCount,
    });
  }, [results, activeFilterCount]);

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
      <fieldset className="results-filters">
        <legend>Фильтры записей</legend>
        <div className="result-filter">
          <label htmlFor={lifecycleId}>Состояние обработчика</label>
          <select
            id={lifecycleId}
            value={filters.lifecycle}
            onChange={(event) =>
              setFilters({
                ...filters,
                lifecycle: event.target.value as ResultFilters["lifecycle"],
              })
            }
          >
            <option value="all">Все состояния</option>
            <option value="active">Активен (active)</option>
            <option value="removed">Удалён (removed)</option>
            <option value="unknown">Неизвестно (unknown)</option>
          </select>
        </div>
        <div className="result-filter">
          <label htmlFor={sourceKindId}>Источник регистрации</label>
          <select
            id={sourceKindId}
            value={filters.sourceKind}
            onChange={(event) =>
              setFilters({
                ...filters,
                sourceKind: event.target.value as ResultFilters["sourceKind"],
              })
            }
          >
            <option value="all">Все источники</option>
            <option value="add-event-listener">addEventListener</option>
            <option value="event-handler-property">Свойство on…</option>
            <option value="inline-attribute">Inline-атрибут</option>
            <option value="unknown">Неизвестно</option>
          </select>
        </div>
        <div className="result-filter">
          <label htmlFor={frameId}>Фрейм</label>
          <select
            id={frameId}
            value={filters.frameId}
            onChange={(event) =>
              setFilters({
                ...filters,
                frameId:
                  event.target.value === "all"
                    ? "all"
                    : Number(event.target.value),
              })
            }
          >
            <option value="all">Все фреймы</option>
            {frameIds.map((id) => (
              <option key={id} value={id}>
                {id === 0 ? "Главный фрейм (0)" : `Фрейм ${id}`}
              </option>
            ))}
            {filters.frameId !== "all" &&
              !frameIds.includes(filters.frameId) && (
                <option value={filters.frameId}>
                  Фрейм {filters.frameId} (нет записей)
                </option>
              )}
          </select>
        </div>
        {activeFilterCount > 0 && (
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setFilters(DEFAULT_RESULT_FILTERS);
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            Сбросить фильтры
          </button>
        )}
      </fieldset>
      <p className="results-count" aria-live="polite" aria-atomic="true">
        Показано записей: {results.matchedCount} из {results.totalCount}.
      </p>
      <SnapshotExport
        records={records}
        visibleRecords={results.groups.flatMap((group) => group.records)}
        context={{ partial, coverage, documentId }}
      />
      <SnapshotComparison
        records={records}
        context={{ partial, coverage, documentId }}
        onRefresh={onRefresh}
      />
      {results.totalCount === 0 ? (
        <p>
          {partial
            ? "Пока нет данных об обработчиках."
            : "Обработчики событий не найдены."}
        </p>
      ) : results.matchedCount === 0 ? (
        <p>
          {activeFilterCount > 0
            ? "По выбранным фильтрам ничего не найдено. Измените фильтры или сбросьте их."
            : "По запросу ничего не найдено."}
        </p>
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
                onReveal={onReveal}
              />
            ))}
          </section>
        ))
      )}
    </section>
  );
}
