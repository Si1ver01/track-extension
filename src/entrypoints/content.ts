import { createLogger } from '../shared/logger';
import browser from 'webextension-polyfill';
import { injectScript } from '#imports';

export default defineContentScript({ matches: ['<all_urls>'], runAt: 'document_start', main() {
  const logger = createLogger('content');
  logger.debug('content script initialized', { runAt: 'document_start' });
  injectScript('/entrypoints/bridge.js').catch((error) => logger.warn('[FIX] page bridge injection failed', { error: String(error) }));
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'listener-lens') return;
    logger.debug('bridge message forwarded', { type: event.data.type });
    browser.runtime.sendMessage(event.data).catch((error) => logger.warn('[FIX] bridge delivery failed', { error: String(error) }));
  });
  window.postMessage({ source: 'listener-lens', type: 'install-bridge' }, '*');
} });
