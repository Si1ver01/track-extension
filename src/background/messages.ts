import {
  addRecord,
  getTabState,
  resetContext,
  updateContext,
} from "./tab-state";
import { isListenerMessage, type TabState } from "../shared/contracts/records";
import { createLogger } from "../shared/logger";

const logger = createLogger("background");

interface RuntimeSender {
  tab?: { id?: number };
  frameId?: number;
}

export async function handleRuntimeMessage(
  message: unknown,
  sender: RuntimeSender,
): Promise<TabState | undefined> {
  if (!isListenerMessage(message)) {
    logger.warn("unknown message schema");
    return undefined;
  }

  logger.debug("message received", {
    type: message.type,
    tabId: message.tabId,
  });
  const senderTabId = sender.tab?.id;
  const senderFrameId = sender.frameId ?? message.frameId ?? 0;
  if (
    message.type === "context-navigation" ||
    message.type === "context-reset"
  ) {
    if (senderTabId === undefined || !message.documentId) {
      logger.warn("context message has no sender context", {
        type: message.type,
      });
      return undefined;
    }
    if (message.type === "context-reset")
      return resetContext(senderTabId, message.documentId);
    updateContext(senderTabId, {
      documentId: message.documentId,
      frameId: senderFrameId,
      contextKind: message.contextKind ?? "document",
      navigationId: message.navigationId,
    });
    logger.info("context state updated", {
      tabId: senderTabId,
      frameId: senderFrameId,
      documentId: message.documentId,
    });
    return getTabState(senderTabId);
  }
  if (message.type === "listener-record" && message.record) {
    const tabId = senderTabId;
    if (tabId === undefined) {
      logger.warn("[FIX] listener record has no sender tab");
      return undefined;
    }
    return addRecord({
      ...message.record,
      tabId,
      frameId: senderFrameId,
      documentId:
        message.documentId ?? message.record.documentId ?? "legacy-document",
    });
  }

  if (message.type === "get-tab-state" && message.tabId !== undefined) {
    const state = getTabState(message.tabId);
    logger.debug("[FIX] tab state response ready", {
      tabId: state.tabId,
      recordCount: state.records.length,
    });
    return state;
  }

  logger.warn("unknown message schema", { type: message.type });
  return undefined;
}
