import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import type { SiteAccessSnapshot } from "../../shared/contracts/site-access";
import { createLogger } from "../../shared/logger";
import { getSiteScope } from "../../shared/site-access";

const logger = createLogger("popup.site-access");
const recoveryTimeout = 10_000;
const pollInterval = 500;

type PendingAction = "grant" | "reload" | "revoke" | null;
type AccessIssue =
  | "load"
  | "grant"
  | "reload"
  | "revoke"
  | "denied"
  | "changed"
  | "timeout"
  | null;

const statuses = new Set([
  "unsupported",
  "no-access",
  "reload-required",
  "recovering",
  "ready",
  "limited",
  "error",
]);

function isSnapshot(
  value: unknown,
  tabId: number,
): value is SiteAccessSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SiteAccessSnapshot>;
  return (
    candidate.tabId === tabId &&
    typeof candidate.status === "string" &&
    statuses.has(candidate.status) &&
    Array.isArray(candidate.records) &&
    (candidate.site === null ||
      (typeof candidate.site?.pattern === "string" &&
        typeof candidate.site.label === "string"))
  );
}

export function useSiteAccess() {
  const [snapshot, setSnapshot] = useState<SiteAccessSnapshot | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [issue, setIssue] = useState<AccessIssue>(null);
  const mounted = useRef(false);
  const current = useRef<SiteAccessSnapshot | null>(null);
  const tabId = useRef<number | null>(null);
  const action = useRef<PendingAction>(null);
  const version = useRef(0);

  const acceptSnapshot = useCallback((next: SiteAccessSnapshot) => {
    current.current = next;
    setSnapshot(next);
    setIssue(null);
    logger.debug("site state updated", {
      tabId: next.tabId,
      status: next.status,
      recordCount: next.records.length,
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current || action.current) return;
    const requestVersion = ++version.current;
    try {
      if (tabId.current === null) {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!mounted.current || requestVersion !== version.current) return;
        if (tab?.id === undefined) throw new Error("TAB_UNAVAILABLE");
        tabId.current = tab.id;
      }
      const targetId = tabId.current;
      const result: unknown = await browser.runtime.sendMessage({
        type: "get-site-access",
        tabId: targetId,
      });
      if (!mounted.current || requestVersion !== version.current) return;
      if (!isSnapshot(result, targetId)) throw new Error("INVALID_SNAPSHOT");
      acceptSnapshot(result);
    } catch {
      if (!mounted.current || requestVersion !== version.current) return;
      logger.warn("site state request failed", {
        code: "STATE_REQUEST_FAILED",
      });
      setIssue("load");
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    mounted.current = true;
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "site-access-updated" &&
        "tabId" in message &&
        message.tabId === tabId.current
      ) {
        void refresh();
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    void refresh();
    return () => {
      mounted.current = false;
      version.current += 1;
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, [refresh]);

  useEffect(() => {
    if (snapshot?.status !== "recovering" || issue || pending) return;
    const interval = window.setInterval(() => void refresh(), pollInterval);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      version.current += 1;
      setIssue("timeout");
      logger.warn("collector readiness timed out", {
        tabId: snapshot.tabId,
        code: "READINESS_TIMEOUT",
      });
    }, recoveryTimeout);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [snapshot?.status, snapshot?.tabId, issue, pending, refresh]);

  const finish = (actionVersion: number) => {
    if (!mounted.current || version.current !== actionVersion) return false;
    action.current = null;
    setPending(null);
    return true;
  };

  const grant = () => {
    const target = current.current;
    if (!target?.site || target.status !== "no-access" || action.current)
      return;
    action.current = "grant";
    const actionVersion = ++version.current;
    let request: Promise<boolean>;
    try {
      // Firefox requires this API call in the original click handler.
      request = browser.permissions.request({ origins: [target.site.pattern] });
    } catch {
      action.current = null;
      setIssue("grant");
      logger.warn("permission request failed", {
        code: "PERMISSION_REQUEST_FAILED",
      });
      return;
    }
    setPending("grant");
    setIssue(null);
    logger.debug("permission request started", { tabId: target.tabId });
    void (async () => {
      try {
        const granted = await request;
        if (!mounted.current || version.current !== actionVersion) return;
        if (!granted) {
          if (finish(actionVersion)) setIssue("denied");
          logger.debug("permission request declined", { tabId: target.tabId });
          return;
        }
        const next: unknown = await browser.runtime.sendMessage({
          type: "activate-site",
          tabId: target.tabId,
          pattern: target.site!.pattern,
        });
        if (!mounted.current || version.current !== actionVersion) return;
        if (!isSnapshot(next, target.tabId))
          throw new Error("INVALID_SNAPSHOT");
        if (finish(actionVersion)) acceptSnapshot(next);
      } catch {
        if (finish(actionVersion)) setIssue("grant");
        logger.warn("site activation failed", { code: "ACTIVATION_FAILED" });
      }
    })();
  };

  const reload = () => {
    const target = current.current;
    if (!target?.site || target.status !== "reload-required" || action.current)
      return;
    action.current = "reload";
    const actionVersion = ++version.current;
    setPending("reload");
    setIssue(null);
    void (async () => {
      try {
        const tab = await browser.tabs.get(target.tabId);
        if (!mounted.current || version.current !== actionVersion) return;
        if (
          getSiteScope(tab.pendingUrl ?? tab.url)?.pattern !==
          target.site!.pattern
        ) {
          if (finish(actionVersion)) {
            setIssue("changed");
            void refresh();
          }
          logger.debug("reload skipped after navigation", {
            tabId: target.tabId,
            code: "SITE_CHANGED",
          });
          return;
        }
        await browser.tabs.reload(target.tabId);
        if (finish(actionVersion)) {
          acceptSnapshot({ ...target, status: "recovering", records: [] });
          logger.debug("tab reload requested", { tabId: target.tabId });
        }
      } catch {
        if (finish(actionVersion)) setIssue("reload");
        logger.warn("tab reload failed", { code: "RELOAD_FAILED" });
      }
    })();
  };

  const revoke = () => {
    const target = current.current;
    if (!target?.site || target.status === "no-access" || action.current)
      return;
    action.current = "revoke";
    const actionVersion = ++version.current;
    setPending("revoke");
    setIssue(null);
    void (async () => {
      try {
        const next: unknown = await browser.runtime.sendMessage({
          type: "revoke-site",
          tabId: target.tabId,
          pattern: target.site!.pattern,
        });
        if (!mounted.current || version.current !== actionVersion) return;
        if (!isSnapshot(next, target.tabId))
          throw new Error("INVALID_SNAPSHOT");
        if (finish(actionVersion)) acceptSnapshot(next);
      } catch {
        if (finish(actionVersion)) setIssue("revoke");
        logger.warn("permission revocation failed", {
          code: "REVOCATION_FAILED",
        });
      }
    })();
  };

  const retry = () => {
    if (action.current) return;
    setIssue(null);
    void refresh();
  };

  return { snapshot, pending, issue, grant, reload, revoke, retry };
}
