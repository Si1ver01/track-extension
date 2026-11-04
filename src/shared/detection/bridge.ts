import { normalizeRecord } from "../records/normalize";
import type {
  BridgeRecordMessage,
  ListenerOptions,
  ListenerTarget,
  PageContextKind,
} from "../contracts/records";
import { createListenerKey, ListenerRegistry } from "./registry";
import { installHandlerSurfaces } from "./handler-surfaces";
import { createLogger } from "../logger";
import { createId } from "../id";
import { isSupportedEventType } from "../event-catalog/catalog";
import { ListenerTargets } from "./targets";
import { safeMetadataId } from "../records/sanitize";

const logger = createLogger("detection.bridge");

export function createBridgeMessage(
  eventType: string,
  tabId: number,
  path: string,
  nonce = "",
  lifecycle: "active" | "removed" = "active",
  listenerKey = "",
  listenerOptions: ListenerOptions = {
    capture: false,
    passive: null,
    once: null,
  },
  context: {
    documentId?: string;
    contextKind?: PageContextKind;
    target?: ListenerTarget;
    targetId?: string;
  } = {},
): BridgeRecordMessage | null {
  if (!isSupportedEventType(eventType)) return null;
  return {
    source: "listener-lens",
    nonce,
    type: "listener-record",
    record: normalizeRecord({
      eventType,
      tabId,
      frameId: 0,
      documentId: context.documentId,
      contextKind: context.contextKind,
      browser: "unknown",
      source: { target: context.target ?? "window", path },
      lifecycle,
      listenerKey,
      listenerOptions,
    }),
  };
}

