import type browser from "webextension-polyfill";
import { isListenerMessage } from "../shared/contracts/records";
import type {
  ComparisonBaseline,
  ComparisonBaselineResult,
  SiteAccessSnapshot,
  SiteCoverageReason,
  SiteScope,
} from "../shared/contracts/site-access";
import { getSiteScope, isExactSitePattern } from "../shared/site-access";
import { createLogger } from "../shared/logger";
import { createId } from "../shared/id";
import {
  safeMetadataId,
  sanitizeListenerRecord,
} from "../shared/records/sanitize";
import { MAX_COLLECTOR_RECORDS } from "../shared/contracts/collector";
import { copySnapshotRecords } from "../shared/records/snapshot";
import { isRevealResult, type RevealResult } from "../shared/contracts/reveal";
import {
  addRecord,
  MAX_TAB_RECORDS,
  getTabState,
  resetContext,
  restoreContext,
  resetTabState,
  updateContext,
} from "./tab-state";

export type SiteAccessApi = Pick<
  typeof browser,
  "permissions" | "scripting" | "tabs" | "runtime"
>;
export interface CollectorSender {
  id?: string;
  tab?: { id?: number };
  frameId?: number;
  documentId?: string;
  url?: string;
  origin?: string;
  documentLifecycle?: string;
}
interface Session {
  tabId: number;
  frameId: number;
  documentId: string;
  collectorDocumentId: string;
  nativeDocumentId?: string;
  pattern: string;
  token: string;
  ready: boolean;
  partial: boolean;
  failed: boolean;
}
const logger = createLogger("background.site-access");
const scriptPrefix = "listener-lens-site-";
export const MAX_COMPARISON_BASELINES = 8;
function registrationId(pattern: string) {
  // The exact pattern is encoded without exposing page paths or relying on a hash collision.
  return (
    scriptPrefix +
    [...pattern]
      .map((value) => value.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
  );
}
function frameKey(tabId: number, frameId: number) {
  return `${tabId}:${frameId}`;
}

export class SiteAccessController {
  private sessions = new Map<string, Session>();
  private claims = new Map<string, number>();
  private blocked = new Set<string>();
  private generation = 0;
  private scopeGenerations = new Map<string, number>();
  private broadRevocations = 0;
  private queue: Promise<void> = Promise.resolve();
  private registrationFailed = false;
  private recoveries = new Map<number, Promise<void>>();
  private baselines = new Map<number, ComparisonBaseline>();
  constructor(private api: SiteAccessApi) {}
  private scopeVersion(pattern: string) {
    return `${this.broadRevocations}:${this.scopeGenerations.get(pattern) ?? 0}`;
  }
  private invalidateScope(pattern: string) {
    this.scopeGenerations.set(
      pattern,
      (this.scopeGenerations.get(pattern) ?? 0) + 1,
    );
  }

  private async grants(): Promise<Set<string>> {
    const permissions = await this.api.permissions.getAll();
    return new Set((permissions.origins ?? []).filter(isExactSitePattern));
  }
  private notify(tabId: number) {
    void this.api.runtime
      .sendMessage({ type: "site-access-updated", tabId })
      .catch(() => undefined);
  }
  reconcile(): Promise<void> {
    const run = this.queue
      .catch(() => undefined)
      .then(async () => {
        let version: number;
        do {
          version = this.generation;
          const origins = await this.grants();
          if (version !== this.generation) continue;
          const registrations =
            await this.api.scripting.getRegisteredContentScripts();
          if (version !== this.generation) continue;
          const wanted = new Map(
            [...origins]
              .filter((pattern) => !this.blocked.has(pattern))
              .map((pattern) => [registrationId(pattern), pattern]),
          );
          const owned = registrations.filter((entry) =>
            entry.id.startsWith(scriptPrefix),
          );
          const obsolete = owned.filter(
            (entry) =>
              !wanted.has(entry.id) ||
              entry.matches?.[0] !== wanted.get(entry.id) ||
              entry.js?.[0] !== "collector.js" ||
              entry.runAt !== "document_start" ||
              !entry.allFrames ||
              !entry.matchOriginAsFallback,
          );
          if (obsolete.length)
            await this.api.scripting.unregisterContentScripts({
              ids: obsolete.map((entry) => entry.id),
            });
          if (version !== this.generation) continue;
          const current = new Set(
            owned
              .filter((entry) => !obsolete.includes(entry))
              .map((entry) => entry.id),
          );
          const missing = [...wanted].filter(([id]) => !current.has(id));
          if (missing.length)
            await this.api.scripting.registerContentScripts(
              missing.map(([id, pattern]) => ({
                id,
                matches: [pattern],
                js: ["collector.js"],
                allFrames: true,
                runAt: "document_start",
                persistAcrossSessions: true,
                matchOriginAsFallback: true,
              })),
            );
        } while (version !== this.generation);
        this.registrationFailed = false;
        logger.debug("registrations reconciled", { generation: version });
      });
    this.queue = run.catch(() => {
      this.registrationFailed = true;
      logger.warn("registration reconciliation failed", {
        code: "REGISTRATION_FAILED",
      });
    });
    return this.queue;
  }
  permissionsAdded(origins: string[] = []) {
    this.generation++;
    origins.forEach((pattern) => this.blocked.delete(pattern));
    void this.reconcile();
  }
  permissionsRemoved(origins: string[] = []) {
    this.generation++;
    if (origins.some((pattern) => !isExactSitePattern(pattern)))
      this.broadRevocations++;
    // Close ingress synchronously, before any permission or messaging await.
    const patterns = new Set(origins);
    for (const session of this.sessions.values()) {
      if (
        origins.some((pattern) => !isExactSitePattern(pattern)) ||
        patterns.has(session.pattern)
      )
        patterns.add(session.pattern);
    }
    patterns.forEach((pattern) => {
      this.blocked.add(pattern);
      this.invalidateScope(pattern);
    });
    void this.stopPatterns(patterns).then(() => this.reconcile());
  }
  resetTab(tabId: number) {
    this.baselines.delete(tabId);
    for (const [key, session] of this.sessions)
      if (session.tabId === tabId) this.sessions.delete(key);
    for (const [key, claim] of this.claims)
      if (key.startsWith(`${tabId}:`)) this.claims.set(key, claim + 1);
    resetTabState(tabId);
    this.notify(tabId);
  }
  async handleTabLoading(tabId: number) {
    const key = frameKey(tabId, 0);
    const main = this.sessions.get(key);
    if (!main?.ready) return;
    const current = await this.currentCollector(main);
    // Chromium сообщает loading и для History API. Живой сборщик того же
    // документа сохраняет сессию и уже полученные записи.
    if (this.sessions.get(key) !== main || current) return;
    this.resetTab(tabId);
  }
  private async stopPatterns(patterns: Set<string>) {
    // Снимки могут включать фреймы с отдельным разрешением.
    this.baselines.clear();
    const affected = [...this.sessions.values()].filter((session) =>
      patterns.has(session.pattern),
    );
    for (const session of affected) {
      this.sessions.delete(frameKey(session.tabId, session.frameId));
      resetContext(session.tabId, session.documentId);
      this.notify(session.tabId);
    }
    const tabs = await this.api.tabs.query({}).catch(() => []);
    const ids = new Set(affected.map((session) => session.tabId));
    tabs.forEach((tab) => {
      if (
        tab.id !== undefined &&
        patterns.has(getSiteScope(tab.url)?.pattern ?? "")
      )
        ids.add(tab.id);
    });
    await Promise.all(
      [...ids].map(async (tabId) => {
        // A scope-specific broadcast also stops collectors surviving a service-worker restart.
        await this.api.tabs
          .sendMessage(tabId, {
            type: "stop-collector",
            patterns: [...patterns],
          })
          .catch(() => undefined);
        const main = this.sessions.get(frameKey(tabId, 0));
        if (main) main.partial = true;
        this.notify(tabId);
      }),
    );
  }
  async snapshot(tabId: number): Promise<SiteAccessSnapshot> {
    let site: SiteScope | null = null;
    try {
      const tab = await this.api.tabs.get(tabId);
      site = getSiteScope(tab.url);
      if (!site) return { tabId, site, status: "unsupported", records: [] };
      if (
        !(await this.grants()).has(site.pattern) ||
        this.blocked.has(site.pattern)
      )
        return { tabId, site, status: "no-access", records: [] };
      if (this.registrationFailed) await this.reconcile();
      if (this.registrationFailed)
        return {
          tabId,
          site,
          status: "error",
          records: [],
          reason: "REGISTRATION_FAILED",
        };
      const version = this.scopeVersion(site.pattern);
      await this.pruneCollectors(tabId);
      if (!this.sessions.has(frameKey(tabId, 0)))
        await this.recoverCollectors(tabId);
      if (
        version !== this.scopeVersion(site.pattern) ||
        this.blocked.has(site.pattern) ||
        !(await this.grants()).has(site.pattern)
      )
        return { tabId, site, status: "no-access", records: [] };
      const currentSite = getSiteScope((await this.api.tabs.get(tabId)).url);
      if (currentSite?.pattern !== site.pattern)
        return { tabId, site: currentSite, status: "recovering", records: [] };
      const main = this.sessions.get(frameKey(tabId, 0));
      if (!main || main.pattern !== site.pattern)
        return {
          tabId,
          site,
          status: "reload-required",
          records: [],
          reason: "COLLECTOR_MISSING",
        };
      if (main.failed)
        return {
          tabId,
          site,
          status: "error",
          records: [],
          reason: "INSTALL_FAILED",
        };
      if (!main.ready)
        return { tabId, site, status: "recovering", records: [] };
      const state = getTabState(tabId);
      const baseline = this.baselines.get(tabId);
      if (baseline && baseline.documentId !== main.documentId)
        this.baselines.delete(tabId);
      const partial = [...this.sessions.values()].some(
        (session) =>
          session.tabId === tabId && (session.partial || session.failed),
      );
      const reasons: SiteCoverageReason[] = [];
      if (partial) reasons.push("FRAME_PARTIAL");
      if (state.recordLimitReached) reasons.push("RECORD_LIMIT_REACHED");
      logger.debug("coverage snapshot prepared", {
        tabId,
        reasons,
        recordCount: state.records.length,
      });
      return {
        tabId,
        site,
        status: reasons.length > 0 ? "limited" : "ready",
        records: state.records,
        documentId: main.documentId,
        ...(baseline?.documentId === main.documentId
          ? {
              baseline: {
                ...baseline,
                records: copySnapshotRecords(baseline.records),
              },
            }
          : {}),
        ...(reasons.length > 0
          ? {
              reason: reasons[0],
              coverage: { reasons, recordLimit: MAX_TAB_RECORDS },
            }
          : {}),
      };
    } catch {
      return {
        tabId,
        site,
        status: "error",
        records: [],
        reason: "ACCESS_UNAVAILABLE",
      };
    }
  }
  private recoverCollectors(tabId: number): Promise<void> {
    const existing = this.recoveries.get(tabId);
    if (existing) return existing;
    logger.debug("requesting live collector recovery", { tabId });
    const recovery = this.api.tabs
      .sendMessage(tabId, { type: "collector-recover" })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.recoveries.get(tabId) === recovery)
          this.recoveries.delete(tabId);
      });
    this.recoveries.set(tabId, recovery);
    return recovery;
  }
  private senderScope(sender: CollectorSender) {
    const direct = getSiteScope(sender.url);
    if (direct) return direct;
    // Inherited URLs are accepted only with an origin supplied by the browser.
    if (/^about:(blank|srcdoc)(?:[?#]|$)/.test(sender.url ?? ""))
      return getSiteScope(sender.origin);
    return null;
  }
  private async pruneCollectors(tabId: number) {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.tabId === tabId && session.ready)
        .map(async (session) => {
          const response = (await this.api.tabs
            .sendMessage(
              tabId,
              { type: "collector-status" },
              { frameId: session.frameId },
            )
            .catch(() => undefined)) as
            { documentId?: string; installed?: boolean } | undefined;
          const key = frameKey(tabId, session.frameId);
          if (
            this.sessions.get(key) === session &&
            (response?.documentId !== session.collectorDocumentId ||
              !response.installed)
          ) {
            this.sessions.delete(key);
            if (session.frameId === 0) this.baselines.delete(tabId);
            resetContext(tabId, session.documentId);
            const main = this.sessions.get(frameKey(tabId, 0));
            if (main) main.partial = true;
            this.notify(tabId);
          }
        }),
    );
  }
  private async currentCollector(session: Session): Promise<boolean> {
    const response = (await this.api.tabs
      .sendMessage(
        session.tabId,
        { type: "collector-status" },
        { frameId: session.frameId },
      )
      .catch(() => undefined)) as
      { documentId?: string; installed?: boolean } | undefined;
    return (
      response?.documentId === session.collectorDocumentId &&
      response?.installed === true
    );
  }
  private async start(
    message: Record<string, unknown>,
    sender: CollectorSender,
  ) {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    const site = this.senderScope(sender);
    if (
      sender.documentLifecycle !== undefined &&
      sender.documentLifecycle !== "active"
    )
      return { allowed: false, code: "DOCUMENT_INACTIVE" };
    if (
      tabId === undefined ||
      frameId === undefined ||
      !site ||
      typeof message.documentId !== "string" ||
      !message.documentId ||
      this.blocked.has(site.pattern)
    )
      return { allowed: false, code: "SCOPE_UNAVAILABLE" };
    const version = this.scopeVersion(site.pattern);
    const key = frameKey(tabId, frameId);
    const claim = (this.claims.get(key) ?? 0) + 1;
    this.claims.set(key, claim);
    if (!(await this.grants()).has(site.pattern))
      return { allowed: false, code: "GRANT_MISSING" };
    const documentId = sender.documentId ?? message.documentId;
    const challenge = createId();
    const response = (await this.api.tabs
      .sendMessage(
        tabId,
        {
          type: "collector-challenge",
          documentId: message.documentId,
          challenge,
        },
        { frameId },
      )
      .catch(() => undefined)) as
      { documentId?: string; challenge?: string } | undefined;
    if (
      response?.documentId !== message.documentId ||
      response?.challenge !== challenge
    )
      return { allowed: false, code: "DOCUMENT_CHANGED" };
    const stillGranted = (await this.grants()).has(site.pattern);
    if (
      version !== this.scopeVersion(site.pattern) ||
      this.blocked.has(site.pattern) ||
      !stillGranted
    )
      return { allowed: false, code: "SESSION_INVALIDATED" };
    if (this.claims.get(key) !== claim)
      return { allowed: false, recover: true, code: "CLAIM_SUPERSEDED" };
    const existing = this.sessions.get(key);
    if (existing?.documentId === documentId && message.resume !== true)
      return { allowed: true, token: existing.token, pattern: site.pattern };
    if (frameId === 0 && this.baselines.get(tabId)?.documentId !== documentId)
      this.baselines.delete(tabId);
    if (existing && existing.documentId !== documentId) {
      if (frameId === 0) resetTabState(tabId);
      else resetContext(tabId, existing.documentId);
    }
    const session: Session = {
      tabId,
      frameId,
      documentId,
      collectorDocumentId: message.documentId,
      nativeDocumentId: sender.documentId,
      pattern: site.pattern,
      token: createId(),
      ready: false,
      partial: false,
      failed: false,
    };
    this.sessions.set(key, session);
    updateContext(tabId, { documentId, frameId, contextKind: "document" });
    logger.debug("collector session established", {
      tabId,
      frameId,
      documentId,
    });
    this.notify(tabId);
    return { allowed: true, token: session.token, pattern: site.pattern };
  }
  private isPopupSender(sender: CollectorSender) {
    return (
      !sender.tab &&
      sender.id === this.api.runtime.id &&
      sender.url === this.api.runtime.getURL("popup.html")
    );
  }

  private async changeBaseline(
    message: Record<string, unknown>,
    sender: CollectorSender,
  ): Promise<ComparisonBaselineResult | undefined> {
    if (
      !this.isPopupSender(sender) ||
      !Number.isSafeInteger(message.tabId) ||
      (message.tabId as number) < 0 ||
      !safeMetadataId(message.documentId)
    )
      return undefined;
    const tabId = message.tabId as number;
    const main = this.sessions.get(frameKey(tabId, 0));
    if (!main || main.documentId !== message.documentId) return undefined;
    const generation = this.generation;
    const snapshot = await this.snapshot(tabId);
    if (
      generation !== this.generation ||
      this.sessions.get(frameKey(tabId, 0)) !== main ||
      snapshot.documentId !== message.documentId ||
      (snapshot.status !== "ready" && snapshot.status !== "limited")
    )
      return undefined;
    this.baselines.delete(tabId);
    if (message.type === "clear-comparison-baseline") return { baseline: null };
    const baseline: ComparisonBaseline = {
      documentId: main.documentId,
      records: copySnapshotRecords(snapshot.records),
      capturedAt: Date.now(),
      partial: snapshot.status === "limited",
    };
    this.baselines.set(tabId, baseline);
    if (this.baselines.size > MAX_COMPARISON_BASELINES)
      this.baselines.delete(this.baselines.keys().next().value!);
    logger.debug("Базовый снимок сохранён", {
      tabId,
      count: baseline.records.length,
    });
    return {
      baseline: { ...baseline, records: copySnapshotRecords(baseline.records) },
    };
  }

  private async revealTarget(
    message: Record<string, unknown>,
    sender: CollectorSender,
  ): Promise<RevealResult> {
    if (!this.isPopupSender(sender)) return { status: "ACCESS_DENIED" };
    if (
      !Number.isSafeInteger(message.tabId) ||
      (message.tabId as number) < 0 ||
      !Number.isSafeInteger(message.frameId) ||
      (message.frameId as number) < 0 ||
      !safeMetadataId(message.recordId) ||
      !safeMetadataId(message.documentId) ||
      !safeMetadataId(message.mainDocumentId)
    )
      return { status: "REVEAL_FAILED" };
    const tabId = message.tabId as number;
    const frameId = message.frameId as number;
    const main = this.sessions.get(frameKey(tabId, 0));
    const session = this.sessions.get(frameKey(tabId, frameId));
    if (
      !main ||
      !session ||
      main.documentId !== message.mainDocumentId ||
      session.documentId !== message.documentId
    )
      return { status: "DOCUMENT_CHANGED" };
    const findRecord = () =>
      getTabState(tabId).records.find(
        (record) =>
          record.frameId === frameId &&
          record.documentId === message.documentId &&
          record.contextKind === message.contextKind &&
          record.id === message.recordId,
      );
    const record = findRecord();
    if (!record) return { status: "TARGET_UNAVAILABLE" };
    if (record.source.target !== "element") return { status: "NO_ELEMENT" };
    const mainVersion = this.scopeVersion(main.pattern);
    const version = this.scopeVersion(session.pattern);
    const valid = () =>
      this.sessions.get(frameKey(tabId, 0)) === main &&
      this.sessions.get(frameKey(tabId, frameId)) === session &&
      main.ready &&
      session.ready &&
      !main.failed &&
      !session.failed &&
      !this.blocked.has(main.pattern) &&
      !this.blocked.has(session.pattern) &&
      mainVersion === this.scopeVersion(main.pattern) &&
      version === this.scopeVersion(session.pattern) &&
      Boolean(findRecord());
    try {
      const grants = await this.grants();
      if (!grants.has(main.pattern) || !grants.has(session.pattern))
        return { status: "ACCESS_DENIED" };
      const site = getSiteScope((await this.api.tabs.get(tabId)).url);
      if (site?.pattern !== main.pattern || !valid())
        return { status: "DOCUMENT_CHANGED" };
      const current = await Promise.all([
        this.currentCollector(main),
        session === main
          ? Promise.resolve(true)
          : this.currentCollector(session),
      ]);
      const stillGranted = await this.grants();
      if (!stillGranted.has(main.pattern) || !stillGranted.has(session.pattern))
        return { status: "ACCESS_DENIED" };
      if (!valid() || current.some((value) => !value))
        return { status: "DOCUMENT_CHANGED" };
      const response: unknown = await this.api.tabs.sendMessage(
        tabId,
        {
          type: "reveal-target",
          documentId: session.collectorDocumentId,
          recordId: message.recordId,
        },
        { frameId },
      );
      const finalGrants = await this.grants();
      if (!finalGrants.has(main.pattern) || !finalGrants.has(session.pattern))
        return { status: "ACCESS_DENIED" };
      if (!valid()) return { status: "DOCUMENT_CHANGED" };
      const result: RevealResult = isRevealResult(response)
        ? { status: response.status }
        : { status: "REVEAL_FAILED" };
      logger.debug("Подсветка завершена", { status: result.status });
      return result;
    } catch {
      logger.warn("Не удалось связаться с целью", { code: "REVEAL_FAILED" });
      return { status: "REVEAL_FAILED" };
    }
  }

  async handleMessage(
    value: unknown,
    sender: CollectorSender,
  ): Promise<unknown> {
    if (!value || typeof value !== "object") return undefined;
    const message = value as Record<string, unknown>;
    if (
      message.type === "set-comparison-baseline" ||
      message.type === "clear-comparison-baseline"
    )
      return this.changeBaseline(message, sender);
    if (message.type === "reveal-listener-target")
      return this.revealTarget(message, sender);
    if (
      message.type === "get-site-access" ||
      message.type === "activate-site" ||
      message.type === "revoke-site"
    ) {
      if (
        sender.tab ||
        !Number.isInteger(message.tabId) ||
        (message.tabId as number) < 0
      )
        return undefined;
      const tabId = message.tabId as number;
      if (message.type === "get-site-access") return this.snapshot(tabId);
      const site = getSiteScope(
        (await this.api.tabs.get(tabId).catch(() => undefined))?.url,
      );
      if (!site || site.pattern !== message.pattern)
        return {
          tabId,
          site,
          status: "error",
          records: [],
          reason: "SITE_CHANGED",
        };
      if (message.type === "activate-site") {
        if (!(await this.grants()).has(site.pattern))
          return this.snapshot(tabId);
        this.blocked.delete(site.pattern);
        await this.reconcile();
        const current = await this.snapshot(tabId);
        if (current.site?.pattern !== site.pattern)
          return {
            tabId: current.tabId,
            site: current.site,
            records: [],
            status: "error",
            reason: "SITE_CHANGED",
          };
        logger.info("site access activated", { tabId, code: "GRANTED" });
        this.notify(tabId);
        return current;
      }
      this.generation++;
      this.invalidateScope(site.pattern);
      this.blocked.add(site.pattern);
      await this.stopPatterns(new Set([site.pattern]));
      const removed = await this.api.permissions.remove({
        origins: [site.pattern],
      });
      await this.reconcile();
      logger.info("site access revoked", {
        tabId,
        code: removed ? "REVOKED" : "REMOVE_FAILED",
      });
      const result = await this.snapshot(tabId);
      return removed
        ? result
        : { ...result, status: "error", reason: "REMOVE_FAILED" };
    }
    if (message.type === "collector-start") return this.start(message, sender);
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId === undefined || frameId === undefined) return undefined;
    const session = this.sessions.get(frameKey(tabId, frameId));
    const site = this.senderScope(sender);
    if (!session && site && message.type !== "context-reset") {
      const version = this.scopeVersion(site.pattern);
      const granted = (await this.grants()).has(site.pattern);
      const current = (await this.api.tabs
        .sendMessage(tabId, { type: "collector-status" }, { frameId })
        .catch(() => undefined)) as
        { documentId?: string; installed?: boolean } | undefined;
      if (
        granted &&
        !this.blocked.has(site.pattern) &&
        version === this.scopeVersion(site.pattern) &&
        safeMetadataId(message.documentId) &&
        current?.documentId === message.documentId &&
        current?.installed === true &&
        (sender.documentLifecycle === undefined ||
          sender.documentLifecycle === "active")
      )
        return { recover: true };
    }
    if (
      !session ||
      !site ||
      site.pattern !== session.pattern ||
      message.token !== session.token ||
      (session.nativeDocumentId &&
        sender.documentId !== session.nativeDocumentId) ||
      this.blocked.has(session.pattern)
    )
      return { stop: true };
    const version = this.scopeVersion(session.pattern);
    if (
      !(await this.grants()).has(session.pattern) ||
      this.blocked.has(session.pattern) ||
      version !== this.scopeVersion(session.pattern) ||
      this.sessions.get(frameKey(tabId, frameId)) !== session
    )
      return { stop: true };
    if (
      message.type !== "context-reset" &&
      message.type !== "collector-failed" &&
      message.type !== "collector-frames-changed" &&
      !(await this.currentCollector(session))
    ) {
      if (this.sessions.get(frameKey(tabId, frameId)) === session) {
        this.sessions.delete(frameKey(tabId, frameId));
        if (frameId === 0) this.baselines.delete(tabId);
        resetContext(tabId, session.documentId);
        this.notify(tabId);
      }
      return { stop: true };
    }
    if (
      this.sessions.get(frameKey(tabId, frameId)) !== session ||
      this.blocked.has(session.pattern) ||
      version !== this.scopeVersion(session.pattern)
    )
      return { stop: true };
    if (message.type === "collector-ready") {
      session.ready = true;
      session.partial = message.partial === true;
      this.notify(tabId);
      return { stop: false };
    }
    if (message.type === "collector-snapshot") {
      if (
        !Array.isArray(message.records) ||
        message.records.length > MAX_COLLECTOR_RECORDS
      )
        return { stop: true };
      const records = message.records
        .map((record) =>
          sanitizeListenerRecord(record, {
            tabId,
            frameId,
            documentId: session.documentId,
          }),
        )
        .filter((record) => record !== undefined);
      restoreContext(
        tabId,
        session.documentId,
        records,
        message.recordLimitReached === true,
      );
      updateContext(tabId, {
        documentId: session.documentId,
        frameId,
        contextKind: "document",
        navigationId: safeMetadataId(message.navigationId),
      });
      session.ready = true;
      session.partial = message.partial === true;
      session.failed = false;
      logger.info("collector recovery accepted", {
        tabId,
        frameId,
        count: records.length,
      });
      this.notify(tabId);
      return { stop: false };
    }
    if (message.type === "collector-failed") {
      session.failed = true;
      this.notify(tabId);
      return { stop: true };
    }
    if (message.type === "collector-frames-changed" && session.ready) {
      session.partial = message.partial === true;
      await this.pruneCollectors(tabId);
      this.notify(tabId);
      return { stop: false };
    }
    if (!session.ready) return { stop: true };
    if (!isListenerMessage(value)) return { stop: false };
    if (value.type === "listener-record" && value.record) {
      const record = sanitizeListenerRecord(value.record, {
        tabId,
        frameId,
        documentId: session.documentId,
      });
      if (!record) return { stop: false };
      if (
        message.recordLimitReached === true &&
        !record.reasonCodes.includes("RECORD_LIMIT_REACHED")
      )
        record.reasonCodes.push("RECORD_LIMIT_REACHED");
      addRecord(record);
    } else if (value.type === "context-reset") {
      if (frameId === 0) this.baselines.delete(tabId);
      if (frameId === 0) resetTabState(tabId);
      else resetContext(tabId, session.documentId);
      this.sessions.delete(frameKey(tabId, frameId));
    } else if (value.type === "context-navigation") {
      updateContext(tabId, {
        documentId: session.documentId,
        frameId,
        contextKind: "document",
        navigationId:
          typeof value.navigationId === "string" &&
          /^[a-zA-Z0-9-]{1,160}$/.test(value.navigationId)
            ? value.navigationId
            : undefined,
      });
    }
    this.notify(tabId);
    return { stop: false };
  }
}
