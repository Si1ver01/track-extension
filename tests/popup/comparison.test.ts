import { describe, expect, it } from "vitest";
import {
  compareSnapshots,
  copySnapshotRecords,
} from "../../src/entrypoints/popup/comparison";
import { normalizeRecord } from "../../src/shared/records/normalize";
import type { ListenerRecord } from "../../src/shared/contracts/records";

function record(overrides: Partial<ListenerRecord> = {}) {
  return normalizeRecord({
    id: "listener-one",
    eventType: "click",
    tabId: 1,
    frameId: 0,
    documentId: "main",
    browser: "chrome",
    source: {
      target: "element",
      path: "button",
      sourceKind: "add-event-listener",
    },
    ...overrides,
  });
}

describe("Сравнение снимков", () => {
  it("сравнивает uncertain once, неоднозначные options и подтверждённое удаление", () => {
    const original = record({
      lifecycle: "unknown",
      reasonCodes: ["LIFECYCLE_UNVERIFIED"],
      listenerOptions: { capture: false, once: true, passive: true },
    });
    const baseline = copySnapshotRecords([original]);
    original.listenerOptions = { capture: false, once: null, passive: null };
    expect(compareSnapshots(baseline, [original]).changed[0]?.fields).toEqual([
      { name: "passive", before: "true", after: "unknown" },
      { name: "once", before: "true", after: "unknown" },
    ]);
    const removed = {
      ...original,
      lifecycle: "removed" as const,
      reasonCodes: [],
    };
    const result = compareSnapshots(baseline, [removed]);
    expect(result.added).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(result.changed[0]?.fields).toContainEqual({
      name: "lifecycle",
      before: "unknown",
      after: "removed",
    });
    expect(
      result.changed[0]?.fields.some((field) => field.name === "reasonCodes"),
    ).toBe(true);
    expect(baseline[0]?.reasonCodes).toEqual(["LIFECYCLE_UNVERIFIED"]);
    expect(baseline[0]?.listenerOptions?.once).toBe(true);
  });
  it("разделяет added, missing, changed и unchanged по полной identity", () => {
    const first = record();
    const frame = record({ frameId: 2, documentId: "child" });
    const shadow = record({ contextKind: "shadow-root" });
    const after = [
      record({ lifecycle: "removed" }),
      record({ frameId: 2, documentId: "child-new" }),
      shadow,
    ];
    const result = compareSnapshots([first, frame, shadow], after);
    expect(result.added).toEqual([after[1]]);
    expect(result.missing).toEqual([frame]);
    expect(result.changed).toEqual([
      {
        before: first,
        after: after[0],
        fields: [{ name: "lifecycle", before: "active", after: "removed" }],
      },
    ]);
    expect(result.unchanged).toBe(1);
  });

  it("показывает значения изменившихся параметров и источника", () => {
    const before = record({
      listenerOptions: { capture: false, passive: null, once: true },
    });
    const after = record({
      source: {
        target: "element",
        path: "input",
        sourceKind: "event-handler-property",
      },
      listenerOptions: { capture: true, passive: false, once: null },
    });
    expect(compareSnapshots([before], [after]).changed[0]?.fields).toEqual([
      { name: "source.path", before: "button", after: "input" },
      {
        name: "source.sourceKind",
        before: "add-event-listener",
        after: "event-handler-property",
      },
      { name: "capture", before: "false", after: "true" },
      { name: "passive", before: "unknown", after: "false" },
      { name: "once", before: "true", after: "unknown" },
    ]);
  });

  it("игнорирует capturedAt и порядок reasonCodes", () => {
    const before = record({
      capturedAt: 1,
      reasonCodes: ["HOOK_LATE", "SOURCE_UNAVAILABLE"],
    });
    const after = record({
      capturedAt: 99,
      reasonCodes: ["SOURCE_UNAVAILABLE", "HOOK_LATE"],
    });
    expect(compareSnapshots([before], [after])).toMatchObject({
      changed: [],
      unchanged: 1,
    });
    expect(before.reasonCodes).toEqual(["HOOK_LATE", "SOURCE_UNAVAILABLE"]);
  });

  it("сохраняет независимую очищенную копию baseline", () => {
    const original = record({
      listenerOptions: { capture: true, passive: false, once: null },
    });
    const copied = copySnapshotRecords([original]);
    original.lifecycle = "removed";
    original.source.path = "input";
    original.listenerOptions!.capture = false;
    original.reasonCodes.push("RECORD_LIMIT_REACHED");
    expect(copied[0]).toMatchObject({
      lifecycle: "active",
      source: { path: "button" },
      listenerOptions: { capture: true },
      reasonCodes: [],
    });
    expect(compareSnapshots([], []).unchanged).toBe(0);
  });
});
