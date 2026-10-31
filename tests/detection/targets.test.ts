import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ListenerTargets,
  MAX_REVEAL_TARGETS,
} from "../../src/shared/detection/targets";

const originalScroll = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);
let targets: ListenerTargets;
const scroll = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  scroll.mockClear();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 20, 100, 40),
  );
  targets = new ListenerTargets();
});
afterEach(() => {
  targets.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalScroll)
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("Привязка записи к цели", () => {
  it("показывает точный элемент среди одинаковых тегов и убирает подсветку по таймеру", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    targets.remember("first", first);
    targets.remember("second", second);
    const selector = vi.spyOn(document, "querySelector");
    expect(targets.reveal("second")).toEqual({ status: "REVEALED" });
    expect(scroll.mock.contexts[0]).toBe(second);
    expect(selector).not.toHaveBeenCalled();
    expect(
      document
        .querySelector("[data-listener-lens-highlight]")
        ?.getAttribute("style"),
    ).toContain("pointer-events: none");
    expect(first.getAttribute("style")).toBeNull();
    expect(second.getAttribute("style")).toBeNull();
    targets.reveal("first");
    expect(
      document.querySelectorAll("[data-listener-lens-highlight]"),
    ).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(document.querySelector("[data-listener-lens-highlight]")).toBeNull();
  });

  it("не подменяет исчезнувшую или скрытую цель другим элементом", () => {
    const node = document.createElement("button");
    targets.remember("old", node);
    document.body.append(document.createElement("button"));
    expect(targets.reveal("old")).toEqual({ status: "TARGET_UNAVAILABLE" });
    expect(scroll).not.toHaveBeenCalled();
    document.body.append(node);
    vi.mocked(node.getBoundingClientRect).mockReturnValue(new DOMRect());
    expect(targets.reveal("old").status).toBe("TARGET_UNAVAILABLE");
    expect(targets.reveal("missing").status).toBe("TARGET_UNAVAILABLE");
  });

  it("поддерживает закрытый Shadow DOM и отдельно обозначает host ShadowRoot", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    root.append(button);
    document.body.append(host);
    targets.remember("inside", button);
    targets.remember("root", root);
    expect(targets.reveal("inside").status).toBe("REVEALED");
    expect(scroll.mock.contexts[0]).toBe(button);
    expect(targets.reveal("root").status).toBe("SHADOW_HOST");
    expect(scroll.mock.contexts[1]).toBe(host);
    targets.hide();
    expect(document.querySelector("[data-listener-lens-highlight]")).toBeNull();
    expect(targets.reveal("inside").status).toBe("REVEALED");
    targets.clear();
    expect(targets.reveal("inside").status).toBe("TARGET_UNAVAILABLE");
  });

  it("ограничивает реестр и отклоняет узел другого документа", () => {
    const node = document.createElement("button");
    document.body.append(node);
    for (let index = 0; index <= MAX_REVEAL_TARGETS; index++)
      targets.remember(String(index), node);
    expect(targets.reveal("0").status).toBe("TARGET_UNAVAILABLE");
    expect(targets.reveal(String(MAX_REVEAL_TARGETS)).status).toBe("REVEALED");
    const other = document.implementation.createHTMLDocument();
    other.body.append(other.adoptNode(node));
    expect(targets.reveal(String(MAX_REVEAL_TARGETS)).status).toBe(
      "TARGET_UNAVAILABLE",
    );
  });
});
