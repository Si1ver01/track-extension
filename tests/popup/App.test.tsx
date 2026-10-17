import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SiteAccessSnapshot } from "../../src/shared/contracts/site-access";
import type { ListenerRecord } from "../../src/shared/contracts/records";

const browserMocks = vi.hoisted(() => ({
  query: vi.fn(),
  get: vi.fn(),
  reload: vi.fn(),
  request: vi.fn(),
  sendMessage: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    tabs: {
      query: browserMocks.query,
      get: browserMocks.get,
      reload: browserMocks.reload,
    },
    permissions: { request: browserMocks.request },
    runtime: {
      sendMessage: browserMocks.sendMessage,
      onMessage: {
        addListener: browserMocks.addListener,
        removeListener: browserMocks.removeListener,
      },
    },
  },
}));

import { App } from "../../src/entrypoints/popup/App";

const site = { pattern: "https://example.com/*", label: "https://example.com" };
const record: ListenerRecord = {
  id: "one",
  tabId: 17,
  eventType: "click",
  description: "Обработчик на кнопке",
  frameId: 2,
  documentId: "document-one",
  contextKind: "document",
  source: { path: "button#save", target: "element" },
  browser: "chrome",
  capturedAt: 1,
  limitations: [],
  lifecycle: "active",
  reasonCodes: [],
};

