import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import type { ComparisonBaseline } from "../../src/shared/contracts/site-access";
import type { ListenerRecord } from "../../src/shared/contracts/records";
import { copySnapshotRecords } from "../../src/shared/records/snapshot";
import { ResultsPanel } from "../../src/entrypoints/popup/ResultsPanel";
import { normalizeRecord } from "../../src/shared/records/normalize";

afterEach(cleanup);

function ComparisonPanel({
  records,
  partial,
  onRefresh,
}: {
  records: ListenerRecord[];
  partial: boolean;
  onRefresh: () => void;
}) {
  const [baseline, setBaseline] = useState<ComparisonBaseline | null>(null);
  return (
    <ResultsPanel
      records={records}
      partial={partial}
      onRefresh={onRefresh}
      baseline={baseline}
      onBaselineChange={async (capture) => {
        setBaseline(
          capture
            ? {
                documentId: "main",
                records: copySnapshotRecords(records),
                capturedAt: 1,
                partial,
              }
            : null,
        );
        return true;
      }}
    />
  );
}

describe("Сравнение в popup", () => {
  it("сравнивает весь снимок, сохраняет baseline при обновлении и позволяет заменить или сбросить его", async () => {
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
      <ComparisonPanel
        records={[first, missing]}
        partial={true}
        onRefresh={refresh}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "нет-совпадений" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Запомнить снимок" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Заменить базовый снимок",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    first.lifecycle = "removed";
    rerender(
      <ComparisonPanel
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
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Заменить базовый снимок",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.getByText(/Добавлено: 0\./).textContent).toContain(
      "Изменено: 0",
    );
    expect(screen.getByText(/Без изменений: 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить сравнение" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Запомнить снимок",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(/Без изменений:/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Запомнить снимок" }),
    ).toBeTruthy();
  });

  it("сохраняет фильтры и разрешает повторить неудачное сохранение", async () => {
    const change = vi.fn(async () => false);
    render(
      <ResultsPanel records={[]} partial={false} onBaselineChange={change} />,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "click" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Запомнить снимок" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Не удалось изменить базовый снимок",
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
      "click",
    );
    fireEvent.click(screen.getByRole("button", { name: "Запомнить снимок" }));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
  });
});
