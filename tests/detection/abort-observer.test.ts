// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { AbortObserver } from "../../src/shared/detection/abort-observer";

function fixture(maxBindings = 2000) {
  const add = vi.fn(AbortSignal.prototype.addEventListener);
  const remove = vi.fn(AbortSignal.prototype.removeEventListener);
  const getter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  )!.get!;
  const observer = new AbortObserver(
    add,
    remove,
    (signal) => getter.call(signal) as boolean,
    maxBindings,
  );
  return { add, remove, observer };
}

describe("наблюдение AbortSignal", () => {
  it("игнорирует синтетический abort и очищается после настоящей отмены", () => {
    const { observer, remove } = fixture();
    const controller = new AbortController();
    const aborted = vi.fn();
    expect(
      observer.observe("slot", 1, controller.signal, aborted, vi.fn()),
    ).toBe(true);
    controller.signal.dispatchEvent(new Event("abort"));
    expect(aborted).not.toHaveBeenCalled();
    expect(observer.count).toBe(1);
    controller.abort();
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(observer.count).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("защищает новое поколение и ограничивает подписки", () => {
    const { observer, add } = fixture(1);
    const first = new AbortController();
    const second = new AbortController();
    const aborted = vi.fn();
    observer.observe("slot", 1, first.signal, aborted, vi.fn());
    observer.observe("slot", 2, second.signal, aborted, vi.fn());
    observer.forget("slot", 1);
    first.abort();
    expect(aborted).not.toHaveBeenCalled();
    expect(observer.count).toBe(1);
    expect(
      observer.observe("overflow", 3, first.signal, aborted, vi.fn()),
    ).toBe(false);
    expect(add).toHaveBeenCalledTimes(2);
    second.abort();
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(observer.count).toBe(0);
  });

  it("очищает shared signal идемпотентно и не удаляет обработчики страницы", () => {
    const { observer } = fixture();
    const controller = new AbortController();
    const page = vi.fn();
    const aborted = vi.fn();
    controller.signal.addEventListener("abort", page);
    observer.observe("a", 1, controller.signal, aborted, vi.fn());
    observer.observe("b", 2, controller.signal, aborted, vi.fn());
    expect(observer.count).toBe(2);
    observer.dispose();
    observer.dispose();
    controller.abort();
    expect(observer.count).toBe(0);
    expect(aborted).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalledTimes(1);
    expect(observer.observe("c", 3, controller.signal, aborted, vi.fn())).toBe(
      false,
    );
  });

  it("изолирует ошибки установки, чтения состояния и доставки", () => {
    const controller = new AbortController();
    const remove = vi.fn(AbortSignal.prototype.removeEventListener);
    const failingAdd = vi.fn(() => {
      throw new Error("observer unavailable");
    });
    const failed = new AbortObserver(failingAdd, remove, () => false);
    expect(failed.observe("a", 1, controller.signal, vi.fn(), vi.fn())).toBe(
      false,
    );
    expect(failed.count).toBe(0);
    const getter = vi.fn(() => false);
    const uncertain = vi.fn();
    const observer = new AbortObserver(
      AbortSignal.prototype.addEventListener,
      remove,
      getter,
    );
    observer.observe("a", 2, controller.signal, vi.fn(), uncertain);
    getter.mockImplementation(() => {
      throw new Error("state unavailable");
    });
    expect(() => controller.abort()).not.toThrow();
    expect(uncertain).toHaveBeenCalledTimes(1);
    expect(observer.count).toBe(0);
  });
});
