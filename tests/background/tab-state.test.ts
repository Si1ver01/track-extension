import { describe, expect, it } from "vitest";
import {
  addRecord,
  getTabState,
  resetTabState,
} from "../../src/background/tab-state";
import { normalizeRecord } from "../../src/shared/records/normalize";

describe("tab state", () => {
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
