import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import type {
  ComparisonBaseline,
  ComparisonBaselineResult,
  SiteAccessSnapshot,
  SiteCoverage,
} from "../../shared/contracts/site-access";
import { createLogger } from "../../shared/logger";
import { getSiteScope } from "../../shared/site-access";
import type { ListenerRecord } from "../../shared/contracts/records";
import {
  isRevealResult,
  type RevealResult,
  type RevealTargetRequest,
} from "../../shared/contracts/reveal";

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

function isCoverage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const coverage = value as Partial<SiteCoverage>;
  return (
    Array.isArray(coverage.reasons) &&
    coverage.reasons.length <= 2 &&
    new Set(coverage.reasons).size === coverage.reasons.length &&
    coverage.reasons.every(
      (reason) =>
        reason === "FRAME_PARTIAL" || reason === "RECORD_LIMIT_REACHED",
    ) &&
    Number.isSafeInteger(coverage.recordLimit) &&
    (coverage.recordLimit ?? 0) > 0
  );
}

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
    (candidate.baseline === undefined ||
      (isBaseline(candidate.baseline) &&
        candidate.baseline.documentId === candidate.documentId)) &&
    isCoverage(candidate.coverage) &&
    (candidate.documentId === undefined ||
      (typeof candidate.documentId === "string" &&
        candidate.documentId.length > 0)) &&
    (candidate.site === null ||
      (typeof candidate.site?.pattern === "string" &&
        typeof candidate.site.label === "string"))
  );
}

function isBaseline(value: unknown): value is ComparisonBaseline {
  if (!value || typeof value !== "object") return false;
  const baseline = value as Partial<ComparisonBaseline>;
  return (
    typeof baseline.documentId === "string" &&
    baseline.documentId.length > 0 &&
    Array.isArray(baseline.records) &&
    typeof baseline.capturedAt === "number" &&
    Number.isFinite(baseline.capturedAt) &&
    typeof baseline.partial === "boolean"
  );
}

function isBaselineResult(value: unknown): value is ComparisonBaselineResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "baseline" in value &&
    (value.baseline === null || isBaseline(value.baseline)),
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
  const baselinePending = useRef(false);

  const acceptSnapshot = useCallback((next: SiteAccessSnapshot) => {
    current.current = next;
    setSnapshot(next);
    setIssue(null);
    logger.debug("site state updated", {
      tabId: next.tabId,
      status: next.status,
      recordCount: next.records.length,
      coverageReasons: next.coverage?.reasons ?? [],
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current || action.current || baselinePending.current) return;
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
    if (
      !target?.site ||
      (target.status !== "reload-required" && target.status !== "limited") ||
      action.current
    )
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

  const changeBaseline = async (capture: boolean): Promise<boolean> => {
    const target = current.current;
    if (
      !target?.documentId ||
      action.current ||
      baselinePending.current ||
      (target.status !== "ready" && target.status !== "limited")
    )
      return false;
    baselinePending.current = true;
    const requestVersion = ++version.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response: unknown = await Promise.race([
        browser.runtime.sendMessage({
          type: capture
            ? "set-comparison-baseline"
            : "clear-comparison-baseline",
          tabId: target.tabId,
          documentId: target.documentId,
        }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 4000);
        }),
      ]);
      const next = current.current;
      if (
        !mounted.current ||
        requestVersion !== version.current ||
        action.current ||
        !next ||
        next.tabId !== target.tabId ||
        next.documentId !== target.documentId ||
        (next.status !== "ready" && next.status !== "limited") ||
        !isBaselineResult(response) ||
        (response.baseline !== null &&
          response.baseline.documentId !== target.documentId)
      )
        return false;
      acceptSnapshot({ ...next, baseline: response.baseline ?? undefined });
      return true;
    } catch {
      logger.warn("Не удалось изменить базовый снимок", {
        code: "BASELINE_FAILED",
      });
      return false;
    } finally {
      clearTimeout(timer);
      baselinePending.current = false;
      void refresh();
    }
  };

  const reveal = async (record: ListenerRecord): Promise<RevealResult> => {
    const target = current.current;
    if (
      !target?.documentId ||
      action.current ||
      (target.status !== "ready" && target.status !== "limited")
    )
      return { status: "DOCUMENT_CHANGED" };
    const request: RevealTargetRequest = {
      type: "reveal-listener-target",
      tabId: target.tabId,
      frameId: record.frameId,
      mainDocumentId: target.documentId,
      documentId: record.documentId,
      contextKind: record.contextKind,
      recordId: record.id,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response: unknown = await Promise.race([
        browser.runtime.sendMessage(request),
        new Promise<RevealResult>((resolve) => {
          timer = setTimeout(() => resolve({ status: "TIMEOUT" }), 4000);
        }),
      ]);
      const next = current.current;
      if (
        !next ||
        action.current ||
        next.documentId !== target.documentId ||
        next.tabId !== target.tabId ||
        next.site?.pattern !== target.site?.pattern ||
        (next.status !== "ready" && next.status !== "limited")
      )
        return { status: "DOCUMENT_CHANGED" };
      return isRevealResult(response)
        ? { status: response.status }
        : { status: "REVEAL_FAILED" };
    } catch {
      logger.warn("Запрос подсветки не выполнен", { code: "REVEAL_FAILED" });
      return { status: "REVEAL_FAILED" };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    snapshot,
    pending,
    issue,
    grant,
    reload,
    revoke,
    retry,
    reveal,
    changeBaseline,
  };
}
