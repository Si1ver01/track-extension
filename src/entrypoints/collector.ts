import { createLogger } from "../shared/logger";
import browser from "webextension-polyfill";
import { injectScript } from "#imports";
import type { BridgeRecordMessage } from "../shared/contracts/records";
import { initializeBridgeHandshake } from "../shared/detection/handshake";
import { getSiteScope } from "../shared/site-access";
import { createId } from "../shared/id";

export default defineUnlistedScript(() => {
  const logger = createLogger("content");
  const documentId = createId();
  const nonce = createId();
  let token: string | undefined;
  let pattern: string | undefined;
  let stopped = false;
  let installed = false;
  let ready = false;
  let coverageObserver: MutationObserver | undefined;
  let installTimer: number | undefined;
  let stopPromise: Promise<void> | undefined;
  let finishStop: (() => void) | undefined;
  let stopTimer: number | undefined;
  const pending: BridgeRecordMessage[] = [];

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    coverageObserver?.disconnect();
    window.clearTimeout(installTimer);
    document.removeEventListener("load", onFrameLoad, true);
    pending.length = 0;
    stopPromise = new Promise<void>((resolve) => {
      finishStop = () => {
        window.clearTimeout(stopTimer);
        window.removeEventListener("message", onBridgeMessage);
        finishStop = undefined;
        resolve();
      };
    });
    stopTimer = window.setTimeout(() => finishStop?.(), 250);
    window.postMessage(
      { source: "listener-lens", type: "stop-bridge", nonce },
      "*",
    );
    logger.debug("collector stopped", { documentId, code: "STOPPED" });
    return stopPromise;
  };
  const forward = (message: BridgeRecordMessage) => {
    if (stopped || !token) return;
    void browser.runtime.sendMessage({ ...message, documentId, token }).then(
      (value) => {
        if ((value as { stop?: boolean } | undefined)?.stop) stop();
      },
      () =>
        logger.warn("collector delivery failed", { code: "DELIVERY_FAILED" }),
    );
  };
  const hasPartialFrames = () => {
    const scope = getSiteScope(location.href);
    return [...document.querySelectorAll("iframe")].some((frame) => {
      const src = frame.getAttribute("src");
      return (
        !src ||
        frame.hasAttribute("srcdoc") ||
        src.startsWith("about:") ||
        getSiteScope(frame.src)?.pattern !== scope?.pattern
      );
    });
  };
  const reportFrames = () => {
    if (stopped || !ready || !token) return;
    void browser.runtime
      .sendMessage({
        type: "collector-frames-changed",
        documentId,
        token,
        partial: hasPartialFrames(),
      })
      .then(
        (value) => {
          if ((value as { stop?: boolean } | undefined)?.stop) stop();
        },
        () => undefined,
      );
  };
  function onFrameLoad(event: Event) {
    if (event.target instanceof HTMLIFrameElement) reportFrames();
  }
  function onBridgeMessage(event: MessageEvent) {
    const message = event.data as Partial<Omit<BridgeRecordMessage, "type">> & {
      type?: string;
    };
    if (
      event.source !== window ||
      message?.source !== "listener-lens" ||
      message.nonce !== nonce
    )
      return;
    if (message.type === "collector-stopped" && stopped) {
      finishStop?.();
      return;
    }
    if (stopped) return;
    if (message.type === "collector-ready") {
      installed = true;
      window.clearTimeout(installTimer);
      const partial = hasPartialFrames();
      void browser.runtime
        .sendMessage({ type: "collector-ready", documentId, token, partial })
        .then((value) => {
          const response = value as { stop?: boolean } | undefined;
          if (response?.stop || stopped) {
            stop();
            return;
          }
          ready = true;
          pending.splice(0).forEach(forward);
          coverageObserver = new MutationObserver((mutations) => {
            const containsFrame = (node: Node) =>
              node instanceof Element &&
              (node.matches("iframe") || node.querySelector("iframe") !== null);
            if (
              mutations.some((mutation) =>
                mutation.type === "attributes"
                  ? mutation.target instanceof HTMLIFrameElement
                  : [...mutation.addedNodes, ...mutation.removedNodes].some(
                      containsFrame,
                    ),
              )
            )
              reportFrames();
          });
          coverageObserver.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src", "srcdoc"],
          });
          document.addEventListener("load", onFrameLoad, true);
          reportFrames();
        }, stop);
      return;
    }
    // Handshake and stop commands share the page transport but are never records.
    if (
      message.type !== "listener-record" &&
      message.type !== "context-navigation" &&
      message.type !== "context-reset"
    )
      return;
    if (!ready) {
      if (pending.length < 200) pending.push(message as BridgeRecordMessage);
      return;
    }
    forward(message as BridgeRecordMessage);
  }
  window.addEventListener("message", onBridgeMessage);
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") return undefined;
    const request = message as {
      type?: string;
      documentId?: string;
      challenge?: string;
      patterns?: string[];
    };
    if (
      request.type === "collector-challenge" &&
      request.documentId === documentId &&
      !stopped
    ) {
      return Promise.resolve({ documentId, challenge: request.challenge });
    }
    if (
      request.type === "stop-collector" &&
      pattern &&
      request.patterns?.includes(pattern)
    ) {
      return stop().then(() => ({ stopped: true }));
    }
    if (request.type === "collector-status")
      return Promise.resolve({ documentId, installed: installed && !stopped });
    return undefined;
  });
  window.addEventListener(
    "pagehide",
    () => {
      if (ready && token && !stopped) {
        void browser.runtime
          .sendMessage({ type: "context-reset", documentId, token })
          .catch(() => undefined);
      }
      stop();
    },
    { once: true },
  );
  void browser.runtime
    .sendMessage({ type: "collector-start", documentId })
    .then(async (value) => {
      const response = value as
        { allowed?: boolean; token?: string; pattern?: string } | undefined;
      if (!response?.allowed || !response.token || stopped) {
        stop();
        return;
      }
      token = response.token;
      pattern = response.pattern;
      try {
        await initializeBridgeHandshake(
          nonce,
          async () => {
            await injectScript("/bridge.js");
          },
          (message, targetOrigin) => {
            if (!stopped)
              window.postMessage({ ...message, documentId }, targetOrigin);
          },
        );
        if (!installed && !stopped)
          installTimer = window.setTimeout(() => {
            void browser.runtime
              .sendMessage({ type: "collector-failed", documentId, token })
              .catch(() => undefined);
            stop();
          }, 3000);
      } catch {
        void browser.runtime
          .sendMessage({ type: "collector-failed", documentId, token })
          .catch(() => undefined);
        stop();
        logger.warn("bridge installation failed", {
          code: "INSTALL_FAILED",
          documentId,
        });
      }
    }, stop);
});
