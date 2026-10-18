import browser from "webextension-polyfill";
import { injectScript } from "#imports";
import { CollectorRecovery } from "../shared/collector-recovery";
import { createLogger } from "../shared/logger";
import { initializeBridgeHandshake } from "../shared/detection/handshake";
import { getSiteScope } from "../shared/site-access";
import { createId } from "../shared/id";

export default defineUnlistedScript(() => {
  const logger = createLogger("content");
  const documentId = createId();
  const nonce = createId();
  let stopped = false;
  let installPromise: Promise<void> | undefined;
  let finishInstall: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  let finishStop: (() => void) | undefined;
  let stopTimer: number | undefined;

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    coverageObserver.disconnect();
    document.removeEventListener("load", onFrameLoad, true);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
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

  const installBridge = () => {
    if (installPromise) return installPromise;
    installPromise = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("INSTALL_FAILED")),
        3000,
      );
      finishInstall = () => {
        window.clearTimeout(timer);
        finishInstall = undefined;
        resolve();
      };
      void initializeBridgeHandshake(
        nonce,
        async () => {
          await injectScript("/bridge.js");
        },
        (message, targetOrigin) => {
          if (!stopped)
            window.postMessage({ ...message, documentId }, targetOrigin);
        },
      ).catch(() => {
        window.clearTimeout(timer);
        reject(new Error("INSTALL_FAILED"));
      });
    });
    return installPromise;
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
  const recovery = new CollectorRecovery({
    documentId,
    send: (message) => browser.runtime.sendMessage(message),
    install: installBridge,
    stop: () => {
      void stop();
    },
    partial: hasPartialFrames,
  });

  function onFrameLoad(event: Event) {
    if (event.target instanceof HTMLIFrameElement) recovery.framesChanged();
  }
  const coverageObserver = new MutationObserver((mutations) => {
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
      recovery.framesChanged();
  });
  coverageObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcdoc"],
  });
  document.addEventListener("load", onFrameLoad, true);

  function onBridgeMessage(event: MessageEvent) {
    const message = event.data;
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
    if (message.type === "collector-ready") finishInstall?.();
    else recovery.accept(message);
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
      recovery.canChallenge
    )
      return Promise.resolve({ documentId, challenge: request.challenge });
    if (
      request.type === "stop-collector" &&
      recovery.pattern &&
      request.patterns?.includes(recovery.pattern)
    ) {
      recovery.stop();
      return stop().then(() => ({ stopped: true }));
    }
    if (request.type === "collector-status")
      return Promise.resolve(recovery.status);
    if (request.type === "collector-recover" && recovery.canChallenge)
      return recovery.connect().then(() => recovery.status);
    return undefined;
  });
  function onPageHide(event: PageTransitionEvent) {
    recovery.pause();
    if (!event.persisted) recovery.stop();
  }
  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted) void recovery.resume();
  }
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  void recovery.connect();
});
