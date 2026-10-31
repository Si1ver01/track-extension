import type { ListenerRecord } from "../../shared/contracts/records";
import { createLogger } from "../../shared/logger";

export { copySnapshotRecords } from "../../shared/records/snapshot";

const logger = createLogger("popup.comparison");

export function recordIdentity(record: ListenerRecord) {
  return JSON.stringify([
    record.frameId,
    record.documentId,
    record.contextKind,
    record.id,
  ]);
}

const fields = {
  eventType: (record: ListenerRecord) => record.eventType,
  lifecycle: (record: ListenerRecord) => record.lifecycle,
  "source.target": (record: ListenerRecord) => record.source.target,
  "source.path": (record: ListenerRecord) => record.source.path,
  "source.sourceKind": (record: ListenerRecord) =>
    record.source.sourceKind ?? "unknown",
  capture: (record: ListenerRecord) =>
    String(record.listenerOptions?.capture ?? "unknown"),
  passive: (record: ListenerRecord) =>
    String(record.listenerOptions?.passive ?? "unknown"),
  once: (record: ListenerRecord) =>
    String(record.listenerOptions?.once ?? "unknown"),
  reasonCodes: (record: ListenerRecord) =>
    [...record.reasonCodes].sort().join(", "),
};

export interface RecordChange {
  before: ListenerRecord;
  after: ListenerRecord;
  fields: { name: string; before: string; after: string }[];
}

export function compareSnapshots(
  before: readonly ListenerRecord[],
  after: readonly ListenerRecord[],
) {
  const previous = new Map(
    before.map((record) => [recordIdentity(record), record]),
  );
  const current = new Map(
    after.map((record) => [recordIdentity(record), record]),
  );
  const added: ListenerRecord[] = [];
  const missing: ListenerRecord[] = [];
  const changed: RecordChange[] = [];
  let unchanged = 0;
  for (const record of after) {
    const old = previous.get(recordIdentity(record));
    if (!old) {
      added.push(record);
      continue;
    }
    const changes = Object.entries(fields).flatMap(([name, value]) => {
      const before = value(old);
      const after = value(record);
      return before === after ? [] : [{ name, before, after }];
    });
    if (changes.length)
      changed.push({ before: old, after: record, fields: changes });
    else unchanged += 1;
  }
  for (const record of before) {
    if (!current.has(recordIdentity(record))) missing.push(record);
  }
  logger.debug("Снимки сравнены", {
    added: added.length,
    missing: missing.length,
    changed: changed.length,
    unchanged,
  });
  return { added, missing, changed, unchanged };
}
