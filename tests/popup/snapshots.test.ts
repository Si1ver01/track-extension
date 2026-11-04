import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSnapshotExport,
  downloadSnapshot,
} from "../../src/entrypoints/popup/snapshots";
import { normalizeRecord } from "../../src/shared/records/normalize";

function record() {
  return normalizeRecord({
    id: "record-one",
    eventType: "click",
    tabId: 1,
    frameId: 0,
    documentId: "document-one",
    contextKind: "document",
    browser: "chrome",
    capturedAt: 10,
    source: {
      target: "element",
      path: "button",
      sourceKind: "add-event-listener",
    },
    listenerOptions: { capture: false, passive: true, once: null },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Экспорт снимков", () => {
  it.each(["all", "filtered"] as const)(
    "сохраняет lifecycle reason и nullable options в version 1: %s",
    (scope) => {
      const item = {
        ...record(),
        lifecycle: "unknown" as const,
        reasonCodes: ["LIFECYCLE_UNVERIFIED" as const],
        listenerOptions: { capture: false, once: null, passive: null },
      };
      const exported = createSnapshotExport({
        records: [item],
        totalCount: 2,
        scope,
        context: { partial: false },
      });
      expect(exported.version).toBe(1);
      expect(exported.records[0]).toMatchObject({
        ...item,
        reasonCodes: expect.arrayContaining(["LIFECYCLE_UNVERIFIED"]),
      });
      expect(exported.coverage.reasons).not.toContain("LIFECYCLE_UNVERIFIED");
    },
  );
  it("повторно отбирает поля и исключает произвольные вложенные данные", () => {
    const item = record();
    Object.assign(item, {
      payload: "private-payload",
      callbackBody: "private-callback",
      description: "private-description",
      limitations: ["private-limitation"],
    });
    Object.assign(item.source, {
      value: "private-value",
      scriptLocation: "private-script",
      options: ["private-option"],
    });
    Object.defineProperty(item, "data", {
      get: () => {
        throw new Error("Не читать");
      },
    });
    const result = createSnapshotExport({
      records: [item],
      totalCount: 4,
      scope: "filtered",
      context: {
        partial: true,
        documentId: "document-one",
        coverage: {
          reasons: ["FRAME_PARTIAL", "RECORD_LIMIT_REACHED"],
          recordLimit: 200,
        },
      },
      now: new Date("2026-11-01T00:00:00Z"),
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(result).toMatchObject({
      format: "listener-lens-snapshot",
      version: 1,
      scope: "filtered",
      totalCount: 4,
      exportedCount: 1,
      omittedCount: 0,
      coverage: {
        partial: true,
        recordLimit: 200,
        reasons: ["FRAME_PARTIAL", "RECORD_LIMIT_REACHED"],
      },
    });
    expect(result.records[0]).toMatchObject({
      id: item.id,
      browser: "chrome",
      lifecycle: "active",
      listenerOptions: { capture: false, passive: true, once: null },
    });
    expect(result.warnings).toHaveLength(5);
    expect(item.description).toBe("private-description");
  });

  it("выгружает пустую выборку с метаданными и общими предупреждениями", () => {
    const result = createSnapshotExport({
      records: [],
      totalCount: 9,
      scope: "filtered",
      context: { partial: false },
    });
    expect(result.records).toEqual([]);
    expect(result.exportedCount).toBe(0);
    expect(result.totalCount).toBe(9);
    expect(result.warnings).toHaveLength(2);
  });

  it("не превращает неизвестный источник в известный и отбрасывает неподдерживаемую запись", () => {
    const item = record();
    delete item.source.sourceKind;
    const result = createSnapshotExport({
      records: [item, { ...item, eventType: "__proto__" }],
      totalCount: 2,
      scope: "all",
      context: { partial: false },
    });
    expect(result.records[0]?.source.sourceKind).toBeUndefined();
    expect(result.exportedCount).toBe(1);
    expect(result.omittedCount).toBe(1);
  });

  it("освобождает Blob URL и удаляет ссылку даже при отказе скачивания", () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:local"),
      revokeObjectURL: revoke,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("download rejected");
    });
    const result = createSnapshotExport({
      records: [],
      totalCount: 0,
      scope: "all",
      context: { partial: false },
    });
    expect(() => downloadSnapshot(result)).toThrow("download rejected");
    expect(document.querySelector("a[download]")).toBeNull();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:local");
  });
});
