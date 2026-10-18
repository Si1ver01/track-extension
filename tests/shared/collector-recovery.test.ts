import { describe, expect, it, vi } from "vitest";
import { CollectorRecovery } from "../../src/shared/collector-recovery";
import { MAX_COLLECTOR_RECORDS } from "../../src/shared/contracts/collector";
import { normalizeRecord } from "../../src/shared/records/normalize";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(
  id = "listener-a",
  lifecycle: "active" | "removed" = "active",
) {
  return {
    type: "listener-record",
    record: normalizeRecord({
      id,
      eventType: "click",
      tabId: 99,
      frameId: 99,
      documentId: "forged-document",
      browser: "chrome",
      source: { target: "element", path: "button" },
      lifecycle,
    }),
  };
}

function fixture() {
  let starts = 0;
  const install = vi.fn(async () => {});
  const stop = vi.fn();
  const send = vi.fn(
    async (value: Record<string, unknown>): Promise<unknown> => {
      if (value.type === "collector-start")
        return {
          allowed: true,
          token: `token-${++starts}`,
          pattern: "https://example.test/*",
        };
      return { stop: false };
    },
  );
  const collector = new CollectorRecovery({
    documentId: "document-a",
    send,
    install,
    stop,
    partial: () => false,
  });
  const snapshots = () =>
    send.mock.calls
      .map(([value]) => value)
      .filter((value) => value.type === "collector-snapshot");
  const deliveries = () =>
    send.mock.calls
      .map(([value]) => value)
      .filter((value) => value.type === "listener-record");
  return { collector, install, stop, send, snapshots, deliveries };
}

