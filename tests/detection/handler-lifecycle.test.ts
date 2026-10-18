import { describe, expect, it, vi } from "vitest";
import { installListenerHook } from "../../src/shared/detection/bridge";
import type { BridgeRecordMessage } from "../../src/shared/contracts/records";

function capture() {
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const dispose = installListenerHook(7, "surface-test", "surface-document");
  const records = () =>
    post.mock.calls
      .map(([message]) => message as BridgeRecordMessage)
      .filter((message) => message.type === "listener-record")
      .flatMap((message) => (message.record ? [message.record] : []));
  return {
    post,
    records,
    dispose,
    close() {
      dispose();
      post.mockRestore();
    },
  };
}

async function flushMutations() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("жизненный цикл property и inline поверхностей", () => {
  it("сохраняет нативные handlers HTMLElement, SVG, document и window", () => {
    const probe = capture();
    const button = document.createElement("button");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const handler = vi.fn(function (this: EventTarget) {
      return this;
    });
    try {
      button.onclick = handler;
      svg.onclick = handler;
      document.onkeydown = handler;
      window.onwheel = handler;
      expect(button.onclick).toBe(handler);
      expect(svg.onclick).toBe(handler);
      expect(document.onkeydown).toBe(handler);
      expect(window.onwheel).toBe(handler);
      button.dispatchEvent(new Event("click"));
      svg.dispatchEvent(new Event("click"));
      document.dispatchEvent(new Event("keydown"));
      window.dispatchEvent(new Event("wheel"));
      expect(handler).toHaveBeenCalledTimes(4);
      expect(handler.mock.contexts.slice(0, 3)).toEqual([
        button,
        svg,
        document,
      ]);
      expect((handler.mock.contexts[3] as Window).document === document).toBe(
        true,
      );
      const records = probe
        .records()
        .filter(
          (record) => record.source.sourceKind === "event-handler-property",
        );
      expect(records).toHaveLength(4);
      expect(records.map((record) => record.source.target)).toEqual([
        "element",
        "element",
        "document",
        "window",
      ]);
      for (const record of records) {
        expect(record.documentId).toBe("surface-document");
        expect(record.reasonCodes).toContain("SURFACE_UNVERIFIED");
      }
    } finally {
      document.onkeydown = null;
      window.onwheel = null;
      probe.close();
    }
  });

  it("обновляет один property slot при замене, null и повторном добавлении", () => {
    const probe = capture();
    const button = document.createElement("button");
    const first = vi.fn();
    const second = vi.fn();
    try {
      button.onclick = first;
      button.onclick = first;
      button.onclick = second;
      button.dispatchEvent(new Event("click"));
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
      button.onclick = null;
      button.onclick = second;
      const records = probe.records();
      expect(records.map((record) => record.lifecycle)).toEqual([
        "active",
        "active",
        "removed",
        "active",
      ]);
      expect(new Set(records.map((record) => record.id)).size).toBe(1);
      expect(new Set(records.map((record) => record.listenerKey)).size).toBe(1);
    } finally {
      probe.close();
    }
  });

  it("сохраняет нативное преобразование примитивного значения в null", () => {
    const probe = capture();
    const button = document.createElement("button");
    try {
      button.onclick = () => undefined;
      Reflect.set(button, "onclick", 7);
      expect(button.onclick).toBeNull();
      expect(probe.records().map((record) => record.lifecycle)).toEqual([
        "active",
        "removed",
      ]);
    } finally {
      probe.close();
    }
  });

  it("сохраняет return false и window forwarding для body.onload", () => {
    const probe = capture();
    const button = document.createElement("button");
    const load = vi.fn();
    const originalLoad = window.onload;
    try {
      button.onclick = () => false;
      expect(
        button.dispatchEvent(new Event("click", { cancelable: true })),
      ).toBe(false);
      document.body.onload = load;
      expect(window.onload).toBe(load);
      window.dispatchEvent(new Event("load"));
      expect(load).toHaveBeenCalledOnce();
      expect(
        probe.records().filter((record) => record.eventType === "load"),
      ).toHaveLength(1);
    } finally {
      window.onload = originalLoad;
      probe.close();
    }
  });

  it("не смешивает одинаковые targets и не читает callback source", () => {
    const probe = capture();
    const one = document.createElement("button");
    const two = document.createElement("button");
    const handler = () => "callback-secret-must-not-leak";
    const source = vi
      .spyOn(handler as unknown as { toString(): string }, "toString")
      .mockImplementation(() => {
        throw new Error("callback source read");
      });
    try {
      one.onclick = handler;
      two.onclick = handler;
      one.addEventListener("pointerdown", handler);
      two.addEventListener("pointerdown", handler);
      expect(
        new Set(probe.records().map((record) => record.listenerKey)).size,
      ).toBe(4);
      expect(source).not.toHaveBeenCalled();
      expect(JSON.stringify(probe.records())).not.toContain("callback-secret");
    } finally {
      probe.close();
      source.mockRestore();
    }
  });

  it("собирает начальные inline имена без чтения значений атрибутов", () => {
    document.body.innerHTML =
      '<button onclick="inline-secret-one()"></button><button onclick="inline-secret-two()"></button>';
    const value = vi.spyOn(Attr.prototype, "value", "get");
    const probe = capture();
    try {
      const records = probe
        .records()
        .filter((record) => record.source.sourceKind === "inline-attribute");
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.listenerKey)).size).toBe(2);
      expect(
        records.every((record) => record.documentId === "surface-document"),
      ).toBe(true);
      expect(value).not.toHaveBeenCalled();
      expect(JSON.stringify(records)).not.toContain("inline-secret");
    } finally {
      probe.close();
      value.mockRestore();
      document.body.replaceChildren();
    }
  });

  it("наблюдает parser-подобные вставки и повторные изменения inline", async () => {
    const probe = capture();
    const container = document.createElement("section");
    document.body.append(container);
    try {
      container.innerHTML = '<button onclick="first-secret()"></button>';
      await flushMutations();
      const button = container.querySelector("button")!;
      button.setAttribute("onclick", "second-secret()");
      await flushMutations();
      button.setAttribute("onkeydown", "third-secret()");
      await flushMutations();
      button.removeAttribute("onclick");
      await flushMutations();
      button.setAttribute("onclick", "fourth-secret()");
      await flushMutations();
      const clicks = probe
        .records()
        .filter((record) => record.eventType === "click");
      expect(clicks.map((record) => record.lifecycle)).toEqual([
        "active",
        "active",
        "removed",
        "active",
      ]);
      expect(new Set(clicks.map((record) => record.id)).size).toBe(1);
      expect(
        probe.records().some((record) => record.eventType === "keydown"),
      ).toBe(true);
      expect(JSON.stringify(probe.records())).not.toContain("secret");
    } finally {
      probe.close();
      container.remove();
    }
  });

  it("видит Attr и toggleAttribute и не принимает события вне каталога", async () => {
    const probe = capture();
    const button = document.createElement("button");
    document.body.append(button);
    try {
      const attribute = document.createAttribute("onfocus");
      attribute.value = "private-handler()";
      button.setAttributeNode(attribute);
      button.setAttribute("oncustom-event", "private-handler()");
      await flushMutations();
      button.toggleAttribute("onfocus", false);
      await flushMutations();
      button.toggleAttribute("onfocus", true);
      await flushMutations();
      expect(
        probe.records().map((record) => [record.eventType, record.lifecycle]),
      ).toEqual([
        ["focus", "active"],
        ["focus", "removed"],
        ["focus", "active"],
      ]);
    } finally {
      probe.close();
      button.remove();
    }
  });

  it("классифицирует root и потомков новых open и closed Shadow DOM", async () => {
    const probe = capture();
    const hosts: Element[] = [];
    try {
      for (const mode of ["open", "closed"] as const) {
        const host = document.createElement("div");
        hosts.push(host);
        document.body.append(host);
        const root = host.attachShadow({ mode });
        root.addEventListener("copy", () => undefined);
        const button = document.createElement("button");
        root.append(button);
        button.onclick = () => undefined;
        button.setAttribute("onfocus", "shadow-secret()");
      }
      await flushMutations();
      const records = probe.records();
      expect(
        records.filter((record) => record.eventType === "copy"),
      ).toHaveLength(2);
      expect(
        records.filter((record) => record.eventType === "click"),
      ).toHaveLength(2);
      expect(
        records.filter((record) => record.eventType === "focus"),
      ).toHaveLength(2);
      expect(
        records.every((record) => record.contextKind === "shadow-root"),
      ).toBe(true);
    } finally {
      probe.close();
      hosts.forEach((host) => host.remove());
    }
  });

  it("сканирует доступный open root, существовавший до hook", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<button onclick="existing-secret()"></button>';
    document.body.append(host);
    const probe = capture();
    try {
      expect(probe.records()).toEqual([
        expect.objectContaining({
          eventType: "click",
          contextKind: "shadow-root",
        }),
      ]);
    } finally {
      probe.close();
      host.remove();
    }
  });

  it("сохраняет поздний setter страницы и отключает retained wrapper", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "onclick",
    )!;
    const probe = capture();
    const installed = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "onclick",
    )!;
    const foreignSet = function (this: HTMLElement, value: unknown) {
      installed.set!.call(this, value);
    };
    const button = document.createElement("button");
    document.body.append(button);
    try {
      Object.defineProperty(HTMLElement.prototype, "onclick", {
        ...installed,
        set: foreignSet,
      });
      button.setAttribute("onfocus", "queued-secret()");
      probe.dispose();
      probe.dispose();
      const count = probe.records().length;
      button.onclick = () => undefined;
      await flushMutations();
      expect(
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onclick")?.set,
      ).toBe(foreignSet);
      expect(probe.records()).toHaveLength(count);
    } finally {
      probe.close();
      Object.defineProperty(HTMLElement.prototype, "onclick", descriptor);
      button.remove();
    }
  });

  it("ошибка доставки метаданных не ломает успешный нативный setter", () => {
    const probe = capture();
    const button = document.createElement("button");
    const handler = vi.fn();
    try {
      probe.post.mockImplementation(() => {
        throw new Error("metadata unavailable");
      });
      expect(() => {
        button.onclick = handler;
      }).not.toThrow();
      expect(button.onclick).toBe(handler);
      button.dispatchEvent(new Event("click"));
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      probe.close();
    }
  });
});
