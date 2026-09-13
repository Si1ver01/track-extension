import { describe, expect, it } from 'vitest';
import { addRecord, getTabState, resetTabState } from '../../src/background/tab-state';
import { normalizeRecord } from '../../src/shared/records/normalize';

describe('tab state', () => {
  it('groups records by tab and resets them', () => {
    addRecord(normalizeRecord({ eventType: 'click', tabId: 3, frameId: 0, browser: 'chrome', source: { target: 'window', path: '/' } }));
    expect(getTabState(3).records).toHaveLength(1);
    resetTabState(3);
    expect(getTabState(3).records).toHaveLength(0);
  });
});
