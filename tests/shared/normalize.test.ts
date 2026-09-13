import { describe, expect, it } from 'vitest';
import { normalizeRecord } from '../../src/shared/records/normalize';

describe('normalizeRecord', () => {
  it('keeps metadata and omits forbidden payload fields', () => {
    const record = normalizeRecord({ eventType: 'copy', tabId: 1, frameId: 2, browser: 'chrome', source: { target: 'document', path: 'body' } });
    expect(record.description).toContain('copy');
    expect(record.source).not.toHaveProperty('payload');
  });
});
