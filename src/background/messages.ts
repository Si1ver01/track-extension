import { addRecord, getTabState } from './tab-state';
import { isListenerMessage, type TabState } from '../shared/contracts/records';
import { createLogger } from '../shared/logger';

const logger = createLogger('background');

interface RuntimeSender {
  tab?: { id?: number };
  frameId?: number;
}

export async function handleRuntimeMessage(
  message: unknown,
  sender: RuntimeSender,
): Promise<TabState | undefined> {
  if (!isListenerMessage(message)) {
    logger.warn('unknown message schema');
    return undefined;
  }

  logger.debug('message received', { type: message.type, tabId: message.tabId });
  if (message.type === 'listener-record' && message.record) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      logger.warn('[FIX] listener record has no sender tab');
      return undefined;
    }
    return addRecord({ ...message.record, tabId, frameId: sender.frameId ?? 0 });
  }

  if (message.type === 'get-tab-state' && message.tabId !== undefined) {
    const state = getTabState(message.tabId);
    logger.debug('[FIX] tab state response ready', { tabId: state.tabId, recordCount: state.records.length });
    return state;
  }

  logger.warn('unknown message schema', { type: message.type });
  return undefined;
}
