import type {
  ListenerLifecycle,
  ListenerSourceKind,
} from "../contracts/records";
import {
  SUPPORTED_EVENT_TYPES,
  isSupportedEventType,
} from "../event-catalog/catalog";
import { createId } from "../id";
import { createLogger } from "../logger";

const logger = createLogger("detection.surfaces");
const maxSlots = 2000;
type SurfaceKind = Exclude<ListenerSourceKind, "add-event-listener">;

export interface HandlerSurface {
  target: EventTarget;
  eventType: string;
  sourceKind: SurfaceKind;
  lifecycle: ListenerLifecycle;
  id: string;
  limited: boolean;
}

interface Slot {
  id: string;
  present: boolean;
  handler?: unknown;
}

interface PropertyPatch {
  owner: object;
  property: string;
  original: PropertyDescriptor;
  installed: PropertyDescriptor;
}

function descriptorOwners(): Set<object> {
  const owners = new Set<object>();
  const seeds: object[] = [window, document];
  const globals = window as unknown as Record<
    string,
    { prototype?: object } | undefined
  >;
  for (const name of [
    "HTMLElement",
    "SVGElement",
    "MathMLElement",
    "HTMLBodyElement",
    "HTMLFrameSetElement",
  ]) {
    const prototype = globals[name]?.prototype;
    if (prototype) seeds.push(prototype);
  }
  for (const seed of seeds) {
    for (
      let owner: object | null = seed;
      owner && owner !== Object.prototype;
      owner = Object.getPrototypeOf(owner)
    ) {
      owners.add(owner);
    }
  }
  return owners;
}

export function installHandlerSurfaces(
  emit: (surface: HandlerSurface) => void,
) {
  let active = true;
  let slotCount = 0;
  const states = new WeakMap<EventTarget, Map<string, Slot>>();
  const observed = new WeakSet<Node>();
  const patches: PropertyPatch[] = [];
  const getAttributeNames = Element.prototype.getAttributeNames;
  const hasAttribute = Element.prototype.hasAttribute;

  const report = (
    target: EventTarget,
    eventType: string,
    sourceKind: SurfaceKind,
    present: boolean,
    handler?: unknown,
    changed = false,
    batch?: Set<string>,
  ) => {
    if (!active) return;
    let slots = states.get(target);
    const key = `${sourceKind}:${eventType}`;
    let slot = slots?.get(key);
    if (!slot && !present) return;
    if (slot && batch?.has(slot.id)) return;
    if (
      slot &&
      slot.present === present &&
      !changed &&
      slot.handler === handler
    )
      return;
    const limited = !slot && slotCount >= maxSlots;
    if (!slot) {
      slot = { id: `surface-${createId()}`, present };
      if (!limited) {
        slots ??= new Map();
        slots.set(key, slot);
        states.set(target, slots);
        slotCount += 1;
      }
    }
    slot.present = present;
    slot.handler = handler;
    batch?.add(slot.id);
    try {
      emit({
        target,
        eventType,
        sourceKind,
        lifecycle: limited ? "unknown" : present ? "active" : "removed",
        id: slot.id,
        limited,
      });
    } catch {
      logger.warn("surface delivery failed", {
        code: "SURFACE_DELIVERY_FAILED",
      });
    }
    logger.debug("handler surface updated", {
      sourceKind,
      lifecycle: present ? "active" : "removed",
      limited,
    });
  };

  const scanElement = (element: Element, batch?: Set<string>) => {
    for (const name of getAttributeNames.call(element)) {
      if (name.startsWith("on") && isSupportedEventType(name.slice(2))) {
        report(
          element,
          name.slice(2),
          "inline-attribute",
          true,
          undefined,
          false,
          batch,
        );
      }
    }
    if (element.shadowRoot) observeRoot(element.shadowRoot, batch);
  };

  const scanTree = (root: Node, batch?: Set<string>) => {
    if (root instanceof Element) scanElement(root, batch);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) scanElement(walker.currentNode as Element, batch);
  };

  const observer = new MutationObserver((mutations) => {
    if (!active) return;
    const batch = new Set<string>();
    try {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) scanTree(node, batch);
        } else if (
          mutation.target instanceof Element &&
          mutation.attributeName
        ) {
          const eventType = mutation.attributeName.slice(2);
          if (isSupportedEventType(eventType)) {
            report(
              mutation.target,
              eventType,
              "inline-attribute",
              hasAttribute.call(mutation.target, mutation.attributeName),
              undefined,
              true,
              batch,
            );
          }
        }
      }
    } catch {
      logger.warn("surface observation failed", {
        code: "SURFACE_OBSERVATION_FAILED",
      });
    }
  });

  function observeRoot(root: Document | ShadowRoot, batch?: Set<string>) {
    if (!active || observed.has(root)) return;
    observed.add(root);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: SUPPORTED_EVENT_TYPES.map((type) => `on${type}`),
    });
    scanTree(root, batch);
  }

  for (const owner of descriptorOwners()) {
    for (const eventType of SUPPORTED_EVENT_TYPES) {
      const property = `on${eventType}`;
      const original = Object.getOwnPropertyDescriptor(owner, property);
      if (!original?.configurable || !original.get || !original.set) continue;
      const installed: PropertyDescriptor = {
        ...original,
        set(this: EventTarget, value: unknown) {
          original.set!.call(this, value);
          if (!active) return;
          try {
            const handler: unknown = original.get!.call(this);
            report(
              this,
              eventType,
              "event-handler-property",
              typeof handler === "function",
              handler,
            );
          } catch {
            logger.warn("property metadata unavailable", {
              code: "PROPERTY_METADATA_UNAVAILABLE",
            });
          }
        },
      };
      Object.defineProperty(owner, property, installed);
      patches.push({ owner, property, original, installed });
    }
  }
  observeRoot(document);
  logger.debug("surface observation installed", {
    propertyCount: patches.length,
  });

  return {
    observeRoot,
    dispose() {
      if (!active) return;
      active = false;
      observer.disconnect();
      for (const patch of patches) {
        const current = Object.getOwnPropertyDescriptor(
          patch.owner,
          patch.property,
        );
        if (
          current &&
          current.set === patch.installed.set &&
          current.get === patch.installed.get &&
          current.configurable === patch.installed.configurable &&
          current.enumerable === patch.installed.enumerable
        ) {
          Object.defineProperty(patch.owner, patch.property, patch.original);
        }
      }
      logger.debug("surface observation stopped", { slotCount });
    },
  };
}
