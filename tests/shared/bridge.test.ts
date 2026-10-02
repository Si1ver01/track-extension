import { describe, expect, it, vi } from 'vitest';
import { createBridgeMessage } from '../../src/shared/detection/bridge';
import { initializeBridgeHandshake } from '../../src/shared/detection/handshake';

describe('bridge messages', () => {
  it('includes the handshake nonce and metadata context', () => {
    const message = createBridgeMessage('click', 0, 'button', 'nonce-1');
    expect(message).toMatchObject({ source: 'listener-lens', nonce: 'nonce-1', type: 'listener-record' });
    expect(message?.record?.frameId).toBe(0);
  });

  it('ignores unsupported events', () => {
    expect(createBridgeMessage('custom-event', 0, 'window', 'nonce-1')).toBeNull();
  });

  it('posts the handshake only after bridge injection completes', async () => {
    let completeInjection!: () => void;
    const injectBridge = vi.fn(() => new Promise<void>((resolve) => { completeInjection = resolve; }));
    const postHandshake = vi.fn();

    const initialization = initializeBridgeHandshake('nonce-1', injectBridge, postHandshake);
    expect(postHandshake).not.toHaveBeenCalled();

    completeInjection();
    await initialization;

    expect(postHandshake).toHaveBeenCalledWith(
      { source: 'listener-lens', type: 'install-bridge', nonce: 'nonce-1' },
      '*',
    );
  });

  it('does not post the handshake when bridge injection fails', async () => {
    const postHandshake = vi.fn();

    await expect(initializeBridgeHandshake(
      'nonce-1',
      () => Promise.reject(new Error('injection failed')),
      postHandshake,
    )).rejects.toThrow('injection failed');
    expect(postHandshake).not.toHaveBeenCalled();
  });
});
