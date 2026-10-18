import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SiteAccessController,
  type CollectorSender,
  type SiteAccessApi,
} from "../../src/background/site-access";
import { getTabState, resetTabState } from "../../src/background/tab-state";
import { normalizeRecord } from "../../src/shared/records/normalize";
import { describeEvent } from "../../src/shared/event-catalog/catalog";

const pattern = "https://example.test/*";
const sender: CollectorSender = {
  tab: { id: 10 },
  frameId: 0,
  documentId: "native-a",
  url: "https://example.test/page?private=1",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(origins: string[] = [pattern]) {
  let grants = [...origins];
  let registered: Array<Record<string, unknown>> = [];
  let tabs = [{ id: 10, url: sender.url }];
  const live = new Map<string, unknown>();
  const stopped = new Set<string>();
  const api = {
    permissions: {
      getAll: vi.fn(async () => ({ origins: [...grants] })),
      contains: vi.fn(async () => true),
      remove: vi.fn(async ({ origins: removed }: { origins: string[] }) => {
        grants = grants.filter((entry) => !removed.includes(entry));
        return true;
      }),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () => [...registered]),
      registerContentScripts: vi.fn(
        async (scripts: Array<Record<string, unknown>>) => {
          registered.push(...scripts);
        },
      ),
      unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => {
        registered = registered.filter(
          (entry) => !ids.includes(entry.id as string),
        );
      }),
    },
    tabs: {
      get: vi.fn(async (id: number) => tabs.find((tab) => tab.id === id)),
      query: vi.fn(async () => [...tabs]),
      sendMessage: vi.fn(
        async (
          _id: number,
          message: Record<string, unknown>,
          options?: { frameId: number },
        ) => {
          if (message.type === "collector-challenge") {
            live.set(`${_id}:${options?.frameId ?? 0}`, message.documentId);
            return {
              documentId: message.documentId,
              challenge: message.challenge,
            };
          }
          if (message.type === "collector-status")
            return {
              documentId: live.get(`${_id}:${options?.frameId ?? 0}`),
              installed: !stopped.has(`${_id}:${options?.frameId ?? 0}`),
            };
          return undefined;
        },
      ),
    },
    runtime: { sendMessage: vi.fn(async () => undefined) },
  };
  const controller = new SiteAccessController(api as unknown as SiteAccessApi);
  return {
    api,
    controller,
    setGrants(value: string[]) {
      grants = value;
    },
    setTabs(value: typeof tabs) {
      tabs = value;
    },
    getRegistrations: () => registered,
    setLive(
      tabId: number,
      frameId: number,
      documentId: string | undefined,
      installed = true,
    ) {
      live.set(`${tabId}:${frameId}`, documentId);
      if (installed) stopped.delete(`${tabId}:${frameId}`);
      else stopped.add(`${tabId}:${frameId}`);
    },
  };
}
async function start(
  controller: SiteAccessController,
  context = sender,
  documentId = "own-a",
) {
  return (await controller.handleMessage(
    { type: "collector-start", documentId },
    context,
  )) as { allowed: boolean; token?: string };
}
async function ready(
  controller: SiteAccessController,
  context = sender,
  documentId = "own-a",
) {
  const session = await start(controller, context, documentId);
  await controller.handleMessage(
    { type: "collector-ready", documentId, token: session.token },
    context,
  );
  return session;
}
function record(token: string | undefined) {
  return {
    type: "listener-record",
    token,
    documentId: "page-forged",
    record: normalizeRecord({
      eventType: "click",
      tabId: 999,
      frameId: 999,
      documentId: "page-forged",
      browser: "chrome",
      source: { target: "element", path: "button" },
    }),
  };
}
beforeEach(() => {
  resetTabState(10);
  resetTabState(11);
});

