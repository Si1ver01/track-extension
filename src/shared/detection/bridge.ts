import { normalizeRecord } from "../records/normalize";
import type { BridgeRecordMessage, ListenerOptions } from "../contracts/records";
import { createListenerKey, ListenerRegistry } from "./registry";
import { scanInlineSurface } from "./surfaces";

const supported = new Set(["click", "copy", "cut", "paste", "input", "change", "submit", "load", "error", "keydown", "keyup"]);

export function createBridgeMessage(
  eventType: string,
  tabId: number,
  path: string,
  nonce = "",
  lifecycle: "active" | "removed" = "active",
  listenerKey = "",
  listenerOptions: ListenerOptions = { capture: false, passive: null, once: null },
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
      lifecycle,
      listenerKey,
      listenerOptions,
    }),
  };
}

export function installListenerHook(tabId = 0, nonce = ""): () => void {
  const original = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const registry = new ListenerRegistry();
  const listenerKeys = new WeakMap<object, string>();
  const keyFor = (listener: EventListenerOrEventListenerObject) => {
    if (!listener || (typeof listener !== "function" && typeof listener !== "object")) return "unknown-listener";
    const object = listener as object;
    const known = listenerKeys.get(object);
    if (known) return known;
    const key = createListenerKey(listener);
    listenerKeys.set(object, key);
    return key;
  };
  const optionsFor = (options: boolean | AddEventListenerOptions | undefined) => {
    if (typeof options === "boolean") return { capture: options, passive: null, once: null };
    return { capture: options?.capture ?? false, passive: options?.passive ?? null, once: options?.once ?? null };
  };
  const targetPath = (target: EventTarget) => target instanceof Element ? target.tagName.toLowerCase() : target === document ? "document" : "window";
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const eventType = String(type);
    const listenerKey = keyFor(listener ?? (() => undefined));
    const listenerOptions = optionsFor(options);
    const path = targetPath(this);
    const message = createBridgeMessage(
      eventType,
      tabId,
      path,
      nonce,
      "active",
      listenerKey,
      listenerOptions,
    );
    if (message) {
      const entry = registry.add({ eventType, targetPath: path, capture: listenerOptions.capture, listenerKey }, message.record!);
      window.postMessage({ ...message, record: entry }, "*");
    }
    return original.call(this, type, listener, options);
  };
  const scannedElements = new WeakSet<Element>();
  const scanElement = (element: Element) => {
    if (scannedElements.has(element)) return;
    scannedElements.add(element);
    for (const surface of scanInlineSurface(element)) {
      const message = createBridgeMessage(surface.eventType, tabId, surface.path, nonce, 'active', '', { capture: false, passive: null, once: null });
      if (message) window.postMessage({ ...message, record: { ...message.record!, source: { ...message.record!.source, sourceKind: surface.sourceKind }, reasonCodes: surface.reasonCodes } }, '*');
    }
  };
  const originalSetAttribute = Element.prototype.setAttribute;
  const handlerDescriptors = new Map<string, PropertyDescriptor>();
  const handlerEvents = ["click", "copy", "cut", "paste", "input", "change", "submit", "load", "error", "keydown", "keyup"];
  const emitSurface = (target: EventTarget, eventType: string, sourceKind: "event-handler-property" | "inline-attribute") => {
    const path = targetPath(target);
    const message = createBridgeMessage(eventType, tabId, path, nonce, "active", `surface-${eventType}-${path}`, { capture: false, passive: null, once: null });
    if (!message) return;
    window.postMessage({ ...message, record: { ...message.record!, source: { ...message.record!.source, sourceKind }, reasonCodes: ["SURFACE_UNVERIFIED"] } }, "*");
  };
  for (const eventType of handlerEvents) {
    const property = `on${eventType}`;
    const descriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, property);
    if (!descriptor?.set || !descriptor.get) continue;
    handlerDescriptors.set(property, descriptor);
    Object.defineProperty(EventTarget.prototype, property, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value: EventListener | null) {
        descriptor.set!.call(this, value);
        if (value !== null) emitSurface(this, eventType, "event-handler-property");
      },
    });
  }
  Element.prototype.setAttribute = function (name, value) {
    const result = originalSetAttribute.call(this, name, value);
    if (name.toLowerCase().startsWith('on')) scanElement(this);
    return result;
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const eventType = String(type);
    const listenerKey = keyFor(listener ?? (() => undefined));
    const listenerOptions = optionsFor(options);
    const path = targetPath(this);
    const removed = registry.remove({ eventType, targetPath: path, capture: listenerOptions.capture, listenerKey });
    if (removed) window.postMessage({ source: "listener-lens", nonce, type: "listener-record", record: removed }, "*");
    return originalRemove.call(this, type, listener, options);
  };
  return () => {
    EventTarget.prototype.addEventListener = original;
    EventTarget.prototype.removeEventListener = originalRemove;
    Element.prototype.setAttribute = originalSetAttribute;
    for (const [property, descriptor] of handlerDescriptors) Object.defineProperty(EventTarget.prototype, property, descriptor);
  };
}
