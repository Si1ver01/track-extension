import browser from "webextension-polyfill";
import {
  SiteAccessController,
  type CollectorSender,
} from "../background/site-access";

export default defineBackground(() => {
  const access = new SiteAccessController(browser);
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: CollectorSender) =>
      access.handleMessage(message, sender),
  );
  browser.tabs.onRemoved.addListener((tabId) => access.resetTab(tabId));
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading") access.resetTab(tabId);
  });
  browser.permissions.onAdded.addListener((permissions) =>
    access.permissionsAdded(permissions.origins),
  );
  browser.permissions.onRemoved.addListener((permissions) =>
    access.permissionsRemoved(permissions.origins),
  );
  browser.runtime.onStartup.addListener(() => {
    void access.reconcile();
  });
  browser.runtime.onInstalled.addListener(() => {
    void access.reconcile();
  });
  void access.reconcile();
});
