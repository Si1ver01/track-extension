import { createLogger } from '../shared/logger';
import browser from 'webextension-polyfill';
import { injectScript } from '#imports';
import type { BridgeHandshake, BridgeRecordMessage } from '../shared/contracts/records';

export default defineContentScript({ matches: ['<all_urls>'], runAt: 'document_start', main() {
  const logger = createLogger('content');
  const nonce = crypto.randomUUID();
  logger.debug('content script initialized', { runAt: 'document_start' });
  injectScript('/entrypoints/bridge.js').catch((error) => logger.warn('[FIX] page bridge injection failed', { error: String(error) }));
  window.addEventListener('message', (event) => {
    const message = event.data as Partial<BridgeRecordMessage>;
    if (event.source !== window || message.source !== 'listener-lens' || message.nonce !== nonce) return;
    logger.debug('bridge message forwarded', { type: message.type });
    browser.runtime.sendMessage(message).catch((error) => logger.warn('[FIX] bridge delivery failed', { error: String(error) }));
  });
  const handshake: BridgeHandshake = { source: 'listener-lens', type: 'install-bridge', nonce };
  window.postMessage(handshake, '*');
} });
