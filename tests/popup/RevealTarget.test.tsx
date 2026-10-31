import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RevealTarget } from "../../src/entrypoints/popup/RevealTarget";
import { normalizeRecord } from "../../src/shared/records/normalize";

const record = normalizeRecord({
  id: "one",
  tabId: 1,
  frameId: 2,
  documentId: "frame",
  eventType: "click",
  browser: "chrome",
  source: { target: "element", path: "button" },
});
afterEach(cleanup);
describe("Действие перехода к цели", () => {
  it("блокирует повторный запрос и показывает результат", async () => {
    let finish!: (result: { status: "REVEALED" }) => void;
    const action = vi.fn(
      () =>
        new Promise<{ status: "REVEALED" }>((resolve) => {
          finish = resolve;
        }),
    );
    render(<RevealTarget record={record} onReveal={action} />);
    fireEvent.click(screen.getByRole("button"));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(action).toHaveBeenCalledExactlyOnceWith(record);
    finish({ status: "REVEALED" });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Элемент подсвечен",
      ),
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
  it.each([
    "TARGET_UNAVAILABLE",
    "DOCUMENT_CHANGED",
    "ACCESS_DENIED",
    "TIMEOUT",
    "SHADOW_HOST",
  ] as const)("объясняет исход %s", async (status) => {
    render(
      <RevealTarget record={record} onReveal={async () => ({ status })} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("status")).textContent).toBeTruthy();
  });
  it("не предлагает подсветку window и document", () => {
    const { rerender } = render(
      <RevealTarget
        record={{ ...record, source: { target: "window", path: "window" } }}
        onReveal={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <RevealTarget
        record={{ ...record, source: { target: "document", path: "document" } }}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
