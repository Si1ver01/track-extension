import { describe, expect, it } from "vitest";
import {
  describeHandlerSurface,
  scanInlineSurface,
} from "../../src/shared/detection/surfaces";
import { SUPPORTED_EVENT_TYPES } from "../../src/shared/event-catalog/catalog";

describe("handler surfaces", () => {
  it("classifies property handlers without exposing handler source", () => {
    const element = document.createElement("button");
    const surface = describeHandlerSurface(
      "onclick",
      element,
      "event-handler-property",
    );
    expect(surface).toMatchObject({
      eventType: "click",
      sourceKind: "event-handler-property",
      reasonCodes: ["SURFACE_UNVERIFIED"],
    });
  });

  it("reports only supported inline attributes", () => {
    const element = document.createElement("button");
    element.setAttribute("onclick", "secretValue()");
    element.setAttribute("onunknown", "secretValue()");
    const surfaces = scanInlineSurface(element);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).not.toHaveProperty("value");
  });

  it.each(SUPPORTED_EVENT_TYPES)(
    "описывает surface события %s из общего каталога",
    (eventType) => {
      const element = document.createElement("button");
      const surface = describeHandlerSurface(
        `on${eventType}`,
        element,
        "event-handler-property",
      );

      expect(surface).toEqual({
        eventType,
        target: "element",
        path: "button",
        sourceKind: "event-handler-property",
        reasonCodes: ["SURFACE_UNVERIFIED"],
      });
    },
  );

  it("сканирует новые inline surfaces без чтения кода обработчиков", () => {
    const element = document.createElement("input");
    const events = ["pointerdown", "focus", "beforeinput", "scroll"];
    for (const eventType of [
      ...events,
      "custom-event",
      "__proto__",
      "constructor",
    ]) {
      element.setAttribute(`on${eventType}`, "privateHandlerSource()");
    }
    for (const attribute of element.attributes) {
      Object.defineProperty(attribute, "value", {
        get() {
          throw new Error("Код обработчика нельзя читать");
        },
      });
    }

    const surfaces = scanInlineSurface(element);

    expect(surfaces.map((surface) => surface.eventType)).toEqual(events);
    for (const surface of surfaces) {
      expect(surface).toMatchObject({
        target: "element",
        path: "input",
        sourceKind: "inline-attribute",
        reasonCodes: ["SURFACE_UNVERIFIED"],
      });
      expect(surface).not.toHaveProperty("value");
      expect(surface).not.toHaveProperty("callbackBody");
    }
    expect(JSON.stringify(surfaces)).not.toContain("privateHandlerSource");
  });

  it.each(["oncustom-event", "on__proto__", "onconstructor", "ontostring"])(
    "не принимает неподдерживаемый handler surface %s",
    (name) => {
      expect(
        describeHandlerSurface(name, document, "inline-attribute"),
      ).toBeNull();
    },
  );
});
