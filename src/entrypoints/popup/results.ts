import type { ListenerRecord } from "../../shared/contracts/records";

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
): ResultsProjection {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const words = normalizedQuery ? normalizedQuery.split(/\s+/) : [];
  const groups = new Map<string, ListenerRecord[]>();
  let matchedCount = 0;

  for (const record of records) {
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
