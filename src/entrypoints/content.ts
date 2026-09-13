import { createLogger } from '../shared/logger';
import { installListenerHook } from './bridge';
import browser from 'webextension-polyfill';

export default defineContentScript({ matches: ['<all_urls>'], runAt: 'document_start', main() {
  const logger = createLogger('content');
  logger.debug('content script initialized', { runAt: 'document_start' });
  installListenerHook(-1);
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'listener-lens') return;
    logger.debug('bridge message forwarded', { type: event.data.type });
    browser.runtime.sendMessage(event.data).catch((error) => logger.warn('bridge delivery failed', { error: String(error) }));
  });
  window.postMessage({ source: 'listener-lens', type: 'install-bridge' }, '*');
} });
