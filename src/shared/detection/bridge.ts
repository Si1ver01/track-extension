import { normalizeRecord } from "../records/normalize";
import type { BridgeRecordMessage } from "../contracts/records";

const supported = new Set(["click", "copy", "cut", "paste", "input"]);

export function createBridgeMessage(
  eventType: string,
  tabId: number,
  path: string,
  nonce = "",
): BridgeRecordMessage | null {
  if (!supported.has(eventType)) return null;
  return {
    source: "listener-lens",
    nonce,
    type: "listener-record",
    record: normalizeRecord({
      eventType,
      tabId,
      frameId: 0,
      browser: "unknown",
      source: { target: "window", path },
    }),
  };
}

export function installListenerHook(tabId = 0, nonce = ""): () => void {
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const message = createBridgeMessage(
      String(type),
      tabId,
      this instanceof Element ? this.tagName.toLowerCase() : "window",
      nonce,
    );
    if (message) window.postMessage(message, "*");
    return original.call(this, type, listener, options);
  };
  return () => {
    EventTarget.prototype.addEventListener = original;
  };
}
