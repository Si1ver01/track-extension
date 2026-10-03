import { describe, expect, it } from 'vitest';
import { ListenerRegistry } from '../../src/shared/detection/registry';
import { normalizeRecord } from '../../src/shared/records/normalize';

const record = () => normalizeRecord({
  eventType: 'click',
  tabId: 1,
  frameId: 0,
  browser: 'chrome',
  source: { target: 'element', path: 'button' },
});

describe('ListenerRegistry', () => {
  it('deduplicates active registrations and removes matching capture identity', () => {
    const registry = new ListenerRegistry();
    const identity = { eventType: 'click', targetPath: 'button', capture: false, listenerKey: 'handler' };

    expect(registry.add(identity, record()).lifecycle).toBe('active');
    expect(registry.add(identity, record()).id).toBe(registry.list()[0]?.id);
    expect(registry.remove(identity)?.lifecycle).toBe('removed');
    expect(registry.list()).toHaveLength(0);
    expect(registry.list('removed')).toHaveLength(1);
  });

  it('keeps capture true and false registrations separate', () => {
    const registry = new ListenerRegistry();
    const base = { eventType: 'click', targetPath: 'button', listenerKey: 'handler' };

    registry.add({ ...base, capture: false }, record());
    registry.add({ ...base, capture: true }, record());

    expect(registry.list()).toHaveLength(2);
  });
});
