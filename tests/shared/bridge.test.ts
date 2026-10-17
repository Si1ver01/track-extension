import { describe, expect, it, vi } from "vitest";
import {
  createBridgeMessage,
  installListenerHook,
} from "../../src/shared/detection/bridge";
import { initializeBridgeHandshake } from "../../src/shared/detection/handshake";

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

  it("ignores unsupported events", () => {
    expect(
      createBridgeMessage("custom-event", 0, "window", "nonce-1"),
    ).toBeNull();
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
