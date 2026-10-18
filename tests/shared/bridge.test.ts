import { describe, expect, it, vi } from "vitest";
import {
  createBridgeMessage,
  installListenerHook,
} from "../../src/shared/detection/bridge";
import { initializeBridgeHandshake } from "../../src/shared/detection/handshake";
import { SUPPORTED_EVENT_TYPES } from "../../src/shared/event-catalog/catalog";
import type { BridgeRecordMessage } from "../../src/shared/contracts/records";

describe("bridge messages", () => {
  it("disposes its own patches idempotently", () => {
    const add = EventTarget.prototype.addEventListener;
    const push = history.pushState;
    const dispose = installListenerHook(0, "test", "document-test");
    expect(EventTarget.prototype.addEventListener).not.toBe(add);
    dispose();
    dispose();
    expect(EventTarget.prototype.addEventListener).toBe(add);
    expect(history.pushState).toBe(push);
  });
  it("preserves a later page patch while disabling its retained wrapper", () => {
    const original = EventTarget.prototype.addEventListener;
    const dispose = installListenerHook(0, "test", "document-test");
    const installed = EventTarget.prototype.addEventListener;
    const foreign: typeof original = function (
      this: EventTarget,
      type,
      listener,
      options,
    ) {
      return installed.call(this, type, listener, options);
    };
    const post = vi.spyOn(window, "postMessage");
    try {
      EventTarget.prototype.addEventListener = foreign;
      dispose();
      expect(EventTarget.prototype.addEventListener).toBe(foreign);
      const count = post.mock.calls.length;
      new EventTarget().addEventListener("click", () => undefined);
      expect(post).toHaveBeenCalledTimes(count);
    } finally {
      dispose();
      EventTarget.prototype.addEventListener = original;
      post.mockRestore();
    }
  });
  it("includes the handshake nonce and metadata context", () => {
    const message = createBridgeMessage("click", 0, "button", "nonce-1");
    expect(message).toMatchObject({
      source: "listener-lens",
      nonce: "nonce-1",
      type: "listener-record",
    });
    expect(message?.record?.frameId).toBe(0);
    expect(message?.record?.documentId).toBe("legacy-document");
    expect(message?.record?.contextKind).toBe("document");
  });

  it.each(SUPPORTED_EVENT_TYPES)(
    "создаёт metadata для события каталога %s",
    (eventType) => {
      const message = createBridgeMessage(
        eventType,
        7,
        "button",
        "nonce-1",
        "removed",
        "listener-1",
        { capture: true, passive: false, once: null },
        { documentId: "document-1", target: "element" },
      );

      expect(message).toMatchObject({
        source: "listener-lens",
        nonce: "nonce-1",
        type: "listener-record",
        record: {
          eventType,
          tabId: 7,
          documentId: "document-1",
          lifecycle: "removed",
          listenerKey: "listener-1",
          listenerOptions: { capture: true, passive: false, once: null },
          source: { target: "element", path: "button" },
        },
      });
      expect(message?.record?.description).toContain(eventType);
      expect(message?.record?.description).not.toContain("пока не описано");
      expect(message?.record).not.toHaveProperty("payload");
      expect(message?.record?.source).not.toHaveProperty("callbackBody");
    },
  );

  it.each([
    "custom-event",
    "__proto__",
    "constructor",
    "toString",
    "unknown",
    "CLICK",
    "PointerDown",
    " click ",
    "",
  ])("отклоняет тип вне каталога с точным регистром: %j", (eventType) => {
    expect(createBridgeMessage(eventType, 0, "window", "nonce-1")).toBeNull();
  });

  it("фиксирует добавление и удаление новых семейств без изменения регистрации", () => {
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    const dispose = installListenerHook(7, "nonce-1", "document-1");
    const target = document.createElement("button");
    const listener = vi.fn();
    const uppercaseListener = vi.fn();
    const events = [
      "pointerdown",
      "focus",
      "beforeinput",
      "wheel",
      "mousedown",
    ];

    try {
      for (const eventType of events) {
        target.addEventListener(eventType, listener);
        target.removeEventListener(eventType, listener);
      }
      target.addEventListener("PointerDown", uppercaseListener);
      target.dispatchEvent(new Event("PointerDown"));
      target.removeEventListener("PointerDown", uppercaseListener);

      const records = post.mock.calls
        .map(([message]) => message as BridgeRecordMessage)
        .filter((message) => message.type === "listener-record")
        .map((message) => message.record);

      expect(records).toHaveLength(events.length * 2);
      for (const [index, eventType] of events.entries()) {
        expect(records[index * 2]).toMatchObject({
          eventType,
          lifecycle: "active",
          documentId: "document-1",
          source: { target: "element", path: "button" },
        });
        expect(records[index * 2 + 1]).toMatchObject({
          eventType,
          lifecycle: "removed",
          listenerKey: records[index * 2]?.listenerKey,
        });
      }
      expect(uppercaseListener).toHaveBeenCalledOnce();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      dispose();
      post.mockRestore();
    }
  });

  it("posts the handshake only after bridge injection completes", async () => {
    let completeInjection!: () => void;
    const injectBridge = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeInjection = resolve;
        }),
    );
    const postHandshake = vi.fn();

    const initialization = initializeBridgeHandshake(
      "nonce-1",
      injectBridge,
      postHandshake,
    );
    expect(postHandshake).not.toHaveBeenCalled();

    completeInjection();
    await initialization;

    expect(postHandshake).toHaveBeenCalledWith(
      { source: "listener-lens", type: "install-bridge", nonce: "nonce-1" },
      "*",
    );
  });

  it("does not post the handshake when bridge injection fails", async () => {
    const postHandshake = vi.fn();

    await expect(
      initializeBridgeHandshake(
        "nonce-1",
        () => Promise.reject(new Error("injection failed")),
        postHandshake,
      ),
    ).rejects.toThrow("injection failed");
    expect(postHandshake).not.toHaveBeenCalled();
  });
});
