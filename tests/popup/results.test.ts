import { describe, expect, it } from "vitest";
import { projectResults } from "../../src/entrypoints/popup/results";
import type { ListenerRecord } from "../../src/shared/contracts/records";

function record(overrides: Partial<ListenerRecord> = {}): ListenerRecord {
  return {
    id: "listener-1",
    eventType: "click",
    description: "Нажатие кнопки",
    tabId: 3,
    frameId: 17,
    documentId: "document-main",
    contextKind: "document",
    source: {
      path: "button#save",
      target: "element",
      sourceKind: "add-event-listener",
    },
    browser: "chrome",
    capturedAt: 100,
    limitations: [],
    lifecycle: "active",
    reasonCodes: [],
    ...overrides,
  };
}

describe("Проекция результатов popup", () => {
  it("возвращает пустые группы и нулевые счётчики без записей", () => {
    expect(projectResults([], "click")).toEqual({
      groups: [],
      totalCount: 0,
      matchedCount: 0,
    });
  });

  it.each(["", " \t\n "])(
    "показывает все записи при пустом запросе %j, включая удалённые",
    (query) => {
      const active = record();
      const removed = record({ id: "listener-2", lifecycle: "removed" });

      expect(projectResults([active, removed], query)).toEqual({
        groups: [{ eventType: "click", records: [active, removed] }],
        totalCount: 2,
        matchedCount: 2,
      });
    },
  );

  it("нормализует регистр и пробелы и требует все слова в одной записи", () => {
    const match = record();
    const other = record({
      id: "listener-2",
      eventType: "keydown",
      description: "Ввод клавиши",
    });

    expect(projectResults([match, other], "  CLICK\tНАЖАТИЕ\n#SAVE  ")).toEqual(
      {
        groups: [{ eventType: "click", records: [match] }],
        totalCount: 2,
        matchedCount: 1,
      },
    );
    expect(projectResults([match, other], "click клавиши")).toEqual({
      groups: [],
      totalCount: 2,
      matchedCount: 0,
    });
  });

  it.each([
    "click",
    "нажатие",
    "#save",
    "element",
    "add-event-listener",
    "17",
    "document-main",
    "shadow-root",
    "removed",
  ])("ищет по разрешённым метаданным: %s", (query) => {
    const match = record({ contextKind: "shadow-root", lifecycle: "removed" });

    const result = projectResults([match], query);

    expect(result.matchedCount).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.records[0]).toBe(match);
  });

  it("сортирует типы независимо от локали и сохраняет записи разных frame и document", () => {
    const first = record({ frameId: 4, documentId: "document-first" });
    const second = record({ frameId: 5, documentId: "document-second" });
    const unknown = record({ eventType: "unknown", contextKind: "unknown" });
    const special = record({ eventType: "__proto__" });
    const capital = record({ eventType: "Z" });
    const unicode = record({ eventType: "ä" });
    const records = [unknown, unicode, first, special, second, capital, first];

    const result = projectResults(records, "");

    expect(result.groups.map((group) => group.eventType)).toEqual([
      "Z",
      "__proto__",
      "click",
      "unknown",
      "ä",
    ]);
    expect(result.groups).toHaveLength(5);
    const clicks = result.groups[2]!.records;
    expect(clicks).toHaveLength(3);
    expect(clicks[0]).toBe(first);
    expect(clicks[1]).toBe(second);
    expect(clicks[2]).toBe(first);
    expect(result.totalCount).toBe(7);
    expect(result.matchedCount).toBe(7);
    expect(projectResults(records, "5 document-second").groups).toEqual([
      { eventType: "click", records: [second] },
    ]);
  });

  it("не ищет по payload, callback, URL, scriptLocation и прочим полям вне списка", () => {
    const unsearchable = "private-needle";
    const input = {
      ...record(),
      id: unsearchable,
      navigationId: unsearchable,
      navigationKind: "spa" as const,
      limitations: [unsearchable],
      listenerKey: unsearchable,
      source: {
        ...record().source,
        scriptLocation: `https://${unsearchable}.test/script.js`,
        options: [unsearchable],
      },
      payload: unsearchable,
      callback: unsearchable,
      url: `https://${unsearchable}.test/`,
      arbitrary: unsearchable,
    };

    expect(projectResults([input], unsearchable)).toEqual({
      groups: [],
      totalCount: 1,
      matchedCount: 0,
    });
    expect(projectResults([input], "spa chrome 100").matchedCount).toBe(0);
  });

  it("не обращается к посторонним полям с опасными getter", () => {
    const input = record();
    const fail = () => {
      throw new Error("Посторонние поля читать нельзя");
    };
    Object.defineProperties(input, {
      payload: { enumerable: true, get: fail },
      callback: { enumerable: true, get: fail },
      url: { enumerable: true, get: fail },
    });
    Object.defineProperty(input.source, "scriptLocation", {
      enumerable: true,
      get: fail,
    });

    expect(projectResults([input], "click").matchedCount).toBe(1);
  });

  it("не изменяет входной массив, вложенные метаданные и идентичность записей", () => {
    const first = record({ eventType: "keydown" });
    const second = record();
    for (const input of [first, second]) {
      Object.freeze(input.source);
      Object.freeze(input.limitations);
      Object.freeze(input.reasonCodes);
      Object.freeze(input);
    }
    const records = Object.freeze([first, second]);

    const result = projectResults(records, "element");

    expect(records[0]).toBe(first);
    expect(records[1]).toBe(second);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.records[0]).toBe(second);
    expect(result.groups[1]!.records[0]).toBe(first);
    result.groups[0]!.records.pop();
    expect(records).toHaveLength(2);
    expect(second.source.path).toBe("button#save");
  });
});