describe("persistent site access", () => {
  it("сохраняет сборщик и записи при loading того же SPA-документа", async () => {
    const { controller, setTabs } = fixture();
    const session = await ready(controller);
    const first = record(session.token);
    await controller.handleMessage(first, sender);
    setTabs([{ id: 10, url: "https://example.test/page?route=push" }]);
    await controller.handleTabLoading(10);
    expect((await controller.snapshot(10)).records[0]?.id).toBe(
      first.record.id,
    );
    const next = record(session.token);
    expect(await controller.handleMessage(next, sender)).toEqual({
      stop: false,
    });
    expect((await controller.snapshot(10)).records).toHaveLength(2);
  });

  it("очищает прежний документ при loading без живого сборщика", async () => {
    const { controller, setLive } = fixture();
    const session = await ready(controller);
    await controller.handleMessage(record(session.token), sender);
    setLive(10, 0, undefined);
    await controller.handleTabLoading(10);
    expect(getTabState(10).records).toEqual([]);
    expect(
      await controller.handleMessage(record(session.token), sender),
    ).toEqual({ stop: true });
    expect((await controller.snapshot(10)).status).toBe("reload-required");
  });

  it("поздняя проверка loading не удаляет новую сессию документа", async () => {
    const { controller, api } = fixture();
    await ready(controller);
    const pending = deferred<unknown>();
    api.tabs.sendMessage.mockImplementationOnce(
      () => pending.promise as Promise<undefined>,
    );
    const loading = controller.handleTabLoading(10);
    const nextSender = { ...sender, documentId: "native-b" };
    const next = await ready(controller, nextSender, "own-b");
    pending.resolve(undefined);
    await loading;
    expect(
      await controller.handleMessage(record(next.token), nextSender),
    ).toEqual({ stop: false });
    expect((await controller.snapshot(10)).documentId).toBe("native-b");
  });

  it("сохраняет unknown и причину ограничения реестра в production snapshot", async () => {
    const { controller } = fixture();
    const session = await ready(controller);
    const message = record(session.token);
    message.record.lifecycle = "unknown";
    message.record.reasonCodes = ["RECORD_LIMIT_REACHED"];
    await controller.handleMessage(message, sender);
    expect(await controller.snapshot(10)).toMatchObject({
      status: "limited",
      records: [{ id: message.record.id, lifecycle: "unknown" }],
      coverage: { reasons: ["RECORD_LIMIT_REACHED"] },
    });
  });

  it("снимает потерю записей при pagehide главного документа", async () => {
    const { controller } = fixture();
    const session = await ready(controller);
    const message = record(session.token);
    message.record.reasonCodes = ["RECORD_LIMIT_REACHED"];
    await controller.handleMessage(message, sender);
    await controller.handleMessage(
      { type: "context-reset", token: session.token },
      sender,
    );
    const nextSender = { ...sender, documentId: "native-b" };
    await ready(controller, nextSender, "own-b");
    expect(await controller.snapshot(10)).toMatchObject({
      status: "ready",
      records: [],
    });
    expect((await controller.snapshot(10)).coverage).toBeUndefined();
  });

  it("возвращает обе независимые причины и сохраняет overflow при обновлении", async () => {
    const { controller } = fixture();
    const session = await ready(controller);
    for (let index = 0; index < 201; index++) {
      const message = record(session.token);
      message.record.id = `record-${index}`;
      message.record.listenerKey = `listener-${index}`;
      await controller.handleMessage(message, sender);
    }
    await controller.handleMessage(
      { type: "collector-frames-changed", token: session.token, partial: true },
      sender,
    );
    const limited = await controller.snapshot(10);
    expect(limited.status).toBe("limited");
    expect(limited.coverage).toEqual({
      reasons: ["FRAME_PARTIAL", "RECORD_LIMIT_REACHED"],
      recordLimit: 200,
    });
    const update = record(session.token);
    update.record.id = "record-200";
    update.record.listenerKey = "listener-200";
    update.record.lifecycle = "removed";
    await controller.handleMessage(update, sender);
    await controller.handleMessage(
      {
        type: "collector-frames-changed",
        token: session.token,
        partial: false,
      },
      sender,
    );
    expect((await controller.snapshot(10)).coverage?.reasons).toEqual([
      "RECORD_LIMIT_REACHED",
    ]);
    const revoked = await controller.handleMessage(
      { type: "revoke-site", tabId: 10, pattern },
      {},
    );
    expect(revoked).not.toHaveProperty("coverage");
  });

  it("возвращает понятную причину для неполного покрытия без записей", async () => {
    const { controller } = fixture();
    const session = await ready(controller);
    await controller.handleMessage(
      { type: "collector-frames-changed", token: session.token, partial: true },
      sender,
    );
    expect(await controller.snapshot(10)).toMatchObject({
      records: [],
      coverage: { reasons: ["FRAME_PARTIAL"], recordLimit: 200 },
    });
  });
  it("ignores page transport commands without stopping an authenticated collector", async () => {
    const { controller } = fixture();
    const session = await ready(controller);
    expect(
      await controller.handleMessage(
        {
          source: "listener-lens",
          type: "install-bridge",
          nonce: "page-channel",
          token: session.token,
        },
        sender,
      ),
    ).toEqual({ stop: false });
    expect(
      await controller.handleMessage(record(session.token), sender),
    ).toEqual({ stop: false });
    expect(getTabState(10).records).toHaveLength(1);
  });
  it("does not turn activeTab into a persistent grant or a registration", async () => {
    const { controller, api } = fixture([]);
    await controller.reconcile();
    expect((await controller.snapshot(10)).status).toBe("no-access");
    expect(await start(controller)).toEqual({ allowed: false });
    expect(api.permissions.contains).not.toHaveBeenCalled();
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
  it("registers only exact grants and reconciles idempotently", async () => {
    const { controller, api, getRegistrations } = fixture([
      pattern,
      "<all_urls>",
      "https://*/*",
      "https://*.example.test/*",
    ]);
    await controller.reconcile();
    await controller.reconcile();
    expect(getRegistrations()).toHaveLength(1);
    expect(getRegistrations()[0]).toMatchObject({
      matches: [pattern],
      js: ["collector.js"],
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: true,
      matchOriginAsFallback: true,
    });
    expect(api.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
  });
  it("waits for registration before returning activation and requires reload", async () => {
    const { controller, api } = fixture();
    const registration = deferred<void>();
    api.scripting.registerContentScripts.mockImplementationOnce(
      () => registration.promise,
    );
    let completed = false;
    const result = controller
      .handleMessage({ type: "activate-site", tabId: 10, pattern }, {})
      .then((value) => {
        completed = true;
        return value;
      });
    await vi.waitFor(() =>
      expect(api.scripting.registerContentScripts).toHaveBeenCalled(),
    );
    expect(completed).toBe(false);
    registration.resolve();
    expect(await result).toMatchObject({
      status: "reload-required",
      records: [],
    });
  });
  it("reports registration failures and rejects a changed site before actions", async () => {
    const { controller, api } = fixture();
    api.scripting.registerContentScripts.mockRejectedValue(
      new Error("private raw failure"),
    );
    await controller.reconcile();
    expect(await controller.snapshot(10)).toMatchObject({
      status: "error",
      reason: "REGISTRATION_FAILED",
    });
    expect(
      await controller.handleMessage(
        { type: "revoke-site", tabId: 10, pattern: "https://other.test/*" },
        {},
      ),
    ).toMatchObject({ status: "error", reason: "SITE_CHANGED" });
    expect(api.permissions.remove).not.toHaveBeenCalled();
  });
  it("keeps unknown and installing collectors distinct from ready with zero records", async () => {
    const { controller } = fixture();
    expect((await controller.snapshot(10)).status).toBe("reload-required");
    const session = await start(controller);
    expect((await controller.snapshot(10)).status).toBe("recovering");
    expect(
      await controller.handleMessage(record(session.token), sender),
    ).toEqual({ stop: true });
    await controller.handleMessage(
      { type: "collector-ready", token: session.token },
      sender,
    );
    expect(await controller.snapshot(10)).toMatchObject({
      status: "ready",
      records: [],
    });
  });
  it("retries transient registration failure on the next access check", async () => {
    const { controller, api } = fixture();
    api.scripting.registerContentScripts.mockRejectedValueOnce(
      new Error("transient"),
    );
    await controller.reconcile();
    expect((await controller.snapshot(10)).status).toBe("reload-required");
    expect(api.scripting.registerContentScripts).toHaveBeenCalledTimes(2);
  });
  it("передаёт документ главного frame без его записей и при наличии только iframe-записей", async () => {
    const { controller } = fixture();
    const main = await ready(controller);
    expect(await controller.snapshot(10)).toMatchObject({
      status: "ready",
      documentId: "native-a",
      records: [],
    });

    const child = { ...sender, frameId: 2, documentId: "native-child" };
    const session = await ready(controller, child, "child-own");
    await controller.handleMessage(record(session.token), child);
    await controller.handleMessage(
      { type: "collector-frames-changed", token: main.token, partial: true },
      sender,
    );

    const snapshot = await controller.snapshot(10);
    expect(snapshot).toMatchObject({
      status: "limited",
      documentId: "native-a",
    });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      frameId: 2,
      documentId: "native-child",
    });
  });
  it("меняет documentId при замене главного документа до появления новых записей", async () => {
    const { controller } = fixture();
    await ready(controller);
    expect((await controller.snapshot(10)).documentId).toBe("native-a");

    const nextSender = { ...sender, documentId: "native-next" };
    const next = await start(controller, nextSender, "own-next");
    const installing = await controller.snapshot(10);
    expect(installing.status).toBe("recovering");
    expect(installing).not.toHaveProperty("documentId");
    await controller.handleMessage(
      { type: "collector-ready", documentId: "own-next", token: next.token },
      nextSender,
    );

    expect(await controller.snapshot(10)).toMatchObject({
      status: "ready",
      documentId: "native-next",
      records: [],
    });
  });
  it("не раскрывает прежний documentId после отзыва доступа", async () => {
    const { controller } = fixture();
    await ready(controller);
    expect((await controller.snapshot(10)).documentId).toBe("native-a");

    const revoked = await controller.handleMessage(
      { type: "revoke-site", tabId: 10, pattern },
      {},
    );
    expect(revoked).toMatchObject({ status: "no-access", records: [] });
    expect(revoked).not.toHaveProperty("documentId");
    const snapshot = await controller.snapshot(10);
    expect(snapshot.status).toBe("no-access");
    expect(snapshot).not.toHaveProperty("documentId");
  });
  it.each(["added", "removed"] as const)(
    "keeps a ready scope alive during an unrelated %s permission event",
    async (event) => {
      const { controller, api } = fixture();
      const session = await ready(controller);
      const read = deferred<{ origins: string[] }>();
      api.permissions.getAll.mockImplementationOnce(() => read.promise);
      const pending = controller.handleMessage(record(session.token), sender);
      if (event === "added")
        controller.permissionsAdded(["https://other.test/*"]);
      else controller.permissionsRemoved(["https://other.test/*"]);
      read.resolve({ origins: [pattern] });
      expect(await pending).toEqual({ stop: false });
      expect((await controller.snapshot(10)).status).toBe("ready");
    },
  );
  it("keeps startup of one scope alive while another scope is revoked", async () => {
    const { controller, api } = fixture();
    const read = deferred<{ origins: string[] }>();
    api.permissions.getAll.mockImplementationOnce(() => read.promise);
    const pending = start(controller);
    controller.permissionsRemoved(["https://other.test/*"]);
    read.resolve({ origins: [pattern] });
    expect(await pending).toMatchObject({ allowed: true });
  });
  it("clears a child context on pagehide and rejects its later records", async () => {
    const { controller } = fixture();
    await ready(controller);
    const child = { ...sender, frameId: 2, documentId: "native-child" };
    const session = await ready(controller, child, "child-own");
    await controller.handleMessage(record(session.token), child);
    await controller.handleMessage(
      { type: "context-reset", token: session.token, documentId: "child-own" },
      child,
    );
    expect(getTabState(10).records).toEqual([]);
    expect(
      await controller.handleMessage(record(session.token), child),
    ).toEqual({ stop: true });
  });
  it("prunes an orphan iframe when its parent reports a DOM change", async () => {
    const { controller, setLive } = fixture();
    const main = await ready(controller);
    const child = { ...sender, frameId: 2, documentId: "native-child" };
    const session = await ready(controller, child, "child-own");
    await controller.handleMessage(record(session.token), child);
    setLive(10, 2, undefined);
    await controller.handleMessage(
      { type: "collector-frames-changed", token: main.token, partial: true },
      sender,
    );
    expect(getTabState(10).records).toEqual([]);
    expect((await controller.snapshot(10)).status).toBe("limited");
    expect(
      await controller.handleMessage(record(session.token), child),
    ).toEqual({ stop: true });
  });
  it("reports partial coverage for a denied iframe added after initial readiness", async () => {
    const { controller } = fixture();
    const main = await ready(controller);
    expect((await controller.snapshot(10)).status).toBe("ready");
    await controller.handleMessage(
      { type: "collector-frames-changed", token: main.token, partial: true },
      sender,
    );
    expect((await controller.snapshot(10)).status).toBe("limited");
  });
  it("reports partial coverage from a nested iframe inside an allowed child", async () => {
    const { controller } = fixture();
    await ready(controller);
    const child = { ...sender, frameId: 2, documentId: "native-child" };
    const session = await ready(controller, child, "child-own");
    await controller.handleMessage(
      { type: "collector-frames-changed", token: session.token, partial: true },
      child,
    );
    expect((await controller.snapshot(10)).status).toBe("limited");
  });
  it("requires reload when a stopped BFCache collector is restored", async () => {
    const { controller, setLive } = fixture();
    await ready(controller);
    setLive(10, 0, "own-a", false);
    expect((await controller.snapshot(10)).status).toBe("reload-required");
  });
  it.each([
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseenter",
    "mouseleave",
    "mouseover",
    "mouseout",
    "dblclick",
    "contextmenu",
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointercancel",
    "pointerenter",
    "pointerleave",
    "pointerover",
    "pointerout",
    "focus",
    "blur",
    "focusin",
    "focusout",
    "wheel",
    "scroll",
    "beforeinput",
    "reset",
    "invalid",
  ])(
    "принимает %s из подтверждённой сессии и заново очищает метаданные",
    async (eventType) => {
      const { controller } = fixture();
      const session = await ready(controller);
      const incoming = record(session.token);
      const unsafe = {
        ...incoming,
        record: {
          ...incoming.record,
          eventType,
          description: "private-description",
          payload: "private-payload",
          callbackBody: "private-callback",
          source: { ...incoming.record.source, value: "private-value" },
        },
      };

      expect(await controller.handleMessage(unsafe, sender)).toEqual({
        stop: false,
      });

      const snapshot = await controller.snapshot(10);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.records).toHaveLength(1);
      expect(snapshot.records[0]).toMatchObject({
        eventType,
        description: describeEvent(eventType),
        tabId: 10,
        frameId: 0,
        documentId: "native-a",
      });
      expect(JSON.stringify(snapshot.records)).not.toContain("private-");
    },
  );
  it.each([
    "custom-event",
    "POINTERDOWN",
    "onpointerdown",
    "unknown",
    "__proto__",
    "constructor",
    "toString",
  ])(
    "отбрасывает неподдерживаемый тип %s в подтверждённой сессии",
    async (eventType) => {
      const { controller } = fixture();
      const session = await ready(controller);
      const incoming = record(session.token);

      expect(
        await controller.handleMessage(
          { ...incoming, record: { ...incoming.record, eventType } },
          sender,
        ),
      ).toEqual({ stop: false });
      expect((await controller.snapshot(10)).records).toEqual([]);
    },
  );
  it("uses native sender tab, frame and document identity for accepted records", async () => {
    const { controller } = fixture();
    const session = await ready(controller);
    await controller.handleMessage(record(session.token), sender);
    expect(getTabState(10).records[0]).toMatchObject({
      tabId: 10,
      frameId: 0,
      documentId: "native-a",
      reasonCodes: ["HOOK_LATE"],
    });
    expect(
      await controller.handleMessage(record(session.token), {
        ...sender,
        documentId: "native-late",
      }),
    ).toEqual({ stop: true });
    expect(getTabState(10).records).toHaveLength(1);
  });
  it("challenges the current frame even when the browser supplies documentId", async () => {
    const { controller, api } = fixture();
    api.tabs.sendMessage.mockResolvedValueOnce({
      documentId: "current-document",
      challenge: "wrong",
    });
    expect(await start(controller)).toEqual({ allowed: false });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        type: "collector-challenge",
        documentId: "own-a",
      }),
      { frameId: 0 },
    );
  });
  it("rejects a queued record from a document replaced by a denied document", async () => {
    const { controller, setLive } = fixture();
    const session = await ready(controller);
    setLive(10, 0, "replacement-document");
    expect(
      await controller.handleMessage(record(session.token), sender),
    ).toEqual({ stop: true });
    expect(getTabState(10).records).toEqual([]);
  });
  it("whitelists metadata instead of retaining raw page fields or trusting optional arrays", async () => {
    const { controller } = fixture();
    const session = await ready(controller);
    const incoming = record(session.token);
    const unsafe = {
      ...incoming,
      record: {
        ...incoming.record,
        payload: "secret",
        callbackBody: "secret",
        reasonCodes: undefined,
        limitations: ["secret"],
        source: {
          ...incoming.record.source,
          payload: "secret",
          scriptLocation: "https://example.test/?secret=1",
        },
      },
    };
    expect(await controller.handleMessage(unsafe, sender)).toEqual({
      stop: false,
    });
    const saved = getTabState(10).records[0];
    expect(saved).not.toHaveProperty("payload");
    expect(saved).not.toHaveProperty("callbackBody");
    expect(saved?.source).not.toHaveProperty("payload");
    expect(saved?.source.scriptLocation).toBeUndefined();
    expect(saved?.limitations).toEqual([]);
    expect(saved?.reasonCodes).toEqual(["HOOK_LATE"]);
  });
  it("rejects late collector-start after a newer document has established a session", async () => {
    const { controller, api } = fixture();
    const oldChallenge = deferred<
      { documentId: unknown; challenge: unknown } | undefined
    >();
    let oldMessage: Record<string, unknown> = {};
    api.tabs.sendMessage.mockImplementationOnce(async (_id, message) => {
      oldMessage = message;
      return oldChallenge.promise;
    });
    const oldStart = start(controller, sender, "old-own");
    await vi.waitFor(() => expect(api.tabs.sendMessage).toHaveBeenCalled());
    const currentSender = { ...sender, documentId: "native-new" };
    const current = await ready(controller, currentSender, "new-own");
    oldChallenge.resolve({
      documentId: oldMessage.documentId,
      challenge: oldMessage.challenge,
    });
    expect(await oldStart).toEqual({ allowed: false });
    expect(
      await controller.handleMessage(record(current.token), currentSender),
    ).toEqual({ stop: false });
    expect(getTabState(10).records[0]?.documentId).toBe("native-new");
  });
  it("preserves an already authenticated child when top-frame startup finishes later", async () => {
    const { controller } = fixture();
    const child = { ...sender, frameId: 3, documentId: "native-child" };
    const childSession = await ready(controller, child, "own-child");
    await ready(controller);
    expect(
      await controller.handleMessage(record(childSession.token), child),
    ).toEqual({ stop: false });
    expect(getTabState(10).records[0]?.documentId).toBe("native-child");
  });
  it("removes a registration that finished after its grant was externally revoked", async () => {
    const { controller, api, setGrants, getRegistrations } = fixture();
    const registration = deferred<void>();
    api.scripting.registerContentScripts.mockImplementationOnce(
      async (scripts) => {
        getRegistrations().push(...scripts);
        await registration.promise;
      },
    );
    const reconciliation = controller.reconcile();
    await vi.waitFor(() =>
      expect(api.scripting.registerContentScripts).toHaveBeenCalled(),
    );
    setGrants([]);
    controller.permissionsRemoved([pattern]);
    registration.resolve();
    await reconciliation;
    await controller.reconcile();
    expect(getRegistrations()).toEqual([]);
  });
  it("fails closed for opaque frames without a trusted browser origin", async () => {
    const { controller } = fixture();
    expect(
      await start(controller, { ...sender, url: "about:blank", frameId: 1 }),
    ).toEqual({ allowed: false });
    expect(
      await start(controller, {
        ...sender,
        url: "about:blank",
        origin: "https://example.test",
        frameId: 1,
      }),
    ).toMatchObject({ allowed: true });
  });
  it("revokes the selected scope in every tab and rejects late records", async () => {
    const { controller, api } = fixture();
    const secondSender = { ...sender, tab: { id: 11 }, documentId: "native-b" };
    const first = await ready(controller);
    const second = await ready(controller, secondSender, "own-b");
    await controller.handleMessage(record(first.token), sender);
    await controller.handleMessage(record(second.token), secondSender);
    const result = await controller.handleMessage(
      { type: "revoke-site", tabId: 10, pattern },
      {},
    );
    expect(result).toMatchObject({ status: "no-access", records: [] });
    expect(getTabState(10).records).toHaveLength(0);
    expect(getTabState(11).records).toHaveLength(0);
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(11, {
      type: "stop-collector",
      patterns: [pattern],
    });
    expect(await controller.handleMessage(record(first.token), sender)).toEqual(
      { stop: true },
    );
  });
  it("preserves a different granted iframe scope when the top scope is revoked", async () => {
    const other = "https://other.test/*";
    const { controller, api } = fixture([pattern, other]);
    const child = {
      ...sender,
      frameId: 2,
      documentId: "native-child",
      url: "https://other.test/page",
    };
    await ready(controller);
    const session = await ready(controller, child, "own-child");
    await controller.handleMessage(record(session.token), child);
    await controller.handleMessage(
      { type: "revoke-site", tabId: 10, pattern },
      {},
    );
    expect(getTabState(10).records[0]?.documentId).toBe("native-child");
    expect(
      await controller.handleMessage(record(session.token), child),
    ).toEqual({ stop: false });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(10, {
      type: "stop-collector",
      patterns: [pattern],
    });
  });
  it("closes ingress synchronously during external removal, including a permission read in flight", async () => {
    const { controller, api, setGrants } = fixture();
    const session = await ready(controller);
    const pendingGrants = deferred<{ origins: string[] }>();
    api.permissions.getAll.mockImplementationOnce(() => pendingGrants.promise);
    const pendingRecord = controller.handleMessage(
      record(session.token),
      sender,
    );
    setGrants([]);
    controller.permissionsRemoved([pattern]);
    pendingGrants.resolve({ origins: [pattern] });
    expect(await pendingRecord).toEqual({ stop: true });
    expect(getTabState(10).records).toHaveLength(0);
  });
  it("does not infer restored history or readiness after a service-worker restart", async () => {
    const { controller, api } = fixture();
    const session = await ready(controller);
    const restarted = new SiteAccessController(api as unknown as SiteAccessApi);
    expect((await restarted.snapshot(10)).status).toBe("reload-required");
    expect(
      await restarted.handleMessage(record(session.token), sender),
    ).toEqual({ stop: true });
  });
  it("ignores page-supplied popup actions and protected pages", async () => {
    const { controller, setTabs, api } = fixture();
    expect(
      await controller.handleMessage(
        { type: "revoke-site", tabId: 10, pattern },
        sender,
      ),
    ).toBeUndefined();
    setTabs([{ id: 10, url: "chrome://extensions" }]);
    expect((await controller.snapshot(10)).status).toBe("unsupported");
    expect(api.permissions.remove).not.toHaveBeenCalled();
  });
});
