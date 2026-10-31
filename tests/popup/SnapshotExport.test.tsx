import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResultsPanel } from "../../src/entrypoints/popup/ResultsPanel";
import * as snapshots from "../../src/entrypoints/popup/snapshots";
import { normalizeRecord } from "../../src/shared/records/normalize";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Экспорт из панели", () => {
  it("применяет текущие фильтры только к экспорту выборки", () => {
    const download = vi
      .spyOn(snapshots, "downloadSnapshot")
      .mockImplementation(() => {});
    const records = ["active", "removed"].map((lifecycle, index) =>
      normalizeRecord({
        id: `listener-${index}`,
        tabId: 1,
        frameId: 0,
        documentId: "main",
        eventType: "click",
        browser: "chrome",
        source: { target: "element", path: "button" },
        lifecycle: lifecycle as "active" | "removed",
      }),
    );
    render(
      <ResultsPanel
        records={records}
        partial={true}
        coverage={{ reasons: ["FRAME_PARTIAL"], recordLimit: 200 }}
        documentId="main"
      />,
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Состояние обработчика" }),
      { target: { value: "removed" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Экспорт выборки" }));
    expect(download.mock.calls[0]?.[0]).toMatchObject({
      scope: "filtered",
      totalCount: 2,
      exportedCount: 1,
      documentId: "main",
      records: [{ id: "listener-1" }],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Экспорт всего снимка" }),
    );
    expect(download.mock.calls[1]?.[0]).toMatchObject({
      scope: "all",
      totalCount: 2,
      exportedCount: 2,
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Файл подготовлен",
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Экспорт выборки" }));
    expect(download.mock.calls[2]?.[0].records).toEqual([]);
  });

  it("показывает отказ без утечки исключения", () => {
    vi.spyOn(snapshots, "downloadSnapshot").mockImplementation(() => {
      throw new Error("private-failure");
    });
    render(<ResultsPanel records={[]} partial={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Экспорт всего снимка" }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Не удалось сохранить JSON. Повторите попытку.",
    );
  });
});
