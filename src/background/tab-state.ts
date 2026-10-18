import type {
  ListenerRecord,
  PageContextKind,
  TabState,
} from "../shared/contracts/records";
import { createLogger } from "../shared/logger";
import { MAX_COLLECTOR_RECORDS } from "../shared/contracts/collector";

const logger = createLogger("background.tab-state");
export const MAX_TAB_RECORDS = MAX_COLLECTOR_RECORDS;
const states = new Map<number, TabState>();

export function getTabState(tabId: number): TabState {
  return states.get(tabId) ?? { tabId, records: [], status: "scanning" };
}
export function addRecord(record: ListenerRecord): TabState {
  const state = getTabState(record.tabId);
  const identity = [
    record.tabId,
    record.frameId,
    record.documentId,
    record.source.path,
    record.listenerKey ?? record.id,
    record.eventType,
  ].join("|");
  const existingIndex = state.records.findIndex(
    (entry) =>
      [
        entry.tabId,
        entry.frameId,
        entry.documentId,
        entry.source.path,
        entry.listenerKey ?? entry.id,
        entry.eventType,
      ].join("|") === identity,
  );
  if (
    (existingIndex < 0 && state.records.length >= MAX_TAB_RECORDS) ||
    record.reasonCodes.includes("RECORD_LIMIT_REACHED")
  )
    state.recordLimitReached = true;
  if (existingIndex >= 0)
    state.records = state.records.map((entry, index) =>
      index === existingIndex ? record : entry,
    );
  else state.records = [...state.records, record].slice(-MAX_TAB_RECORDS);
  state.status = state.recordLimitReached ? "limited" : "ready";
  states.set(record.tabId, state);
  logger.debug("record added", {
    tabId: record.tabId,
    frameId: record.frameId,
    documentId: record.documentId,
    count: state.records.length,
    recordLimitReached: Boolean(state.recordLimitReached),
  });
  return state;
}
export function updateContext(
  tabId: number,
  context: {
    documentId: string;
    frameId: number;
    contextKind: PageContextKind;
    navigationId?: string;
  },
): TabState {
  const state = getTabState(tabId);
  state.contexts ??= {};
  state.contexts = { ...state.contexts, [context.documentId]: context };
  states.set(tabId, state);
  return state;
}
export function resetContext(tabId: number, documentId: string): TabState {
  const state = getTabState(tabId);
  state.records = state.records.filter(
    (record) => record.documentId !== documentId,
  );
  if (state.contexts) delete state.contexts[documentId];
  states.set(tabId, state);
  logger.info("context state reset", { tabId, documentId });
  return state;
}
export function restoreContext(
  tabId: number,
  documentId: string,
  records: ListenerRecord[],
  recordLimitReached: boolean,
): void {
  resetContext(tabId, documentId);
  if (recordLimitReached) {
    const state = getTabState(tabId);
    state.recordLimitReached = true;
    states.set(tabId, state);
  }
  records.forEach(addRecord);
  logger.debug("context snapshot restored", {
    tabId,
    documentId,
    count: records.length,
    recordLimitReached,
  });
}
export function resetTabState(tabId: number): void {
  states.delete(tabId);
  logger.info("tab state reset", { tabId });
}
