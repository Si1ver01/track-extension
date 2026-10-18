import type browser from "webextension-polyfill";
import { isListenerMessage } from "../shared/contracts/records";
import type {
  SiteAccessSnapshot,
  SiteScope,
} from "../shared/contracts/site-access";
import { getSiteScope, isExactSitePattern } from "../shared/site-access";
import { createLogger } from "../shared/logger";
import { createId } from "../shared/id";
import { isSupportedEventType } from "../shared/event-catalog/catalog";
import { normalizeRecord } from "../shared/records/normalize";
import type { ListenerReasonCode } from "../shared/contracts/records";
import {
  addRecord,
  getTabState,
  resetContext,
  resetTabState,
  updateContext,
} from "./tab-state";

export type SiteAccessApi = Pick<
  typeof browser,
  "permissions" | "scripting" | "tabs" | "runtime"
>;
export interface CollectorSender {
  tab?: { id?: number };
  frameId?: number;
  documentId?: string;
  url?: string;
  origin?: string;
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
const reasonCodes = new Set<ListenerReasonCode>([
  "HOOK_LATE",
  "SURFACE_UNVERIFIED",
  "RECORD_TRUNCATED",
  "RECORD_LIMIT_REACHED",
  "SOURCE_UNAVAILABLE",
  "UNSUPPORTED_CONTEXT",
  "FRAME_UNAVAILABLE",
  "NAVIGATION_RESET",
]);
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
    for (const [key, session] of this.sessions)
      if (session.tabId === tabId) this.sessions.delete(key);
    for (const [key, claim] of this.claims)
      if (key.startsWith(`${tabId}:`)) this.claims.set(key, claim + 1);
    resetTabState(tabId);
    this.notify(tabId);
  }
  private async stopPatterns(patterns: Set<string>) {
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
      await this.pruneCollectors(tabId);
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
      const partial = [...this.sessions.values()].some(
        (session) =>
          session.tabId === tabId && (session.partial || session.failed),
      );
      return {
        tabId,
        site,
        status: partial || state.status === "limited" ? "limited" : "ready",
        records: state.records,
        documentId: main.documentId,
        ...(partial ? { reason: "FRAME_PARTIAL" } : {}),
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
      tabId === undefined ||
      frameId === undefined ||
      !site ||
      typeof message.documentId !== "string" ||
      !message.documentId ||
      this.blocked.has(site.pattern)
    )
      return { allowed: false };
    const version = this.scopeVersion(site.pattern);
    const key = frameKey(tabId, frameId);
    const claim = (this.claims.get(key) ?? 0) + 1;
    this.claims.set(key, claim);
    if (!(await this.grants()).has(site.pattern)) return { allowed: false };
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
      return { allowed: false };
    if (
      version !== this.scopeVersion(site.pattern) ||
      this.claims.get(key) !== claim ||
      this.blocked.has(site.pattern)
    )
      return { allowed: false };
    const existing = this.sessions.get(key);
    if (existing?.documentId === documentId)
      return { allowed: true, token: existing.token, pattern: site.pattern };
    if (existing) resetContext(tabId, existing.documentId);
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
  async handleMessage(
    value: unknown,
    sender: CollectorSender,
  ): Promise<unknown> {
    if (!value || typeof value !== "object") return undefined;
    const message = value as Record<string, unknown>;
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
      const record = value.record;
      if (!isSupportedEventType(record.eventType)) return { stop: false };
      const safeId = (id: unknown) =>
        typeof id === "string" && /^[a-zA-Z0-9-]{1,160}$/.test(id)
          ? id
          : undefined;
      const safeBoolean = (flag: unknown) =>
        typeof flag === "boolean" ? flag : null;
      addRecord(
        normalizeRecord({
          id: safeId(record.id),
          eventType: record.eventType,
          tabId,
          frameId,
          documentId: session.documentId,
          browser: "unknown",
          contextKind:
            record.contextKind === "shadow-root" ? "shadow-root" : "document",
          source: {
            target: ["window", "document", "element"].includes(
              record.source.target,
            )
              ? record.source.target
              : "unknown",
            path: /^[a-z][a-z0-9:-]{0,79}$/.test(record.source.path)
              ? record.source.path
              : "unknown",
            sourceKind:
              record.source.sourceKind === "inline-attribute" ||
              record.source.sourceKind === "event-handler-property"
                ? record.source.sourceKind
                : "add-event-listener",
          },
          lifecycle: record.lifecycle === "removed" ? "removed" : "active",
          listenerKey: safeId(record.listenerKey),
          listenerOptions: {
            capture: safeBoolean(record.listenerOptions?.capture),
            passive: safeBoolean(record.listenerOptions?.passive),
            once: safeBoolean(record.listenerOptions?.once),
          },
          reasonCodes: [
            ...new Set<ListenerReasonCode>([
              ...(Array.isArray(record.reasonCodes)
                ? record.reasonCodes.filter((code) => reasonCodes.has(code))
                : []),
              "HOOK_LATE",
            ]),
          ],
        }),
      );
    } else if (value.type === "context-reset") {
      resetContext(tabId, session.documentId);
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
