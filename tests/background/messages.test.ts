import { describe, expect, it } from 'vitest';
import { handleRuntimeMessage } from '../../src/background/messages';

describe('runtime messages', () => {
  it('returns tab state through a promise', async () => {
    const response = handleRuntimeMessage({ type: 'get-tab-state', tabId: 17 }, {});

    expect(response).toBeInstanceOf(Promise);
    await expect(response).resolves.toEqual({ tabId: 17, records: [], status: 'ready' });
  });
});
