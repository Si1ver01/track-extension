import browser from 'webextension-polyfill';
import { addRecord, getTabState, resetTabState } from '../background/tab-state';
import type { ListenerMessage } from '../shared/contracts/records';
import { createLogger } from '../shared/logger';

const logger = createLogger('background');

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const input = message as ListenerMessage;
    logger.debug('message received', { type: input.type, tabId: input.tabId });
    if (input.type === 'listener-record' && input.record) return addRecord(input.record);
    if (input.type === 'get-tab-state' && input.tabId !== undefined) return getTabState(input.tabId);
    logger.warn('unknown message schema', { type: input.type });
    return undefined;
  });
  browser.tabs.onRemoved.addListener(resetTabState);
});
