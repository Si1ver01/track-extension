import { describe, expect, it } from "vitest";
import {
  addRecord,
  MAX_TAB_RECORDS,
  getTabState,
  resetTabState,
  resetContext,
} from "../../src/background/tab-state";
import { normalizeRecord } from "../../src/shared/records/normalize";

describe("tab state", () => {
  it("различает заполненный буфер и фактическую потерю записей", () => {
    const make = (index: number) =>
      normalizeRecord({
        id: `record-${index}`,
        tabId: 31,
        frameId: 0,
        browser: "chrome",
        eventType: "click",
        documentId: "limit-document",
        listenerKey: `listener-${index}`,
        source: { target: "element", path: "button" },
      });
    try {
      for (let index = 0; index < MAX_TAB_RECORDS; index++)
        addRecord(make(index));
      expect(getTabState(31).status).toBe("ready");
      const replacement = { ...make(0), lifecycle: "removed" as const };
      addRecord(replacement);
      expect(getTabState(31).status).toBe("ready");
      addRecord(make(MAX_TAB_RECORDS));
      expect(getTabState(31).records).toHaveLength(MAX_TAB_RECORDS);
      expect(
        getTabState(31).records.some((record) => record.id === "record-0"),
      ).toBe(false);
      expect(getTabState(31).recordLimitReached).toBe(true);
      addRecord({ ...make(MAX_TAB_RECORDS), lifecycle: "removed" });
      expect(getTabState(31).status).toBe("limited");
      resetContext(31, "limit-document");
      expect(getTabState(31).records).toHaveLength(0);
      expect(getTabState(31).recordLimitReached).toBe(true);
      resetTabState(31);
      expect(getTabState(31).recordLimitReached).toBeUndefined();
    } finally {
      resetTabState(31);
    }
  });

  it("сохраняет ограничение реестра даже до заполнения tab buffer", () => {
    try {
      const base = {
        tabId: 32,
        frameId: 0,
        browser: "chrome" as const,
        source: { target: "window" as const, path: "window" },
      };
      addRecord(
        normalizeRecord({
          ...base,
          eventType: "click",
          reasonCodes: ["RECORD_LIMIT_REACHED"],
        }),
      );
      addRecord(normalizeRecord({ ...base, eventType: "keydown" }));
      expect(getTabState(32).records).toHaveLength(2);
      expect(getTabState(32).status).toBe("limited");
    } finally {
      resetTabState(32);
    }
  });
  it("groups records by tab and resets them", () => {
    addRecord(
      normalizeRecord({
        eventType: "click",
        tabId: 3,
        frameId: 0,
        browser: "chrome",
        source: { target: "window", path: "/" },
      }),
    );
    expect(getTabState(3).records).toHaveLength(1);
    resetTabState(3);
    expect(getTabState(3).records).toHaveLength(0);
  });

  it("deduplicates records by document, frame, target and listener identity", () => {
    const base = normalizeRecord({
      eventType: "click",
      tabId: 4,
      frameId: 1,
      documentId: "doc-a",
      listenerKey: "listener-a",
      browser: "chrome",
      source: { target: "element", path: "button" },
    });
    addRecord(base);
    addRecord({ ...base, id: "replacement" });
    addRecord({ ...base, documentId: "doc-b" });
    expect(getTabState(4).records).toHaveLength(2);
    resetTabState(4);
  });
});
