import { createLogger } from '../logger';
import { describeEvent } from '../event-catalog/catalog';
import type { ListenerOptions, ListenerRecord, SourceMetadata } from '../contracts/records';

const logger = createLogger('records.normalize');

export function normalizeRecord(input: Omit<ListenerRecord, 'description' | 'id' | 'capturedAt' | 'limitations' | 'lifecycle' | 'reasonCodes'> & { id?: string; capturedAt?: number; limitations?: string[]; lifecycle?: ListenerRecord['lifecycle']; reasonCodes?: ListenerRecord['reasonCodes']; listenerOptions?: ListenerOptions }): ListenerRecord {
  const record: ListenerRecord = {
    id: input.id ?? crypto.randomUUID(),
    eventType: input.eventType || 'unknown',
    description: describeEvent(input.eventType || 'unknown'),
    tabId: input.tabId,
    frameId: input.frameId ?? 0,
    source: sanitizeSource(input.source),
    browser: input.browser ?? 'unknown',
    capturedAt: input.capturedAt ?? Date.now(),
    limitations: input.limitations ?? [],
    lifecycle: input.lifecycle ?? 'active',
    reasonCodes: input.reasonCodes ?? [],
    listenerKey: input.listenerKey,
    listenerOptions: input.listenerOptions,
  };
  logger.debug('record normalized', { eventType: record.eventType, tabId: record.tabId, frameId: record.frameId });
  return record;
}

function sanitizeSource(source: SourceMetadata): SourceMetadata {
  const safe = { target: source.target ?? 'unknown', path: source.path || 'unknown', options: source.options, scriptLocation: source.scriptLocation };
  for (const forbidden of ['value', 'payload', 'data', 'callbackBody']) {
    if (forbidden in source) logger.warn('forbidden field discarded', { field: forbidden });
  }
  return safe;
}
