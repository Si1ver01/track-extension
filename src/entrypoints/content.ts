import { createLogger } from "../shared/logger";
import browser from "webextension-polyfill";
import { injectScript } from "#imports";
import type { BridgeRecordMessage } from "../shared/contracts/records";
import { initializeBridgeHandshake } from "../shared/detection/handshake";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    const logger = createLogger("content");
    const nonce = crypto.randomUUID();
    logger.debug("content script initialized", { runAt: "document_start" });
    window.addEventListener("message", (event) => {
      const message = event.data as Partial<BridgeRecordMessage>;
      if (
        event.source !== window ||
        message.source !== "listener-lens" ||
        message.nonce !== nonce
      )
        return;
      logger.debug("bridge message forwarded", { type: message.type });
      browser.runtime
        .sendMessage(message)
        .catch((error) =>
          logger.warn("[FIX] bridge delivery failed", { error: String(error) }),
        );
    });
    logger.debug("[FIX] page bridge injection started", { path: "/bridge.js" });
    initializeBridgeHandshake(
      nonce,
      async () => {
        await injectScript("/bridge.js");
      },
      (message, targetOrigin) => window.postMessage(message, targetOrigin),
    )
      .then(() => logger.debug("[FIX] page bridge handshake completed"))
      .catch((error) =>
        logger.warn("[FIX] page bridge injection failed", {
          error: String(error),
        }),
      );
  },
});
