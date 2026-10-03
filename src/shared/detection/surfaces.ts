import type { ListenerReasonCode, ListenerSourceKind, ListenerTarget } from '../contracts/records';

const supported = new Set(['click', 'copy', 'cut', 'paste', 'input', 'change', 'submit', 'load', 'error', 'keydown', 'keyup']);

export interface SurfaceMetadata {
  eventType: string;
  target: ListenerTarget;
  path: string;
  sourceKind: ListenerSourceKind;
  reasonCodes: ListenerReasonCode[];
}

export function describeHandlerSurface(eventType: string, target: EventTarget, sourceKind: ListenerSourceKind): SurfaceMetadata | null {
  const normalized = eventType.replace(/^on/, '').toLowerCase();
  if (!supported.has(normalized)) return null;
  return {
    eventType: normalized,
    target: target === document ? 'document' : target instanceof Element ? 'element' : 'window',
    path: target instanceof Element ? target.tagName.toLowerCase() : target === document ? 'document' : 'window',
    sourceKind,
    reasonCodes: ['SURFACE_UNVERIFIED'],
  };
}

export function scanInlineSurface(target: Element): SurfaceMetadata[] {
  return [...target.attributes]
    .filter((attribute) => attribute.name.startsWith('on'))
    .map((attribute) => describeHandlerSurface(attribute.name, target, 'inline-attribute'))
    .filter((surface): surface is SurfaceMetadata => surface !== null);
}
