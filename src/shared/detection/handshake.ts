import type { BridgeHandshake } from '../contracts/records';

type InjectBridge = () => Promise<void>;
type PostHandshake = (message: BridgeHandshake, targetOrigin: string) => void;

export async function initializeBridgeHandshake(
  nonce: string,
  injectBridge: InjectBridge,
  postHandshake: PostHandshake,
): Promise<void> {
  await injectBridge();
  postHandshake({ source: 'listener-lens', type: 'install-bridge', nonce }, '*');
}