function snapshot(
  status: SiteAccessSnapshot["status"],
  records: ListenerRecord[] = [],
): SiteAccessSnapshot {
  return {
    tabId: 17,
    site: status === "unsupported" ? null : site,
    status,
    records,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function notify(tabId = 17) {
  const listener = browserMocks.addListener.mock.calls[0]![0] as (
    message: unknown,
  ) => void;
  await act(async () => listener({ type: "site-access-updated", tabId }));
}

describe("popup site access", () => {
  beforeEach(() => {
    Object.values(browserMocks).forEach((mock) => mock.mockReset());
    browserMocks.query.mockResolvedValue([
      { id: 17, url: "https://example.com/page" },
    ]);
    browserMocks.get.mockResolvedValue({
      id: 17,
      url: "https://example.com/page",
    });
    browserMocks.reload.mockResolvedValue(undefined);
    browserMocks.request.mockResolvedValue(true);
    browserMocks.sendMessage.mockResolvedValue(snapshot("no-access"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows loading and requests the active tab snapshot", async () => {
    const response = deferred<SiteAccessSnapshot>();
    browserMocks.sendMessage.mockReturnValue(response.promise);
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain(
      "Проверяем доступ",
    );
    await waitFor(() =>
      expect(browserMocks.sendMessage).toHaveBeenCalledWith({
        type: "get-site-access",
        tabId: 17,
      }),
    );
    await act(async () => response.resolve(snapshot("ready")));
    expect(screen.getByText("Обработчики событий не найдены.")).toBeTruthy();
  });

  it("does not offer access to unsupported pages", async () => {
    browserMocks.sendMessage.mockResolvedValue(snapshot("unsupported"));
    render(<App />);
    expect(
      await screen.findByText(/На этой странице расширение недоступно/),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(browserMocks.request).not.toHaveBeenCalled();
  });

  it("retries a failed state request", async () => {
    browserMocks.sendMessage.mockResolvedValue(undefined);
    render(<App />);
    expect(
      await screen.findByText(/Не удалось получить состояние вкладки/),
    ).toBeTruthy();
    browserMocks.sendMessage.mockResolvedValue(snapshot("no-access"));
    fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
    expect(
      await screen.findByRole("button", { name: "Разрешить для этого сайта" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Не удалось получить/)).toBeNull();
  });

  it("requests only the prepared site synchronously in the click handler", async () => {
    const permission = deferred<boolean>();
    browserMocks.request.mockReturnValue(permission.promise);
    render(<App />);
    const button = await screen.findByRole("button", {
      name: "Разрешить для этого сайта",
    });
    browserMocks.sendMessage.mockResolvedValue(snapshot("reload-required"));
    fireEvent.click(button);
    expect(browserMocks.request).toHaveBeenCalledExactlyOnceWith({
      origins: [site.pattern],
    });
    expect(browserMocks.sendMessage).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    expect(browserMocks.request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain(
      "Подтвердите доступ",
    );
    await act(async () => permission.resolve(true));
    expect(browserMocks.sendMessage).toHaveBeenLastCalledWith({
      type: "activate-site",
      tabId: 17,
      pattern: site.pattern,
    });
    expect(
      screen.getByRole("button", { name: "Перезагрузить вкладку" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(browserMocks.reload).not.toHaveBeenCalled();
  });

  it("treats denial as a normal result and allows a new request", async () => {
    browserMocks.request.mockResolvedValue(false);
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Разрешить для этого сайта" }),
    );
    expect(await screen.findByText(/Доступ не предоставлен/)).toBeTruthy();
    expect(browserMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole("button", {
          name: "Разрешить для этого сайта",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText("Обработчики событий не найдены.")).toBeNull();
  });

  it.each(["async", "sync"])(
    "shows a safe error after a %s permission API failure",
    async (kind) => {
      if (kind === "sync")
        browserMocks.request.mockImplementation(() => {
          throw new Error("sensitive URL");
        });
      else browserMocks.request.mockRejectedValue(new Error("sensitive URL"));
      render(<App />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Разрешить для этого сайта",
        }),
      );
      expect(
        await screen.findByText(/Не удалось разрешить доступ/),
      ).toBeTruthy();
      expect(screen.queryByText("sensitive URL")).toBeNull();
      expect(
        (
          screen.getByRole("button", {
            name: "Разрешить для этого сайта",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    },
  );

  it("reloads only the original tab after checking its site", async () => {
    browserMocks.sendMessage.mockResolvedValue(snapshot("reload-required"));
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Перезагрузить вкладку" }),
    );
    await waitFor(() =>
      expect(browserMocks.reload).toHaveBeenCalledExactlyOnceWith(17),
    );
    expect(browserMocks.get).toHaveBeenCalledWith(17);
    expect(await screen.findByText(/Ожидаем готовности страницы/)).toBeTruthy();
    expect(screen.queryByText("Обработчики событий не найдены.")).toBeNull();
  });

  it("does not reload a tab that navigated to another site", async () => {
    browserMocks.sendMessage
      .mockResolvedValueOnce(snapshot("reload-required"))
      .mockResolvedValue(snapshot("no-access"));
    browserMocks.get.mockResolvedValue({
      id: 17,
      url: "https://another.example/page",
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Перезагрузить вкладку" }),
    );
    expect(
      await screen.findByRole("button", { name: "Разрешить для этого сайта" }),
    ).toBeTruthy();
    expect(browserMocks.reload).not.toHaveBeenCalled();
  });

  it("does not reload while a navigation to another site is pending", async () => {
    browserMocks.sendMessage.mockResolvedValue(snapshot("reload-required"));
    browserMocks.get.mockResolvedValue({
      id: 17,
      url: "https://example.com/page",
      pendingUrl: "https://another.example/page",
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Перезагрузить вкладку" }),
    );
    await waitFor(() => expect(browserMocks.get).toHaveBeenCalledWith(17));
    expect(browserMocks.reload).not.toHaveBeenCalled();
  });

  it("handles a closed tab during reload", async () => {
    browserMocks.sendMessage.mockResolvedValue(snapshot("reload-required"));
    browserMocks.get.mockRejectedValue(new Error("closed"));
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Перезагрузить вкладку" }),
    );
    expect(
      await screen.findByText(/Не удалось перезагрузить вкладку/),
    ).toBeTruthy();
    expect(browserMocks.reload).not.toHaveBeenCalled();
  });

  it("revokes access through the background and removes collected records", async () => {
    browserMocks.sendMessage
      .mockResolvedValueOnce(snapshot("ready", [record]))
      .mockResolvedValue(snapshot("no-access"));
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /^click\b/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отозвать доступ" }));
    expect(
      await screen.findByRole("button", { name: "Разрешить для этого сайта" }),
    ).toBeTruthy();
    expect(browserMocks.sendMessage).toHaveBeenLastCalledWith({
      type: "revoke-site",
      tabId: 17,
      pattern: site.pattern,
    });
    expect(screen.queryByRole("heading", { name: /^click\b/ })).toBeNull();
  });

  it("updates an open popup after external revocation and ignores other tabs", async () => {
    browserMocks.sendMessage.mockResolvedValue(snapshot("ready", [record]));
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /^click\b/ }),
    ).toBeTruthy();
    await notify(99);
    expect(browserMocks.sendMessage).toHaveBeenCalledTimes(1);
    browserMocks.sendMessage.mockResolvedValue(snapshot("no-access"));
    await notify();
    expect(screen.queryByRole("heading", { name: /^click\b/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Разрешить для этого сайта" }),
    ).toBeTruthy();
  });

  it("ignores an older snapshot that resolves after revocation", async () => {
    browserMocks.sendMessage.mockResolvedValue(snapshot("ready", [record]));
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /^click\b/ }),
    ).toBeTruthy();
    const olderState = deferred<SiteAccessSnapshot>();
    browserMocks.sendMessage.mockReturnValueOnce(olderState.promise);
    await notify();
    browserMocks.sendMessage.mockResolvedValue(snapshot("no-access"));
    fireEvent.click(screen.getByRole("button", { name: "Отозвать доступ" }));
    expect(
      await screen.findByRole("button", { name: "Разрешить для этого сайта" }),
    ).toBeTruthy();
    await act(async () => olderState.resolve(snapshot("ready", [record])));
    expect(screen.queryByRole("heading", { name: /^click\b/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Разрешить для этого сайта" }),
    ).toBeTruthy();
  });

  it("preserves record metadata and never confirms emptiness for limited results", async () => {
    browserMocks.sendMessage.mockResolvedValue(snapshot("limited", [record]));
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: /^click\b/ }),
    ).toBeTruthy();
    expect(
      screen.getByText("button#save · frame 2 · document document-one"),
    ).toBeTruthy();
    browserMocks.sendMessage.mockResolvedValue(snapshot("limited"));
    await notify();
    expect(screen.getByText("Пока нет данных об обработчиках.")).toBeTruthy();
    expect(screen.queryByText("Обработчики событий не найдены.")).toBeNull();
  });

  it("сохраняет поиск при обновлении записей и смене полноты в том же документе", async () => {
    const mainRecord = {
      ...record,
      id: "main",
      frameId: 0,
      documentId: "main-document",
    };
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("ready", [record]),
      documentId: "main-document",
    });
    render(<App />);
    const search = await screen.findByRole("searchbox", {
      name: "Поиск по метаданным",
    });
    fireEvent.change(search, { target: { value: "click" } });
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("limited", [record, mainRecord]),
      documentId: "main-document",
    });
    await notify();
    expect((search as HTMLInputElement).value).toBe("click");
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("limited", [record]),
      documentId: "main-document",
    });
    await notify();
    expect(screen.getByRole("searchbox")).toBe(search);
    expect((search as HTMLInputElement).value).toBe("click");
  });

  it("сбрасывает поиск при смене главного документа даже без его записей", async () => {
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("limited", [record]),
      documentId: "main-before",
    });
    render(<App />);
    const search = await screen.findByRole("searchbox");
    fireEvent.change(search, { target: { value: "нет-совпадений" } });
    expect(screen.getByText("По запросу ничего не найдено.")).toBeTruthy();
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("limited", [{ ...record, documentId: "frame-after" }]),
      documentId: "main-after",
    });
    await notify();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("heading", { name: /^click\b/ })).toBeTruthy();
    expect(screen.queryByText("По запросу ничего не найдено.")).toBeNull();
  });

  it("сбрасывает поиск при смене сайта и после отзыва с повторной выдачей", async () => {
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("ready", [record]),
      documentId: "main",
    });
    render(<App />);
    fireEvent.change(await screen.findByRole("searchbox"), {
      target: { value: "click" },
    });
    const otherSite = {
      pattern: "https://other.example/*",
      label: "https://other.example",
    };
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("ready", [record]),
      site: otherSite,
      documentId: "main",
    });
    await notify();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "click" },
    });
    browserMocks.sendMessage.mockResolvedValue(snapshot("no-access"));
    fireEvent.click(screen.getByRole("button", { name: "Отозвать доступ" }));
    await screen.findByRole("button", { name: "Разрешить для этого сайта" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    browserMocks.sendMessage.mockResolvedValue({
      ...snapshot("ready", [record]),
      documentId: "main-after-regrant",
    });
    await notify();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });

  it("stops readiness polling at its deadline and retries", async () => {
    vi.useFakeTimers();
    browserMocks.sendMessage.mockResolvedValue(snapshot("recovering"));
    render(<App />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText(/Страница не подтвердила готовность/)).toBeTruthy();
    const calls = browserMocks.sendMessage.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(browserMocks.sendMessage).toHaveBeenCalledTimes(calls);
    browserMocks.sendMessage.mockResolvedValue(snapshot("ready"));
    fireEvent.click(screen.getByRole("button", { name: "Повторить проверку" }));
    await act(async () => {});
    expect(screen.getByText("Обработчики событий не найдены.")).toBeTruthy();
  });

  it("cleans up its listener and pending grant when the popup closes", async () => {
    const permission = deferred<boolean>();
    browserMocks.request.mockReturnValue(permission.promise);
    const { unmount } = render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Разрешить для этого сайта" }),
    );
    unmount();
    await act(async () => permission.resolve(true));
    expect(browserMocks.removeListener).toHaveBeenCalledWith(
      browserMocks.addListener.mock.calls[0]![0],
    );
    expect(browserMocks.sendMessage).toHaveBeenCalledTimes(1);
  });
});
