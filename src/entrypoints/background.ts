import browser from 'webextension-polyfill';
import { addRecord, getTabState, resetTabState } from '../background/tab-state';
import { isListenerMessage } from '../shared/contracts/records';
import { createLogger } from '../shared/logger';

const logger = createLogger('background');

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isListenerMessage(message)) {
      logger.warn('unknown message schema');
      return undefined;
    }
    logger.debug('message received', { type: message.type, tabId: message.tabId });
    const input = message;
    if (input.type === 'listener-record' && input.record) return addRecord(input.record);
    if (input.type === 'get-tab-state' && input.tabId !== undefined) return getTabState(input.tabId);
    logger.warn('unknown message schema', { type: input.type });
    return undefined;
  });
  browser.tabs.onRemoved.addListener(resetTabState);
});
