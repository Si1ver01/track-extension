import { describe, expect, it } from "vitest";
import {
  describeEvent,
  EVENT_CATALOG,
  isSupportedEventType,
  SUPPORTED_EVENT_TYPES,
} from "../../src/shared/event-catalog/catalog";

const expectedEventTypes = [
  "click",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseenter",
  "mouseleave",
  "mouseover",
  "mouseout",
  "dblclick",
  "contextmenu",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "pointerenter",
  "pointerleave",
  "pointerover",
  "pointerout",
  "keydown",
  "keyup",
  "focus",
  "blur",
  "focusin",
  "focusout",
  "beforeinput",
  "input",
  "change",
  "submit",
  "reset",
  "invalid",
  "copy",
  "cut",
  "paste",
  "wheel",
  "scroll",
  "load",
  "error",
];
const fallbackDescription =
  "Назначение этого типа события пока не описано в локальном справочнике.";

describe("Локальный каталог событий", () => {
  it("содержит ровно 37 согласованных типов без пропусков и повторов", () => {
    expect(expectedEventTypes).toHaveLength(37);
    expect(SUPPORTED_EVENT_TYPES).toHaveLength(37);
    expect(new Set(SUPPORTED_EVENT_TYPES).size).toBe(37);
    expect([...SUPPORTED_EVENT_TYPES].sort()).toEqual(
      [...expectedEventTypes].sort(),
    );
    expect(Object.keys(EVENT_CATALOG).sort()).toEqual(
      [...expectedEventTypes].sort(),
    );
  });

  it.each(expectedEventTypes)(
    "описывает назначение %s непустым русским текстом",
    (eventType) => {
      expect(isSupportedEventType(eventType)).toBe(true);
      const description = describeEvent(eventType);
      expect(description.trim()).toBe(description);
      expect(description).toMatch(/[А-Яа-яЁё]/);
      expect(description).toContain(eventType);
      expect(description).not.toBe(fallbackDescription);
      expect(description).not.toMatch(/callback|обработчик/i);
    },
  );

  it.each([
    "unknown",
    "custom-event",
    "",
    "CLICK",
    "Click",
    " click",
    "click ",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
  ])(
    "возвращает fallback для неподдерживаемого точного имени %j",
    (eventType) => {
      expect(isSupportedEventType(eventType)).toBe(false);
      expect(describeEvent(eventType)).toBe(fallbackDescription);
    },
  );

  it("сохраняет назначение пяти ранее описанных событий", () => {
    expect(describeEvent("click")).toBe(
      "События click связаны с нажатием на элемент страницы.",
    );
    expect(describeEvent("copy")).toBe(
      "События copy связаны с копированием текста или другого содержимого.",
    );
    expect(describeEvent("cut")).toBe(
      "События cut связаны с вырезанием содержимого.",
    );
    expect(describeEvent("paste")).toBe(
      "События paste связаны со вставкой содержимого.",
    );
    expect(describeEvent("input")).toBe(
      "События input связаны с изменением значения поля или другого редактируемого элемента.",
    );
  });

  it("защищает каталог и список типов от изменений во время выполнения", () => {
    const originalClick = describeEvent("click");
    const originalFirst = SUPPORTED_EVENT_TYPES[0];
    expect(Object.isFrozen(EVENT_CATALOG)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_EVENT_TYPES)).toBe(true);
    expect(Reflect.set(EVENT_CATALOG, "click", "Подмена")).toBe(false);
    expect(Reflect.set(EVENT_CATALOG, "custom-event", "Подмена")).toBe(false);
    expect(Reflect.deleteProperty(EVENT_CATALOG, "click")).toBe(false);
    expect(Reflect.set(SUPPORTED_EVENT_TYPES, 0, "custom-event")).toBe(false);
    expect(Reflect.set(SUPPORTED_EVENT_TYPES, 37, "custom-event")).toBe(false);
    expect(describeEvent("click")).toBe(originalClick);
    expect(isSupportedEventType("custom-event")).toBe(false);
    expect(SUPPORTED_EVENT_TYPES[0]).toBe(originalFirst);
    expect(SUPPORTED_EVENT_TYPES).toHaveLength(37);
  });
});
