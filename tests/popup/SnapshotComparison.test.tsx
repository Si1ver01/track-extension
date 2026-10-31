import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResultsPanel } from "../../src/entrypoints/popup/ResultsPanel";
import { normalizeRecord } from "../../src/shared/records/normalize";

afterEach(cleanup);

describe("Сравнение в popup", () => {
  it("сравнивает весь снимок, сохраняет baseline при обновлении и позволяет заменить или сбросить его", () => {
    const first = normalizeRecord({
      id: "one",
      tabId: 1,
      frameId: 0,
      documentId: "main",
      eventType: "click",
      browser: "chrome",
      source: { target: "element", path: "button" },
    });
    const missing = { ...first, id: "missing" };
    const refresh = vi.fn();
    const { rerender } = render(
      <ResultsPanel
        records={[first, missing]}
        partial={true}
        onRefresh={refresh}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "нет-совпадений" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Запомнить снимок" }));
    first.lifecycle = "removed";
    rerender(
      <ResultsPanel
        records={[first, { ...first, id: "added" }]}
        partial={false}
        onRefresh={refresh}
      />,
    );
    expect(
      screen.getByRole("status").textContent?.replace(/\s/g, " "),
    ).toContain("Добавлено: 1. Нет в текущем снимке: 1. Изменено: 1.");
    expect(screen.getByText("active → removed")).toBeTruthy();
    expect(
      screen.getByText(/Один из\s+снимков имеет неполное покрытие/),
    ).toBeTruthy();
    expect(screen.getByText("По запросу ничего не найдено.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Обновить снимок" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Заменить базовый снимок" }),
    );
    expect(screen.getByText(/Добавлено: 0\./).textContent).toContain(
      "Изменено: 0",
    );
    expect(screen.getByText(/Без изменений: 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить сравнение" }));
    expect(screen.queryByText(/Без изменений:/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Запомнить снимок" }),
    ).toBeTruthy();
  });
});