describe("восстановление транспорта сборщика", () => {
  it("кэширует только очищенные метаданные и подставляет документ сборщика", async () => {
    const { collector, snapshots } = fixture();
    const value = message();
    Object.assign(value.record, {
      payload: "private-payload",
      callbackBody: "private-callback",
      description: "private-description",
      limitations: ["private-limit"],
    });
    Object.assign(value.record.source, {
      value: "private-value",
      scriptLocation: "https://private.test/secret",
      path: "button[data-secret=private-path]",
    });
    collector.accept(value);
    await collector.connect();
    const snapshot = snapshots().at(-1)!;
    expect(JSON.stringify(snapshot)).not.toMatch(/private-|forged-document/);
    expect(snapshot.records).toEqual([
      expect.objectContaining({
        id: "listener-a",
        documentId: "document-a",
        tabId: 0,
        frameId: 0,
        source: expect.objectContaining({ path: "unknown" }),
      }),
    ]);
  });

  it("сохраняет последнее удалённое состояние одного ID до установки hook", async () => {
    const { collector, install, snapshots } = fixture();
    collector.accept(message());
    collector.accept(message("listener-a", "removed"));
    await collector.connect();
    expect(install).toHaveBeenCalledTimes(1);
    expect(snapshots().at(-1)?.records).toEqual([
      expect.objectContaining({ id: "listener-a", lifecycle: "removed" }),
    ]);
  });

  it("обозначает потерю только после вытеснения и сохраняет лимит при replay", async () => {
    const { collector, snapshots } = fixture();
    for (let index = 0; index < MAX_COLLECTOR_RECORDS; index++)
      collector.accept(message(`record-${index}`));
    await collector.connect();
    expect(snapshots().at(-1)?.recordLimitReached).toBe(false);
    collector.pause();
    collector.accept(message("record-extra"));
    collector.accept(message("record-1", "removed"));
    await collector.resume();
    const snapshot = snapshots().at(-1)!;
    expect(snapshot.recordLimitReached).toBe(true);
    expect(snapshot.records).toHaveLength(MAX_COLLECTOR_RECORDS);
    expect(snapshot.records).not.toContainEqual(
      expect.objectContaining({ id: "record-0" }),
    );
    expect(snapshot.records).toContainEqual(
      expect.objectContaining({ id: "record-1", lifecycle: "removed" }),
    );
  });

  it("объединяет конкурентные подключения и повторно не устанавливает hook", async () => {
    const { collector, send, install } = fixture();
    await Promise.all([
      collector.connect(),
      collector.connect(),
      collector.connect(),
    ]);
    expect(
      send.mock.calls.filter(([value]) => value.type === "collector-start"),
    ).toHaveLength(1);
    await collector.connect();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("восстанавливает снимок после recover-ответа на живую регистрацию", async () => {
    const { collector, send, snapshots, install } = fixture();
    collector.accept(message());
    await collector.connect();
    send.mockResolvedValueOnce({ recover: true });
    collector.accept(message("listener-b"));
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2));
    expect(snapshots()[1]?.records).toHaveLength(2);
    expect(snapshots()[1]?.token).toBe("token-2");
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("приостанавливает транспорт и восстанавливает те же ID после BFCache", async () => {
    const { collector, send, snapshots, install } = fixture();
    collector.accept(message());
    await collector.connect();
    collector.pause();
    expect(collector.status.installed).toBe(false);
    const count = send.mock.calls.length;
    collector.accept(message("listener-a", "removed"));
    expect(send).toHaveBeenCalledTimes(count);
    await collector.resume();
    expect(collector.status.installed).toBe(true);
    expect(snapshots()[1]).toMatchObject({
      token: "token-2",
      records: [
        expect.objectContaining({ id: "listener-a", lifecycle: "removed" }),
      ],
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("доставляет новое удаление после снимка, который ещё находится в пути", async () => {
    const { collector, send, snapshots, deliveries } = fixture();
    const gate = deferred<unknown>();
    send.mockImplementation(async (value) => {
      if (value.type === "collector-start")
        return {
          allowed: true,
          token: "token-1",
          pattern: "https://example.test/*",
        };
      if (value.type === "collector-snapshot") return gate.promise;
      return { stop: false };
    });
    collector.accept(message());
    const connecting = collector.connect();
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1));
    collector.accept(message("listener-a", "removed"));
    gate.resolve({ stop: false });
    await connecting;
    await vi.waitFor(() => expect(deliveries()).toHaveLength(1));
    expect(deliveries()[0]?.record).toMatchObject({
      id: "listener-a",
      lifecycle: "removed",
    });
  });

  it("игнорирует запоздалый stop старого поколения после возобновления", async () => {
    const { collector, send, deliveries, stop } = fixture();
    await collector.connect();
    const gate = deferred<unknown>();
    send.mockImplementationOnce(async () => gate.promise);
    collector.accept(message());
    collector.pause();
    await collector.resume();
    gate.resolve({ stop: true });
    await Promise.resolve();
    collector.accept(message("listener-b"));
    await vi.waitFor(() => expect(deliveries()).toHaveLength(2));
    expect(stop).not.toHaveBeenCalled();
    expect(collector.status.installed).toBe(true);
    expect(deliveries()[1]?.token).toBe("token-2");
  });

  it("окончательно очищает кэш и hook после отказа в повторной авторизации", async () => {
    const { collector, send, snapshots, stop } = fixture();
    collector.accept(message());
    await collector.connect();
    collector.pause();
    send.mockResolvedValueOnce({ allowed: false });
    await collector.resume();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(collector.status.installed).toBe(false);
    collector.accept(message("late-listener"));
    await collector.connect();
    expect(snapshots()).toHaveLength(1);
  });

  it("не устанавливает hook после stop во время авторизации", async () => {
    const { collector, send, install, stop } = fixture();
    const gate = deferred<unknown>();
    send.mockImplementationOnce(async () => gate.promise);
    const connecting = collector.connect();
    collector.stop();
    gate.resolve({
      allowed: true,
      token: "late-token",
      pattern: "https://example.test/*",
    });
    await connecting;
    expect(install).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("повторяет временно неудачное подключение и не держит heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const { collector, send, snapshots } = fixture();
      send.mockRejectedValueOnce(new Error("worker unavailable"));
      await collector.connect();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(snapshots()).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("сообщает об ошибке установки и завершает сбор", async () => {
    const { collector, install, send, stop } = fixture();
    install.mockRejectedValueOnce(new Error("script blocked"));
    await collector.connect();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(send.mock.calls).toContainEqual([
      expect.objectContaining({ type: "collector-failed", token: "token-1" }),
    ]);
  });

  it("повторяет авторизацию после сброса навигации, сохраняя hook и кэш", async () => {
    vi.useFakeTimers();
    try {
      const { collector, send, snapshots, install, stop } = fixture();
      collector.accept(message());
      await collector.connect();
      collector.pause();
      send.mockResolvedValueOnce({
        allowed: false,
        recover: true,
        code: "CLAIM_SUPERSEDED",
      });
      await collector.resume();
      collector.accept(message("listener-a", "removed"));
      expect(stop).not.toHaveBeenCalled();
      expect(snapshots()).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(snapshots()).toHaveLength(2);
      expect(snapshots()[1]?.records).toEqual([
        expect.objectContaining({ id: "listener-a", lifecycle: "removed" }),
      ]);
      expect(install).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("соблюдает задержку повтора после ошибки доставки при новых регистрациях", async () => {
    vi.useFakeTimers();
    try {
      const { collector, send, snapshots } = fixture();
      await collector.connect();
      send.mockRejectedValueOnce(new Error("worker unavailable"));
      collector.accept(message("listener-b"));
      await vi.advanceTimersByTimeAsync(0);
      collector.accept(message("listener-c"));
      await vi.advanceTimersByTimeAsync(99);
      expect(snapshots()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshots()).toHaveLength(2);
      expect(snapshots()[1]?.records).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("сохраняет только последний безопасный navigation ID", async () => {
    const { collector, snapshots } = fixture();
    collector.accept({
      type: "context-navigation",
      navigationId: "route-a",
      payload: "private-navigation",
    });
    collector.accept({ type: "context-navigation", navigationId: "route-b" });
    await collector.connect();
    expect(snapshots()[0]?.navigationId).toBe("route-b");
    expect(JSON.stringify(snapshots())).not.toContain("private-navigation");
  });
});
