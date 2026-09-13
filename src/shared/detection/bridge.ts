import { normalizeRecord } from '../records/normalize';
import type { ListenerMessage } from '../contracts/records';

const supported = new Set(['click', 'copy', 'cut', 'paste', 'input']);

export function createBridgeMessage(eventType: string, tabId: number, path: string): ListenerMessage | null {
  if (!supported.has(eventType)) return null;
  return { type: 'listener-record', record: normalizeRecord({ eventType, tabId, frameId: 0, browser: 'unknown', source: { target: 'window', path } }) };
}

export function installListenerHook(tabId: number): () => void {
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const message = createBridgeMessage(String(type), tabId, this instanceof Element ? this.tagName.toLowerCase() : 'window');
    if (message) window.postMessage({ source: 'listener-lens', ...message }, '*');
    return original.call(this, type, listener, options);
  };
  return () => { EventTarget.prototype.addEventListener = original; };
}
