import { installListenerHook } from '../shared/detection/bridge';
import type { BridgeHandshake } from '../shared/contracts/records';

export default defineUnlistedScript(() => {
  const onHandshake = (event: MessageEvent<Partial<BridgeHandshake>>) => {
    if (event.source !== window || event.data?.source !== 'listener-lens' || event.data.type !== 'install-bridge' || !event.data.nonce) return;
    window.removeEventListener('message', onHandshake);
    installListenerHook(0, event.data.nonce);
  };
  window.addEventListener('message', onHandshake);
});
