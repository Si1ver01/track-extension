import type {
  ListenerLifecycle,
  ListenerRecord,
  ListenerSourceKind,
} from "../../shared/contracts/records";

export interface ResultFilters {
  lifecycle: ListenerLifecycle | "all";
  sourceKind: ListenerSourceKind | "unknown" | "all";
  frameId: number | "all";
}

export const DEFAULT_RESULT_FILTERS: Readonly<ResultFilters> = Object.freeze({
  lifecycle: "all",
  sourceKind: "all",
  frameId: "all",
});

export function getResultFrameIds(
  records: readonly ListenerRecord[],
): number[] {
  return [...new Set(records.map((record) => record.frameId))].sort(
    (left, right) => left - right,
  );
}

export interface ResultGroup {
  eventType: string;
  records: ListenerRecord[];
}

export interface ResultsProjection {
  groups: ResultGroup[];
  totalCount: number;
  matchedCount: number;
}

export function projectResults(
  records: readonly ListenerRecord[],
  query: string,
  filters: Readonly<ResultFilters> = DEFAULT_RESULT_FILTERS,
): ResultsProjection {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const words = normalizedQuery ? normalizedQuery.split(/\s+/) : [];
  const groups = new Map<string, ListenerRecord[]>();
  let matchedCount = 0;

  for (const record of records) {
    if (filters.lifecycle !== "all" && record.lifecycle !== filters.lifecycle)
      continue;
    if (
      filters.sourceKind !== "all" &&
      (record.source.sourceKind ?? "unknown") !== filters.sourceKind
    )
      continue;
    if (filters.frameId !== "all" && record.frameId !== filters.frameId)
      continue;

    if (words.length > 0) {
      const metadata = [
        record.eventType,
        record.description,
        record.source.path,
        record.source.target,
        record.source.sourceKind ?? "",
        String(record.frameId),
        record.documentId,
        record.contextKind,
        record.lifecycle,
      ]
        .join(" ")
        .toLocaleLowerCase();

      if (!words.every((word) => metadata.includes(word))) continue;
    }

    const group = groups.get(record.eventType);
    if (group) group.push(record);
    else groups.set(record.eventType, [record]);
    matchedCount += 1;
  }

  return {
    groups: [...groups.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([eventType, groupedRecords]) => ({
        eventType,
        records: groupedRecords,
      })),
    totalCount: records.length,
    matchedCount,
  };
}
