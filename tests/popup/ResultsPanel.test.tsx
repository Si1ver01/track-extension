import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ListenerRecord } from "../../src/shared/contracts/records";
import { ResultsPanel } from "../../src/entrypoints/popup/ResultsPanel";

function record(overrides: Partial<ListenerRecord> = {}): ListenerRecord {
  return {
    id: "record-one",
    tabId: 17,
    eventType: "click",
    description: "Обработчик на кнопке",
    frameId: 0,
    documentId: "document-one",
    contextKind: "document",
    source: {
      target: "element",
      path: "button#save",
      sourceKind: "add-event-listener",
    },
    browser: "chrome",
    capturedAt: 1,
    limitations: [],
    reasonCodes: [],
    lifecycle: "active",
    ...overrides,
  };
}

function metadataValue(details: HTMLElement, label: string) {
  const term = within(details).getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent;
}

afterEach(cleanup);

function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: "Фильтры" }));
}

describe("фильтры панели результатов", () => {
  it("сочетает три фильтра с поиском и различает отдельный и общий сброс", () => {
    const match = record({
      id: "removed-frame",
      lifecycle: "removed",
      frameId: 2,
      source: { ...record().source, sourceKind: "event-handler-property" },
    });
    render(
      <ResultsPanel
        partial={false}
        records={[
          record(),
          match,
          record({ id: "other-frame", frameId: 20, lifecycle: "removed" }),
        ]}
      />,
    );
    openFilters();
    const lifecycle = screen.getByRole("combobox", {
      name: "Состояние обработчика",
    }) as HTMLSelectElement;
    const source = screen.getByRole("combobox", {
      name: "Источник регистрации",
    }) as HTMLSelectElement;
    const frame = screen.getByRole("combobox", {
      name: "Фрейм",
    }) as HTMLSelectElement;
    const search = screen.getByRole("searchbox") as HTMLInputElement;
    expect([lifecycle.value, source.value, frame.value]).toEqual([
      "all",
      "all",
      "all",
    ]);
    fireEvent.change(search, { target: { value: "click button" } });
    fireEvent.change(lifecycle, { target: { value: "removed" } });
    fireEvent.change(source, { target: { value: "event-handler-property" } });
    fireEvent.change(frame, { target: { value: "2" } });
    expect(screen.getByText("Показано записей: 1 из 3.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "click · 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить поиск" }));
    expect(search.value).toBe("");
    expect([lifecycle.value, source.value, frame.value]).toEqual([
      "removed",
      "event-handler-property",
      "2",
    ]);
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "нет-совпадений" } });
    expect(
      screen.getByText(/По выбранным фильтрам ничего не найдено/),
    ).toBeTruthy();
    expect(screen.getByText("Показано записей: 0 из 3.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect([lifecycle.value, source.value, frame.value]).toEqual([
      "all",
      "all",
      "all",
    ]);
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(screen.getByText("Показано записей: 3 из 3.")).toBeTruthy();
  });

  it("сохраняет исчезнувший frame выбранным и восстанавливает его выдачу", () => {
    const main = record();
    const frameRecord = record({
      id: "frame",
      frameId: 2,
      documentId: "child",
    });
    const { rerender } = render(
      <ResultsPanel
        partial={false}
        records={[
          record({ id: "ten", frameId: 10 }),
          frameRecord,
          main,
          { ...frameRecord, id: "second-child" },
        ]}
      />,
    );
    openFilters();
    const frame = screen.getByRole("combobox", {
      name: "Фрейм",
    }) as HTMLSelectElement;
    expect([...frame.options].map((option) => option.value)).toEqual([
      "all",
      "0",
      "2",
      "10",
    ]);
    fireEvent.change(frame, { target: { value: "2" } });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "click" },
    });
    rerender(<ResultsPanel partial={true} records={[main]} />);
    expect(frame.value).toBe("2");
    expect(frame.selectedOptions[0]!.textContent).toBe("Фрейм 2 (нет записей)");
    expect(screen.getByText("Показано записей: 0 из 1.")).toBeTruthy();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
      "click",
    );
    rerender(<ResultsPanel partial={true} records={[]} />);
    expect(frame.value).toBe("2");
    expect(screen.getByText("Пока нет данных об обработчиках.")).toBeTruthy();
    rerender(<ResultsPanel partial={false} records={[main, frameRecord]} />);
    expect(frame.value).toBe("2");
    expect(frame.selectedOptions[0]!.textContent).toBe("Фрейм 2");
    expect(screen.getByText("Показано записей: 1 из 2.")).toBeTruthy();
  });

  it("фильтрует неизвестный источник отдельно от неизвестного lifecycle", () => {
    const { container } = render(
      <ResultsPanel
        partial={false}
        records={[
          record({
            id: "missing-source",
            source: { path: "button#unknown", target: "element" },
          }),
          record({ id: "unknown-lifecycle", lifecycle: "unknown" }),
        ]}
      />,
    );
    openFilters();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Источник регистрации" }),
      { target: { value: "unknown" } },
    );
    expect(
      metadataValue(
        container.querySelector("details")!,
        "Идентификатор записи (id)",
      ),
    ).toBe("missing-source");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Состояние обработчика" }),
      { target: { value: "unknown" } },
    );
    expect(screen.getByText("Показано записей: 0 из 2.")).toBeTruthy();
  });

  it("обновляет выдачу при удалении обработчика, сохраняя выбранный фильтр", () => {
    const current = record();
    const { container, rerender } = render(
      <ResultsPanel partial={false} records={[current]} />,
    );
    openFilters();
    const lifecycle = screen.getByRole("combobox", {
      name: "Состояние обработчика",
    }) as HTMLSelectElement;
    fireEvent.change(lifecycle, { target: { value: "active" } });
    const details = container.querySelector("details")!;
    fireEvent.click(details.querySelector("summary")!);
    rerender(
      <ResultsPanel
        partial={true}
        records={[{ ...current, description: "Обновлённое описание" }]}
      />,
    );
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    rerender(
      <ResultsPanel
        partial={true}
        records={[{ ...current, lifecycle: "removed" }]}
      />,
    );
    expect(lifecycle.value).toBe("active");
    expect(container.querySelector("details")).toBeNull();
    fireEvent.change(lifecycle, { target: { value: "removed" } });
    expect(
      metadataValue(
        container.querySelector("details")!,
        "Идентификатор записи (id)",
      ),
    ).toBe(current.id);
  });

  it("пишет в DEBUG только агрегаты без запроса и метаданных", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      render(
        <ResultsPanel
          partial={false}
          records={[
            record({
              documentId: "private-document",
              source: { target: "element", path: "private-path" },
            }),
          ]}
        />,
      );
      openFilters();
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "private-query" },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Фрейм" }), {
        target: { value: "0" },
      });
      expect(debug).toHaveBeenCalled();
      for (const [message, context] of debug.mock.calls) {
        expect(message).toBe("[popup.results] Обновлены результаты");
        expect(Object.keys(context as object).sort()).toEqual([
          "activeFilterCount",
          "groupCount",
          "matchedCount",
          "totalCount",
        ]);
        expect(
          Object.values(context as object).every(
            (value) => typeof value === "number",
          ),
        ).toBe(true);
      }
      expect(debug.mock.calls.at(-1)?.[1]).toMatchObject({
        activeFilterCount: 1,
        totalCount: 1,
        matchedCount: 0,
      });
    } finally {
      debug.mockRestore();
    }
  });
});

