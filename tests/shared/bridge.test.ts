import { describe, expect, it } from 'vitest';
import { createBridgeMessage } from '../../src/shared/detection/bridge';

describe('bridge messages', () => {
  it('includes the handshake nonce and metadata context', () => {
    const message = createBridgeMessage('click', 0, 'button', 'nonce-1');
    expect(message).toMatchObject({ source: 'listener-lens', nonce: 'nonce-1', type: 'listener-record' });
    expect(message?.record.frameId).toBe(0);
  });

  it('ignores unsupported events', () => {
    expect(createBridgeMessage('custom-event', 0, 'window', 'nonce-1')).toBeNull();
  });
});
