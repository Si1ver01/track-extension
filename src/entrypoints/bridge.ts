import { installListenerHook } from '../shared/detection/bridge';

export default defineUnlistedScript(() => {
  installListenerHook();
});
