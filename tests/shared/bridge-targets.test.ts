import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installListenerHook } from "../../src/shared/detection/bridge";
import type { BridgeRecordMessage } from "../../src/shared/contracts/records";

const originalScroll = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);
const scroll = vi.fn();
let dispose: (() => void) | undefined;
beforeEach(() => {
  scroll.mockClear();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(1, 2, 30, 40),
  );
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalScroll)
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
function reveal(recordId: string, overrides: Record<string, unknown> = {}) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: {
        source: "listener-lens",
        nonce: "nonce",
        documentId: "document",
        type: "reveal-target",
        recordId,
        requestId: "request-one",
        ...overrides,
      },
    }),
  );
}

describe("Подсветка через установленный hook", () => {
  it("связывает окончательный record ID с точным target и сохраняет цель после removeEventListener", () => {
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    dispose = installListenerHook(0, "nonce", "document");
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    const handler = vi.fn();
    first.addEventListener("pointerdown", handler);
    second.addEventListener("pointerdown", handler);
    const records = post.mock.calls
      .map(([message]) => message as BridgeRecordMessage)
      .flatMap((message) =>
        message.type === "listener-record" &&
        message.record?.eventType === "pointerdown"
          ? [message.record]
          : [],
      );
    expect(records).toHaveLength(2);
    expect(records[0]!.id).not.toBe(records[1]!.id);
    second.removeEventListener("pointerdown", handler);
    reveal(records[1]!.id, { nonce: "wrong" });
    reveal(records[1]!.id, { documentId: "old" });
    expect(scroll).not.toHaveBeenCalled();
    reveal(records[1]!.id);
    expect(scroll.mock.contexts[0]).toBe(second);
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "target-revealed",
        result: { status: "REVEALED" },
      }),
      "*",
    );
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    expect(document.querySelector("[data-listener-lens-highlight]")).toBeNull();
    second.remove();
    reveal(records[1]!.id);
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: { status: "TARGET_UNAVAILABLE" } }),
      "*",
    );
    dispose();
    const calls = post.mock.calls.length;
    reveal(records[0]!.id);
    expect(post.mock.calls.length).toBe(calls);
  });

  it("запоминает property и inline targets внутри закрытого Shadow DOM", async () => {
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    dispose = installListenerHook(0, "nonce", "document");
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    const element = document.createElement("button");
    root.append(element);
    element.onclick = () => {};
    element.setAttribute("onkeydown", "void 0");
    await Promise.resolve();
    await Promise.resolve();
    for (const sourceKind of ["event-handler-property", "inline-attribute"]) {
      const record = post.mock.calls
        .map(([message]) => message as BridgeRecordMessage)
        .find(
          (message) => message.record?.source.sourceKind === sourceKind,
        )!.record!;
      reveal(record.id);
      expect(scroll.mock.contexts.at(-1)).toBe(element);
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({ result: { status: "REVEALED" } }),
        "*",
      );
    }
    dispose();
    expect(document.querySelector("[data-listener-lens-highlight]")).toBeNull();
  });
});