describe("панель результатов popup", () => {
  it("группирует записи по событию и фильтрует метаданные с возможностью сброса", () => {
    render(
      <ResultsPanel
        partial={false}
        records={[
          record({ eventType: "scroll" }),
          record({ id: "click-main" }),
          record({
            id: "click-frame",
            frameId: 2,
            documentId: "document-frame",
            source: { target: "element", path: "button#cancel" },
          }),
        ]}
      />,
    );

    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((node) => node.textContent),
    ).toEqual(["click · 2", "scroll · 1"]);
    expect(screen.getByText("Показано записей: 3 из 3.")).toBeTruthy();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Поиск по метаданным" }),
      {
        target: { value: "  CLICK   cancel " },
      },
    );
    expect(screen.getByRole("heading", { name: "click · 1" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /scroll/ })).toBeNull();
    expect(screen.getByText("Показано записей: 1 из 3.")).toBeTruthy();
    expect(
      screen.getByText("button#cancel · frame 2 · document document-frame"),
    ).toBeTruthy();
    const resetButton = screen.getByRole("button", { name: "Сбросить поиск" });
    resetButton.focus();
    expect(document.activeElement).toBe(resetButton);
    fireEvent.click(resetButton);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    expect(screen.getByText("Показано записей: 3 из 3.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сбросить поиск" })).toBeNull();
  });

  it("показывает разные документы отдельными карточками и сохраняет раскрытие при обновлении", () => {
    const main = record();
    const frame = record({ frameId: 2, documentId: "document-frame" });
    const { container, rerender } = render(
      <ResultsPanel partial={false} records={[main, frame]} />,
    );
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(2);
    fireEvent.click(details[1]!.querySelector("summary")!);
    expect(details[1]!.open).toBe(true);
    rerender(
      <ResultsPanel
        partial={false}
        records={[main, { ...frame, lifecycle: "removed" }]}
      />,
    );
    const updated = container.querySelectorAll("details");
    expect(updated[1]!.open).toBe(true);
    expect(metadataValue(updated[1]!, "Состояние (lifecycle)")).toBe(
      "Удалён (removed)",
    );
    expect(
      within(updated[1]!.querySelector("summary")!).getByText(
        "Удалён (removed)",
      ),
    ).toBeTruthy();
  });

  it("различает false и неизвестные параметры и показывает доступные метаданные", () => {
    const { container } = render(
      <ResultsPanel
        partial={true}
        records={[
          record({
            lifecycle: "removed",
            navigationKind: "spa",
            navigationId: "navigation-2",
            listenerOptions: { capture: false, passive: null, once: true },
            source: {
              target: "element",
              path: "button#save",
              sourceKind: "inline-attribute",
              scriptLocation: "https://example.com/app.js:10:2",
              options: ["capture=false", "once=true"],
            },
            reasonCodes: ["HOOK_LATE"],
            limitations: ["Часть обработчиков недоступна"],
          }),
        ]}
      />,
    );
    const details = container.querySelector("details")!;
    fireEvent.click(details.querySelector("summary")!);

    expect(metadataValue(details, "capture")).toBe("false");
    expect(metadataValue(details, "passive")).toBe("Неизвестно");
    expect(metadataValue(details, "once")).toBe("true");
    expect(metadataValue(details, "Состояние (lifecycle)")).toBe(
      "Удалён (removed)",
    );
    expect(metadataValue(details, "Источник (sourceKind)")).toBe(
      "inline-attribute",
    );
    expect(
      metadataValue(details, "Расположение скрипта (scriptLocation)"),
    ).toBe("https://example.com/app.js:10:2");
    expect(metadataValue(details, "Навигация (navigationKind)")).toBe("spa");
    expect(
      metadataValue(details, "Идентификатор навигации (navigationId)"),
    ).toBe("navigation-2");
    expect(within(details).getByText("capture=false")).toBeTruthy();
    expect(within(details).getByText("HOOK_LATE")).toBeTruthy();
    expect(
      within(details).getByText("Часть обработчиков недоступна"),
    ).toBeTruthy();
  });

  it("сохраняет неизвестный lifecycle и не подменяет отсутствующие options значением false", () => {
    const { container } = render(
      <ResultsPanel
        partial={false}
        records={[record({ lifecycle: "unknown" })]}
      />,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(
      within(details.querySelector("summary")!).getByText(
        "Неизвестно (unknown)",
      ),
    ).toBeTruthy();
    expect(metadataValue(details, "Состояние (lifecycle)")).toBe(
      "Неизвестно (unknown)",
    );
    for (const option of ["capture", "passive", "once"]) {
      expect(metadataValue(details, option)).toBe("Неизвестно");
    }
  });

  it("объясняет неопределённость once и наблюдаемую регистрацию", () => {
    const { container } = render(
      <ResultsPanel
        partial={false}
        records={[
          record({
            id: "once",
            lifecycle: "unknown",
            reasonCodes: ["LIFECYCLE_UNVERIFIED"],
          }),
          record({ id: "ordinary" }),
        ]}
      />,
    );
    const details = container.querySelector("details")!;
    expect(
      within(details).getByText(
        /текущее наличие и параметры обработчика могут быть неизвестны/,
      ),
    ).toBeTruthy();
    expect(container.textContent).toContain("Регистрация наблюдалась (active)");
    openFilters();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Состояние обработчика" }),
      { target: { value: "active" } },
    );
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(container.textContent).not.toContain("LIFECYCLE_UNVERIFIED");
  });

  it("отображает недоверенные строки как текст без HTML и ссылок", () => {
    const hostile = '<img src="https://hostile.invalid/x" onerror="alert(1)">';
    const { container } = render(
      <ResultsPanel
        partial={false}
        records={[
          record({
            eventType: hostile,
            description: hostile,
            documentId: hostile,
            source: {
              target: "element",
              path: hostile,
              scriptLocation: hostile,
            },
            limitations: [hostile],
          }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      `${hostile} · 1`,
    );
    expect(container.textContent).toContain(hostile);
    expect(container.querySelector("img, script, a, iframe")).toBeNull();
  });

  it.each([
    [false, "Обработчики событий не найдены."],
    [true, "Пока нет данных об обработчиках."],
  ])(
    "показывает отдельный пустой результат при partial=%s",
    (partial, message) => {
      render(<ResultsPanel partial={partial} records={[]} />);
      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.queryByText("По запросу ничего не найдено.")).toBeNull();
      expect(screen.getByText("Показано записей: 0 из 0.")).toBeTruthy();
    },
  );

  it("отличает отсутствие совпадений от пустого снимка и сохраняет запрос при обновлении", () => {
    const { rerender } = render(
      <ResultsPanel partial={false} records={[record()]} />,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "pointerdown" },
    });
    expect(screen.getByText("По запросу ничего не найдено.")).toBeTruthy();
    expect(screen.queryByText("Обработчики событий не найдены.")).toBeNull();
    expect(screen.getByText("Показано записей: 0 из 1.")).toBeTruthy();

    rerender(
      <ResultsPanel
        partial={true}
        records={[record(), record({ id: "new", eventType: "pointerdown" })]}
      />,
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
      "pointerdown",
    );
    expect(
      screen.getByRole("heading", { name: "pointerdown · 1" }),
    ).toBeTruthy();
    expect(screen.getByText("Показано записей: 1 из 2.")).toBeTruthy();
  });
});
