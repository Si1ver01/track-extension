import { installListenerHook } from "../shared/detection/bridge";
import type { BridgeHandshake } from "../shared/contracts/records";

export default defineUnlistedScript(() => {
  let dispose: (() => void) | undefined;
  let nonce: string | undefined;
  const onMessage = (
    event: MessageEvent<
      Partial<Omit<BridgeHandshake, "type">> & { type?: string }
    >,
  ) => {
    if (
      event.source !== window ||
      event.data?.source !== "listener-lens" ||
      !event.data.nonce
    )
      return;
    if (event.data.type === "stop-bridge" && event.data.nonce === nonce) {
      dispose?.();
      dispose = undefined;
      window.removeEventListener("message", onMessage);
      window.postMessage(
        { source: "listener-lens", nonce, type: "collector-stopped" },
        "*",
      );
      return;
    }
    if (event.data.type !== "install-bridge" || nonce) return;
    nonce = event.data.nonce;
    dispose = installListenerHook(0, nonce, event.data.documentId ?? "");
    window.postMessage(
      { source: "listener-lens", nonce, type: "collector-ready" },
      "*",
    );
  };
  window.addEventListener("message", onMessage);
});
