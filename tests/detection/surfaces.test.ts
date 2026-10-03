import { describe, expect, it } from 'vitest';
import { describeHandlerSurface, scanInlineSurface } from '../../src/shared/detection/surfaces';

describe('handler surfaces', () => {
  it('classifies property handlers without exposing handler source', () => {
    const element = document.createElement('button');
    const surface = describeHandlerSurface('onclick', element, 'event-handler-property');
    expect(surface).toMatchObject({ eventType: 'click', sourceKind: 'event-handler-property', reasonCodes: ['SURFACE_UNVERIFIED'] });
  });

  it('reports only supported inline attributes', () => {
    const element = document.createElement('button');
    element.setAttribute('onclick', 'secretValue()');
    element.setAttribute('onunknown', 'secretValue()');
    const surfaces = scanInlineSurface(element);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).not.toHaveProperty('value');
  });
});
