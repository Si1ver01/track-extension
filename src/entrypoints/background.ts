import browser from 'webextension-polyfill';
import { addRecord, getTabState, resetTabState } from '../background/tab-state';
import { isListenerMessage } from '../shared/contracts/records';
import { createLogger } from '../shared/logger';

const logger = createLogger('background');

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isListenerMessage(message)) {
      logger.warn('unknown message schema');
      return undefined;
    }
    logger.debug('message received', { type: message.type, tabId: message.tabId });
    const input = message;
    if (input.type === 'listener-record' && input.record) {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        logger.warn('[FIX] listener record has no sender tab');
        return undefined;
      }
      return addRecord({ ...input.record, tabId, frameId: sender.frameId ?? 0 });
    }
    if (input.type === 'get-tab-state' && input.tabId !== undefined) return getTabState(input.tabId);
    logger.warn('unknown message schema', { type: input.type });
    return undefined;
  });
  browser.tabs.onRemoved.addListener(resetTabState);
});
