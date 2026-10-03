import type { ListenerRecord, TabState } from '../shared/contracts/records';
import { createLogger } from '../shared/logger';

const logger = createLogger('background.tab-state');
const maxRecords = 200;
const states = new Map<number, TabState>();

export function getTabState(tabId: number): TabState { return states.get(tabId) ?? { tabId, records: [], status: 'ready' }; }
export function addRecord(record: ListenerRecord): TabState {
  const state = getTabState(record.tabId);
  const identity = record.listenerKey ?? record.id;
  const existingIndex = state.records.findIndex((entry) => (entry.listenerKey ?? entry.id) === identity && entry.eventType === record.eventType && entry.source.path === record.source.path);
  if (existingIndex >= 0) state.records = state.records.map((entry, index) => index === existingIndex ? record : entry);
  else state.records = [...state.records, record].slice(-maxRecords);
  state.status = state.records.length >= maxRecords ? 'limited' : 'ready';
  states.set(record.tabId, state);
  logger.debug('record added', { tabId: record.tabId, count: state.records.length });
  return state;
}
export function resetTabState(tabId: number): void { states.delete(tabId); logger.debug('tab state reset', { tabId }); }
