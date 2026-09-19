import browser from 'webextension-polyfill';
import { resetTabState } from '../background/tab-state';
import { handleRuntimeMessage } from '../background/messages';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(handleRuntimeMessage);
  browser.tabs.onRemoved.addListener(resetTabState);
});
