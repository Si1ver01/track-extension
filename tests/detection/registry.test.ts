import { describe, expect, it } from "vitest";
import { ListenerRegistry } from "../../src/shared/detection/registry";
import { normalizeRecord } from "../../src/shared/records/normalize";

const record = () =>
  normalizeRecord({
    eventType: "click",
    tabId: 1,
    frameId: 0,
    browser: "chrome",
    source: { target: "element", path: "button" },
  });

describe("ListenerRegistry", () => {
  it("deduplicates active registrations and removes matching capture identity", () => {
    const registry = new ListenerRegistry();
    const identity = {
      eventType: "click",
      targetPath: "button",
      capture: false,
      listenerKey: "handler",
    };

    expect(registry.add(identity, record()).lifecycle).toBe("active");
    expect(registry.add(identity, record()).id).toBe(registry.list()[0]?.id);
    expect(registry.remove(identity)?.lifecycle).toBe("removed");
    expect(registry.list()).toHaveLength(0);
    expect(registry.list("removed")).toHaveLength(1);
  });

  it("keeps capture true and false registrations separate", () => {
    const registry = new ListenerRegistry();
    const base = {
      eventType: "click",
      targetPath: "button",
      listenerKey: "handler",
    };

    registry.add({ ...base, capture: false }, record());
    registry.add({ ...base, capture: true }, record());

    expect(registry.list()).toHaveLength(2);
  });

  it("retains original options for an ordinary duplicate", () => {
    const registry = new ListenerRegistry();
    const identity = {
      eventType: "click",
      targetPath: "button",
      capture: false,
      listenerKey: "handler",
    };
    const first = registry.add(identity, {
      ...record(),
      listenerOptions: { capture: false, passive: true, once: false },
    });
    const duplicate = registry.add(identity, {
      ...record(),
      listenerOptions: { capture: false, passive: false, once: true },
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.listenerOptions).toEqual(first.listenerOptions);
  });

  it("removes an uncertain once slot and creates a new generation on readd", () => {
    const registry = new ListenerRegistry();
    const identity = {
      eventType: "click",
      targetPath: "button",
      capture: false,
      listenerKey: "handler",
    };
    const first = registry.add(identity, {
      ...record(),
      lifecycle: "unknown",
      listenerOptions: { capture: false, passive: true, once: true },
    });
    expect(first.lifecycle).toBe("unknown");
    const ambiguous = registry.add(identity, record());
    expect(ambiguous.id).toBe(first.id);
    expect(ambiguous.lifecycle).toBe("unknown");
    expect(ambiguous.listenerOptions).toEqual({
      capture: false,
      passive: null,
      once: null,
    });
    expect(registry.remove(identity)).toMatchObject({
      id: first.id,
      lifecycle: "removed",
    });
    const readded = registry.add(identity, record());
    expect(readded.id).not.toBe(first.id);
    expect(readded.lifecycle).toBe("active");
  });

  it("does not remove a newer generation and does not track overflow", () => {
    const registry = new ListenerRegistry(1);
    const identity = {
      eventType: "click",
      targetPath: "button",
      capture: false,
      listenerKey: "handler",
    };
    const first = registry.register(identity, record());
    expect(first.change).toBe("new");
    expect(registry.remove(identity)).toMatchObject({ lifecycle: "removed" });
    const second = registry.register(identity, record());
    expect(second.generation).not.toBe(first.generation);
    expect(registry.remove(identity, first.generation!)).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
    const overflow = registry.register(
      { ...identity, capture: true },
      record(),
    );
    expect(overflow.change).toBe("limited");
    expect(overflow.generation).toBeNull();
    expect(overflow.entry.reasonCodes).toContain("RECORD_LIMIT_REACHED");
    expect(registry.list("unknown")).toHaveLength(0);
  });
});