export function installListenerHook(
  tabId = 0,
  nonce = "",
  contextDocumentId = "",
): () => void {
  let active = true;
  const original = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const getRootNode = Node.prototype.getRootNode;
  const addWindowListener = window.addEventListener.bind(window);
  const removeWindowListener = window.removeEventListener.bind(window);
  const registry = new ListenerRegistry();
  const targets = new ListenerTargets();
  const listenerKeys = new WeakMap<object, string>();
  const keyFor = (listener: EventListenerOrEventListenerObject) => {
    if (
      !listener ||
      (typeof listener !== "function" && typeof listener !== "object")
    )
      return "unknown-listener";
    const object = listener as object;
    const known = listenerKeys.get(object);
    if (known) return known;
    const key = createListenerKey(listener);
    listenerKeys.set(object, key);
    return key;
  };
  const optionsFor = (
    options: boolean | AddEventListenerOptions | undefined,
  ) => {
    if (typeof options === "boolean")
      return {
        nativeOptions: options,
        listenerOptions: { capture: options, passive: null, once: null },
        signal: undefined,
      };
    if (options == null)
      return {
        nativeOptions: options,
        listenerOptions: { capture: false, passive: null, once: null },
        signal: undefined,
      };
    const dictionary = Object(options) as AddEventListenerOptions;
    const capture = dictionary.capture;
    const passive = dictionary.passive;
    const once = dictionary.once;
    const signal = dictionary.signal;
    return {
      nativeOptions: { capture, passive, once, signal },
      listenerOptions: {
        capture: Boolean(capture),
        passive: passive ?? null,
        once: once ?? null,
      },
      signal,
    };
  };
  const captureForRemoval = (
    options: boolean | EventListenerOptions | undefined,
  ) => {
    if (typeof options === "boolean")
      return { nativeOptions: options, capture: options };
    if (options == null) return { nativeOptions: options, capture: false };
    const capture = (Object(options) as EventListenerOptions).capture;
    return { nativeOptions: { capture }, capture: Boolean(capture) };
  };
  const targetIds = new WeakMap<object, string>();
  const documentId = contextDocumentId || createId();
  const navigationId = createId();
  const emitNavigation = (navigationKind: "spa" | "full") => {
    if (!active) return;
    window.postMessage(
      {
        source: "listener-lens",
        nonce,
        type: "context-navigation",
        documentId,
        contextKind: "document",
        navigationId,
        navigationKind,
      },
      "*",
    );
    logger.debug("navigation transition observed", {
      navigationKind,
      documentId,
      navigationId,
    });
  };
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    emitNavigation("spa");
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    emitNavigation("spa");
    return result;
  };
  const onPopState = () => emitNavigation("spa");
  window.addEventListener("popstate", onPopState);
  const targetId = (target: EventTarget) => {
    if (
      (typeof target !== "object" && typeof target !== "function") ||
      target === null
    )
      return "target-unknown";
    const object = target as object;
    const existing = targetIds.get(object);
    if (existing) return existing;
    const id = `target-${createId()}`;
    targetIds.set(object, id);
    return id;
  };
  const targetInfo = (
    target: EventTarget,
  ): {
    path: string;
    target: ListenerTarget;
    targetId: string;
    contextKind: PageContextKind;
  } => {
    const id = targetId(target);
    const contextKind =
      target instanceof Node && getRootNode.call(target) instanceof ShadowRoot
        ? "shadow-root"
        : "document";
    if (target === window)
      return { path: "window", target: "window", targetId: id, contextKind };
    if (target === document)
      return {
        path: "document",
        target: "document",
        targetId: id,
        contextKind,
      };
    if (target instanceof Element)
      return {
        path: target.tagName.toLowerCase(),
        target: "element",
        targetId: id,
        contextKind,
      };
    if (typeof ShadowRoot !== "undefined" && target instanceof ShadowRoot)
      return {
        path: "shadow-root",
        target: "element",
        targetId: id,
        contextKind: "shadow-root",
      };
    return { path: "unknown", target: "unknown", targetId: id, contextKind };
  };
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!active) return original.call(this, type, listener, options);
    const eventType = `${type}`;
    const parsedOptions = optionsFor(options);
    const result = original.call(
      this,
      eventType,
      listener,
      parsedOptions.nativeOptions,
    );
    if (listener == null || parsedOptions.signal?.aborted) return result;
    try {
      const listenerKey = keyFor(listener);
      const listenerOptions = parsedOptions.listenerOptions;
      const info = targetInfo(this);
      const message = createBridgeMessage(
        eventType,
        tabId,
        info.path,
        nonce,
        "active",
        listenerKey,
        listenerOptions,
        {
          documentId,
          contextKind: info.contextKind,
          target: info.target,
          targetId: info.targetId,
        },
      );
      if (message) {
        const entry = registry.add(
          {
            eventType,
            targetPath: info.path,
            targetId: info.targetId,
            capture: listenerOptions.capture,
            listenerKey,
          },
          message.record!,
        );
        targets.remember(entry.id, this);
        window.postMessage({ ...message, record: entry }, "*");
      }
    } catch {
      // Сбой сбора метаданных не должен менять результат DOM API.
    }
    return result;
  };
  const surfaces = installHandlerSurfaces((surface) => {
    if (!active) return;
    const info = targetInfo(surface.target);
    const message = createBridgeMessage(
      surface.eventType,
      tabId,
      info.path,
      nonce,
      "active",
      surface.id,
      { capture: false, passive: null, once: null },
      {
        documentId,
        contextKind: info.contextKind,
        target: info.target,
        targetId: info.targetId,
      },
    );
    if (!message) return;
    targets.remember(surface.id, surface.target);
    window.postMessage(
      {
        ...message,
        record: {
          ...message.record!,
          id: surface.id,
          lifecycle: surface.lifecycle,
          source: { ...message.record!.source, sourceKind: surface.sourceKind },
          reasonCodes: surface.limited
            ? ["SURFACE_UNVERIFIED", "RECORD_LIMIT_REACHED"]
            : ["SURFACE_UNVERIFIED"],
        },
      },
      "*",
    );
  });
  EventTarget.prototype.removeEventListener = function (
    type,
    listener,
    options,
  ) {
    if (!active) return originalRemove.call(this, type, listener, options);
    const eventType = `${type}`;
    const parsedOptions = captureForRemoval(options);
    const result = originalRemove.call(
      this,
      eventType,
      listener,
      parsedOptions.nativeOptions,
    );
    if (listener == null) return result;
    try {
      const listenerKey = keyFor(listener);
      const info = targetInfo(this);
      const removed = registry.remove({
        eventType,
        targetPath: info.path,
        targetId: info.targetId,
        capture: parsedOptions.capture,
        listenerKey,
      });
      if (removed)
        window.postMessage(
          {
            source: "listener-lens",
            nonce,
            type: "listener-record",
            record: removed,
          },
          "*",
        );
    } catch {
      // Сбой сбора метаданных не должен менять результат DOM API.
    }
    return result;
  };
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = originalAttachShadow.call(this, init);
    if (active) {
      try {
        surfaces.observeRoot(root);
      } catch {
        logger.warn("shadow observation failed", {
          code: "SHADOW_OBSERVATION_FAILED",
        });
      }
      logger.debug("shadow root observed", {
        mode: init.mode,
        documentId,
        targetId: targetId(root),
      });
    }
    return root;
  };
  const installedAdd = EventTarget.prototype.addEventListener;
  const installedRemove = EventTarget.prototype.removeEventListener;
  const installedShadow = Element.prototype.attachShadow;
  const installedPush = history.pushState;
  const installedReplace = history.replaceState;
  const onReveal: EventListener = (event) => {
    const messageEvent = event as MessageEvent;
    const message = messageEvent.data;
    if (
      !active ||
      messageEvent.source !== window ||
      message?.source !== "listener-lens" ||
      message.type !== "reveal-target" ||
      message.nonce !== nonce ||
      message.documentId !== documentId ||
      !safeMetadataId(message.requestId) ||
      !safeMetadataId(message.recordId)
    )
      return;
    window.postMessage(
      {
        source: "listener-lens",
        type: "target-revealed",
        nonce,
        documentId,
        requestId: message.requestId,
        recordId: message.recordId,
        result: targets.reveal(message.recordId),
      },
      "*",
    );
  };
  const onPageHide = () => targets.hide();
  addWindowListener("message", onReveal);
  addWindowListener("pagehide", onPageHide);
  return () => {
    if (!active) return;
    active = false;
    targets.clear();
    surfaces.dispose();
    if (EventTarget.prototype.addEventListener === installedAdd)
      EventTarget.prototype.addEventListener = original;
    if (EventTarget.prototype.removeEventListener === installedRemove)
      EventTarget.prototype.removeEventListener = originalRemove;
    if (Element.prototype.attachShadow === installedShadow)
      Element.prototype.attachShadow = originalAttachShadow;
    if (history.pushState === installedPush)
      history.pushState = originalPushState;
    if (history.replaceState === installedReplace)
      history.replaceState = originalReplaceState;
    removeWindowListener("popstate", onPopState);
    removeWindowListener("message", onReveal);
    removeWindowListener("pagehide", onPageHide);
  };
}
