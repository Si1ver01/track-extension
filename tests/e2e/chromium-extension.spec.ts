import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type browser from "webextension-polyfill";
import type { SiteAccessSnapshot } from "../../src/shared/contracts/site-access";
import {
  verifyDetectionCoverage,
  verifyRevokedBFCache,
} from "./detection-coverage.mjs";

type ExtensionWindow = Window & { chrome: typeof browser };
type CatalogProbeWindow = Window & {
  __listenerLensCatalogProbe?: {
    target: HTMLInputElement;
    listener: EventListener;
  };
};
type CoverageFixtureWindow = Window & {
  __coverageFixture?: { run(operation: string): Record<string, unknown> };
};

test("T-ACCESS-001 checks real collection, host isolation and revoke in Chromium", async ({
  baseURL,
}) => {
  test.setTimeout(120_000);
  const extensionPath = path.resolve(".output/chrome-mv3");
  const profilePath = await mkdtemp(
    path.join(tmpdir(), "listener-lens-chromium-"),
  );
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html`);
    const fixture = await context.newPage();
    const fixtureUrl = new URL("/site-access.html", baseURL).href;
    await fixture.goto(fixtureUrl);
    await expect(fixture.locator("body")).toHaveAttribute(
      "data-listeners-ready",
      "true",
    );
    expect(
      await control.evaluate(
        async () =>
          (
            await (
              window as unknown as ExtensionWindow
            ).chrome.permissions.getAll()
          ).origins,
      ),
    ).toEqual([]);
    expect(
      await control.evaluate(() =>
        (
          window as unknown as ExtensionWindow
        ).chrome.scripting.getRegisteredContentScripts(),
      ),
    ).toEqual([]);

    // Настройка настоящего grant через Chromium test profile; нативный диалог
    // Chrome остаётся отдельным ручным gate. Production APIs не подменяем.
    const settings = await context.newPage();
    await settings.goto("chrome://extensions/");
    const pattern = "http://localhost/*";
    await settings.evaluate(
      ({ id, origin }) =>
        new Promise<void>((resolve, reject) => {
          const api = (
            window as unknown as {
              chrome: {
                runtime: { lastError?: { message?: string } };
                developerPrivate: {
                  addHostPermission(
                    id: string,
                    origin: string,
                    callback: () => void,
                  ): void;
                };
              };
            }
          ).chrome;
          api.developerPrivate.addHostPermission(id, origin, () => {
            if (api.runtime.lastError)
              reject(new Error(api.runtime.lastError.message));
            else resolve();
          });
        }),
      { id: extensionId, origin: pattern },
    );
    await settings.close();
    await control.bringToFront();
    await control.evaluate((origin) => {
      const button = document.createElement("button");
      button.id = "test-grant";
      button.textContent = "Подтвердить тестовое разрешение";
      button.onclick = () => {
        void (window as unknown as ExtensionWindow).chrome.permissions
          .request({ origins: [origin] })
          .then((granted) => {
            document.body.dataset.testGrant = String(granted);
          });
      };
      document.body.append(button);
    }, pattern);
    await control.locator("#test-grant").click();
    await expect(control.locator("body")).toHaveAttribute(
      "data-test-grant",
      "true",
    );
    expect(
      await control.evaluate(
        async () =>
          (
            await (
              window as unknown as ExtensionWindow
            ).chrome.permissions.getAll()
          ).origins,
      ),
    ).toEqual([pattern]);
    await fixture.bringToFront();
    const tabId = await control.evaluate(
      async () =>
        (
          await (window as unknown as ExtensionWindow).chrome.tabs.query({
            active: true,
            currentWindow: true,
          })
        )[0]!.id!,
    );

    // action.openPopup создаёт настоящий extension popup, поэтому sender.tab
    // отсутствует. Страница popup.html в обычной вкладке такого sender не даёт.
    await worker.evaluate(() =>
      (globalThis as unknown as ExtensionWindow).chrome.action.openPopup(),
    );
    const popupText = () =>
      control.evaluate(() => {
        const popup = (
          window as unknown as ExtensionWindow
        ).chrome.extension.getViews({
          type: "popup",
        })[0];
        return popup?.document.body.innerText ?? "";
      });
    const snapshot = (id = tabId) =>
      control.evaluate(async (targetId) => {
        const popup = (
          window as unknown as ExtensionWindow
        ).chrome.extension.getViews({
          type: "popup",
        })[0] as ExtensionWindow;
        return popup.chrome.runtime.sendMessage({
          type: "get-site-access",
          tabId: targetId,
        }) as Promise<SiteAccessSnapshot>;
      }, id);
    const clickPopup = (label: string) =>
      control.evaluate((text) => {
        const popup = (
          window as unknown as ExtensionWindow
        ).chrome.extension.getViews({
          type: "popup",
        })[0];
        const button = Array.from(
          popup?.document.querySelectorAll("button") ?? [],
        ).find((element) => element.textContent?.trim() === text);
        if (!button) throw new Error(`Кнопка popup отсутствует: ${text}`);
        button.click();
      }, label);
    await expect.poll(popupText).toContain("Перезагрузить вкладку");
    await clickPopup("Перезагрузить вкладку");
    await expect
      .poll(async () =>
        (await snapshot()).records.some(
          (record) => record.eventType === "click" && record.frameId === 0,
        ),
      )
      .toBe(true);
    expect((await snapshot()).status).toBe("limited");
    const allowedFrames = await control.evaluate(
      (id) =>
        (window as unknown as ExtensionWindow).chrome.scripting.executeScript({
          target: { tabId: id, allFrames: true },
          func: () => location.hostname,
        }),
      tabId,
    );
    for (const frame of allowedFrames) {
      await expect
        .poll(() =>
          control.evaluate(
            async ({ id, frameId }) => {
              try {
                const status = await (
                  window as unknown as ExtensionWindow
                ).chrome.tabs.sendMessage(
                  id,
                  { type: "collector-status" },
                  { frameId },
                );
                return (status as { installed?: boolean })?.installed === true;
              } catch {
                return false;
              }
            },
            { id: tabId, frameId: frame.frameId },
          ),
        )
        .toBe(true);
    }
    await control.evaluate(
      (id) =>
        (window as unknown as ExtensionWindow).chrome.scripting.executeScript({
          target: { tabId: id, allFrames: true },
          world: "MAIN",
          func: () =>
            document
              .querySelector("#frame-button")
              ?.addEventListener("click", () => {}),
        }),
      tabId,
    );
    await expect
      .poll(async () => {
        const state = await snapshot();
        return state.records.some(
          (record) =>
            record.frameId > 0 &&
            record.documentId !== state.documentId &&
            record.source.path === "button" &&
            record.eventType === "click",
        );
      })
      .toBe(true);
    const frameState = await snapshot();
    expect(allowedFrames.length).toBe(2);
    expect(allowedFrames.every((frame) => frame.result === "localhost")).toBe(
      true,
    );
    expect(
      frameState.records.every((record) =>
        allowedFrames.some(
          (frame) =>
            frame.frameId === record.frameId &&
            frame.documentId === record.documentId,
        ),
      ),
    ).toBe(true);
    expect(frameState.coverage?.reasons).toEqual(["FRAME_PARTIAL"]);
    await expect
      .poll(popupText)
      .toContain("Покрытие встроенных фреймов ограничено");

    const readResults = () =>
      control.evaluate(() => {
        const popup = (
          window as unknown as ExtensionWindow
        ).chrome.extension.getViews({ type: "popup" })[0];
        return {
          query: popup?.document.querySelector<HTMLInputElement>(
            'input[type="search"]',
          )?.value,
          text: popup?.document.body.innerText ?? "",
          filters: Array.from(
            popup?.document.querySelectorAll<HTMLSelectElement>(
              ".results-filters select",
            ) ?? [],
            (select) => select.value,
          ),
          count: popup?.document
            .querySelector(".results-count")
            ?.textContent?.trim(),
          focusedFilter: Array.from(
            popup?.document.querySelectorAll(".results-filters select") ?? [],
          ).findIndex((select) => select === popup?.document.activeElement),
          groups: Array.from(
            popup?.document.querySelectorAll(".results-group h3") ?? [],
            (node) => node.textContent,
          ),
          cards: Array.from(
            popup?.document.querySelectorAll<HTMLDetailsElement>(
              "details.listener-record",
            ) ?? [],
            (node) => ({
              summary: node.querySelector("summary")?.textContent ?? "",
              metadata: node.querySelector("dl")?.textContent ?? "",
              open: node.open,
            }),
          ),
          fits: popup
            ? popup.document.documentElement.scrollWidth <=
              popup.document.documentElement.clientWidth
            : false,
        };
      });
    const setSearch = (query: string) =>
      control.evaluate((value) => {
        const popup = (
          window as unknown as ExtensionWindow
        ).chrome.extension.getViews({ type: "popup" })[0];
        const input = popup?.document.querySelector<HTMLInputElement>(
          'input[type="search"]',
        );
        if (!input) throw new Error("Нет поля поиска настоящего popup");
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, query);

    const setFilter = (label: string, value: string) =>
      control.evaluate(
        ({ label, value }) => {
          const popup = (
            window as unknown as ExtensionWindow
          ).chrome.extension.getViews({ type: "popup" })[0];
          const filterLabel = Array.from(
            popup?.document.querySelectorAll("label") ?? [],
          ).find((node) => node.textContent === label);
          const select =
            filterLabel &&
            (popup?.document.getElementById(
              filterLabel.htmlFor,
            ) as HTMLSelectElement | null);
          if (
            !select ||
            !Array.from(select.options).some((option) => option.value === value)
          )
            throw new Error(`Фильтр popup недоступен: ${label}`);
          Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(select),
            "value",
          )!.set!.call(select, value);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { label, value },
      );

    await expect.poll(async () => (await readResults()).query).toBe("");
    await expect
      .poll(async () => (await readResults()).filters)
      .toEqual(["all", "all", "all"]);
    // Chromium не представляет action popup как Playwright Page.
    const keyboardSession = await context.newCDPSession(control);
    const { targetInfo: controlTarget } = await keyboardSession.send(
      "Target.getTargetInfo",
    );
    const { targetInfos } = await keyboardSession.send("Target.getTargets");
    const popupTarget = targetInfos.find(
      (target) =>
        target.targetId !== controlTarget.targetId &&
        target.url === `chrome-extension://${extensionId}/popup.html`,
    );
    expect(popupTarget, "CDP видит настоящий action popup").toBeDefined();
    const { sessionId: popupSessionId } = await keyboardSession.send(
      "Target.attachToTarget",
      { targetId: popupTarget!.targetId, flatten: false },
    );
    let keyboardCommandId = 0;
    const sendPopupCommand = (
      method: string,
      params: Record<string, unknown>,
    ) =>
      keyboardSession.send("Target.sendMessageToTarget", {
        sessionId: popupSessionId,
        message: JSON.stringify({ id: ++keyboardCommandId, method, params }),
      });
    await sendPopupCommand("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    await sendPopupCommand("Page.bringToFront", {});
    await sendPopupCommand("Runtime.evaluate", {
      expression: 'document.querySelector(".results-filters select").focus()',
    });
    await expect.poll(async () => (await readResults()).focusedFilter).toBe(0);
    await sendPopupCommand("Input.dispatchKeyEvent", {
      type: "char",
      text: "У",
      unmodifiedText: "У",
    });
    await expect
      .poll(async () => (await readResults()).filters[0])
      .toBe("removed");
    for (const type of ["rawKeyDown", "keyUp"]) {
      await sendPopupCommand("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
    }
    await expect.poll(async () => (await readResults()).focusedFilter).toBe(1);
    await setFilter("Состояние обработчика", "all");
    await keyboardSession.send("Target.detachFromTarget", {
      sessionId: popupSessionId,
    });
    await keyboardSession.detach();
    await expect
      .poll(async () =>
        (await snapshot()).records.some(
          (record) =>
            record.eventType === "click" &&
            record.frameId === 0 &&
            record.source.path === "button",
        ),
      )
      .toBe(true);
    const buttonRecord = (await snapshot()).records.find(
      (record) =>
        record.eventType === "click" &&
        record.frameId === 0 &&
        record.source.path === "button",
    )!;
    await setSearch("  CLICK button  ");
    await expect
      .poll(async () => (await readResults()).cards.length)
      .toBeGreaterThan(0);
    await expect.poll(async () => (await readResults()).groups.length).toBe(1);
    expect((await readResults()).groups[0]).toMatch(/^click\s*·/);
    expect(
      (await readResults()).cards.every(
        (card) =>
          card.summary.includes("button") && card.summary.includes("click"),
      ),
    ).toBe(true);
    await setSearch("несуществующие-метаданные");
    await expect
      .poll(async () => (await readResults()).text)
      .toContain("По запросу ничего не найдено.");
    expect((await readResults()).cards).toEqual([]);
    await clickPopup("Сбросить поиск");
    await expect.poll(async () => (await readResults()).query).toBe("");
    await control.evaluate((documentId) => {
      const popup = (
        window as unknown as ExtensionWindow
      ).chrome.extension.getViews({ type: "popup" })[0];
      const card = Array.from(
        popup?.document.querySelectorAll<HTMLDetailsElement>(
          "details.listener-record",
        ) ?? [],
      ).find((node) =>
        node.querySelector("summary")?.textContent?.includes(documentId),
      );
      if (!card) throw new Error("Нет карточки главного документа");
      card.querySelector("summary")!.click();
    }, buttonRecord.documentId);
    await expect
      .poll(async () =>
        (await readResults()).cards.some(
          (card) =>
            card.open &&
            card.metadata.includes(buttonRecord.documentId) &&
            card.metadata.includes("Фрейм (frameId)"),
        ),
      )
      .toBe(true);
    expect((await readResults()).text).toContain("Источник (sourceKind)");
    expect((await readResults()).text).toContain("capture");
    expect((await readResults()).fits).toBe(true);

    // Регистрируем новые семейства в MAIN после установки настоящего hook.
    const newEventTypes = [
      "mousedown",
      "dblclick",
      "pointerdown",
      "focusin",
      "wheel",
      "scroll",
      "beforeinput",
      "reset",
      "invalid",
    ];
    await fixture.evaluate((eventTypes) => {
      const target = document.createElement("input");
      target.id = "listener-catalog-probe";
      target.value = "listener-catalog-private-input";
      document.body.append(target);
      const listener: EventListener = () => {
        const callbackPayload = "listener-catalog-callback-content";
        void callbackPayload;
      };
      (window as CatalogProbeWindow).__listenerLensCatalogProbe = {
        target,
        listener,
      };
      for (const eventType of eventTypes) {
        target.addEventListener(eventType, listener, {
          capture: true,
          passive: false,
          once: false,
        });
      }
    }, newEventTypes);
    await expect
      .poll(async () => {
        const state = await snapshot();
        return newEventTypes.every((eventType) =>
          state.records.some(
            (record) =>
              record.eventType === eventType &&
              record.frameId === 0 &&
              record.source.path === "input" &&
              record.lifecycle === "active",
          ),
        );
      })
      .toBe(true);
    const expandedCatalogState = await snapshot();
    const newRecords = expandedCatalogState.records.filter(
      (record) =>
        newEventTypes.includes(record.eventType) &&
        record.frameId === 0 &&
        record.source.path === "input",
    );
    expect(newRecords).toHaveLength(newEventTypes.length);
    for (const record of newRecords) {
      expect(record.documentId).toBe(expandedCatalogState.documentId);
      expect(record.source.sourceKind).toBe("add-event-listener");
      expect(record.listenerOptions).toEqual({
        capture: true,
        passive: false,
        once: false,
      });
      expect(record.description).toMatch(/[А-Яа-яЁё]/);
      expect(record.description).not.toContain(
        "Назначение этого типа события пока не описано",
      );
      for (const field of ["value", "payload", "data", "callbackBody"]) {
        expect(record).not.toHaveProperty(field);
        expect(record.source).not.toHaveProperty(field);
      }
    }
    expect(JSON.stringify(expandedCatalogState.records)).not.toMatch(
      /listener-catalog-private-input|listener-catalog-callback-content/,
    );
    const pointerRecord = newRecords.find(
      (record) => record.eventType === "pointerdown",
    )!;
    await setSearch("pointerdown");
    await setFilter("Состояние обработчика", "active");
    await setFilter("Источник регистрации", "add-event-listener");
    await setFilter("Фрейм", "0");
    await expect.poll(async () => (await readResults()).cards.length).toBe(1);
    await clickPopup("Запомнить снимок");
    await fixture.evaluate(() => {
      const probe = (window as CatalogProbeWindow).__listenerLensCatalogProbe!;
      probe.target.removeEventListener("pointerdown", probe.listener, true);
    });
    await expect
      .poll(async () =>
        (await snapshot()).records.some(
          (record) =>
            record.id === pointerRecord.id &&
            record.eventType === "pointerdown" &&
            record.lifecycle === "removed",
        ),
      )
      .toBe(true);
    await expect.poll(async () => (await readResults()).cards.length).toBe(0);
    await expect
      .poll(async () => (await readResults()).text)
      .toContain("active → removed");
    await expect
      .poll(async () => (await readResults()).text)
      .toContain("По выбранным фильтрам ничего не найдено");
    await setFilter("Состояние обработчика", "removed");
    await setSearch("pointerdown removed");
    await expect
      .poll(async () => (await readResults()).groups)
      .toEqual(["pointerdown · 1"]);
    expect((await readResults()).cards[0]!.summary).toContain(
      "Удалён (removed)",
    );
    expect((await readResults()).cards[0]!.metadata).toContain(
      pointerRecord.id,
    );
    const exportPopup = (label: string) =>
      control.evaluate(async (label) => {
        const popup = (
          window as unknown as ExtensionWindow
        ).chrome.extension.getViews({ type: "popup" })[0]! as Window & {
          URL: typeof URL;
          lastSnapshotExport?: Promise<string>;
        };
        const original = popup.URL.createObjectURL.bind(popup.URL);
        popup.URL.createObjectURL = (blob) => {
          popup.lastSnapshotExport = (blob as Blob).text();
          return original(blob);
        };
        try {
          const button = Array.from(
            popup.document.querySelectorAll("button"),
          ).find((node) => node.textContent?.trim() === label)!;
          button.click();
          if (!popup.lastSnapshotExport)
            throw new Error("Экспорт не создал Blob");
          return JSON.parse(await popup.lastSnapshotExport) as {
            scope: string;
            totalCount: number;
            exportedCount: number;
            records: { id: string }[];
            coverage: { partial: boolean };
          };
        } finally {
          popup.URL.createObjectURL = original;
          delete popup.lastSnapshotExport;
        }
      }, label);
    const filteredExport = await exportPopup("Экспорт выборки");
    expect(filteredExport.scope).toBe("filtered");
    expect(filteredExport.records.map((record) => record.id)).toEqual([
      pointerRecord.id,
    ]);
    expect(filteredExport.coverage.partial).toBe(true);
    const fullExport = await exportPopup("Экспорт всего снимка");
    expect(fullExport.scope).toBe("all");
    expect(fullExport.exportedCount).toBe(fullExport.totalCount);
    expect(fullExport.exportedCount).toBeGreaterThan(1);
    expect(JSON.stringify(fullExport)).not.toContain(
      "listener-catalog-private-input",
    );
    expect(JSON.stringify(fullExport)).not.toContain(
      "listener-catalog-callback-content",
    );
    await setFilter("Источник регистрации", "event-handler-property");
    await expect.poll(async () => (await readResults()).cards.length).toBe(0);
    await clickPopup("Сбросить фильтры");
    await expect.poll(async () => (await readResults()).query).toBe("");
    await expect
      .poll(async () => (await readResults()).filters)
      .toEqual(["all", "all", "all"]);
    const childFrameId = frameState.records.find(
      (record) => record.frameId > 0,
    )!.frameId;
    await setFilter("Фрейм", String(childFrameId));
    await expect
      .poll(async () => (await readResults()).cards.length)
      .toBeGreaterThan(0);
    expect(
      (await readResults()).cards.every((card) =>
        card.summary.includes(`· frame ${childFrameId} ·`),
      ),
    ).toBe(true);
    expect((await readResults()).fits).toBe(true);
    await clickPopup("Сбросить фильтры");
    await expect
      .poll(async () => (await readResults()).filters)
      .toEqual(["all", "all", "all"]);
    await expect
      .poll(async () => (await readResults()).count)
      .toBe(
        `Показано записей: ${(await snapshot()).records.length} из ${(await snapshot()).records.length}.`,
      );
    console.debug(
      JSON.stringify({
        scope: "chromium-extension",
        phase: "расширенный-каталог-и-фильтры",
        filters: "lifecycle/source/frame и сброс проверены",
        keyboard: "type-ahead и Tab проверены",
        registeredCount: newRecords.length,
        removedCount: 1,
        privacy: "проверена",
      }),
    );

    const coverageAdapter = {
      label: "chromium-extension",
      navigate: (pathname: string) =>
        fixture.goto(new URL(pathname, baseURL).href),
      run: (operation: string) =>
        fixture.evaluate(
          (name) =>
            (window as CoverageFixtureWindow).__coverageFixture?.run(name) ??
            null,
          operation,
        ),
      snapshot,
      back: () =>
        control.evaluate(
          (id) => (window as unknown as ExtensionWindow).chrome.tabs.goBack(id),
          tabId,
        ),
      reload: () => fixture.reload(),
      coverageText: popupText,
      restartBackground: async () => {
        const cdp = await context.newCDPSession(control);
        const versions = new Map<
          string,
          {
            versionId: string;
            scriptURL: string;
            runningStatus: string;
            targetId?: string;
          }
        >();
        const stoppedVersions = new Set<string>();
        cdp.on(
          "ServiceWorker.workerVersionUpdated",
          ({ versions: updates }) => {
            updates.forEach((version) => {
              versions.set(version.versionId, version);
              if (version.runningStatus === "stopped")
                stoppedVersions.add(version.versionId);
            });
          },
        );
        await cdp.send("ServiceWorker.enable");
        await expect
          .poll(() =>
            [...versions.values()].some(
              (version) =>
                version.scriptURL.startsWith(
                  `chrome-extension://${extensionId}/`,
                ) && version.runningStatus === "running",
            ),
          )
          .toBe(true);
        const previous = [...versions.values()].find(
          (version) =>
            version.scriptURL.startsWith(
              `chrome-extension://${extensionId}/`,
            ) && version.runningStatus === "running",
        )!;
        const oldWorker = context
          .serviceWorkers()
          .find((candidate) =>
            candidate.url().startsWith(`chrome-extension://${extensionId}/`),
          )!;
        await oldWorker.evaluate(() => {
          Reflect.set(globalThis, "__listenerLensRestartProbe", true);
        });
        stoppedVersions.delete(previous.versionId);
        await cdp.send("ServiceWorker.stopWorker", {
          versionId: previous.versionId,
        });
        await expect
          .poll(() => stoppedVersions.has(previous.versionId))
          .toBe(true);
        return async () => {
          await expect
            .poll(() => versions.get(previous.versionId)?.runningStatus)
            .toBe("running");
          const nextWorker = context
            .serviceWorkers()
            .find((candidate) =>
              candidate.url().startsWith(`chrome-extension://${extensionId}/`),
            )!;
          expect(
            await nextWorker.evaluate(() =>
              Reflect.has(globalThis, "__listenerLensRestartProbe"),
            ),
          ).toBe(false);
          await cdp.detach();
        };
      },
    };
    await verifyDetectionCoverage(coverageAdapter);

    const otherUrl = new URL(fixtureUrl);
    otherUrl.hostname = "127.0.0.1";
    const otherId = await control.evaluate(
      async (url) =>
        (
          await (window as unknown as ExtensionWindow).chrome.tabs.create({
            url,
            active: false,
          })
        ).id!,
      otherUrl.href,
    );
    const other = await snapshot(otherId);
    expect(other.records).toEqual([]);
    const registrations = await control.evaluate(() =>
      (
        window as unknown as ExtensionWindow
      ).chrome.scripting.getRegisteredContentScripts(),
    );
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.matches).toEqual([pattern]);
    const secondId = await control.evaluate(
      async (url) =>
        (
          await (window as unknown as ExtensionWindow).chrome.tabs.create({
            url,
            active: false,
          })
        ).id!,
      fixtureUrl,
    );
    await expect
      .poll(async () =>
        (await snapshot(secondId)).records.some(
          (record) => record.eventType === "click",
        ),
      )
      .toBe(true);

    await expect.poll(popupText).toContain("Отозвать доступ");
    await verifyRevokedBFCache({
      ...coverageAdapter,
      revoke: () => clickPopup("Отозвать доступ"),
    });
    await expect.poll(async () => (await snapshot()).records.length).toBe(0);
    await expect.poll(async () => (await readResults()).query).toBeUndefined();
    expect((await readResults()).cards).toEqual([]);
    expect((await snapshot(secondId)).records).toEqual([]);
    expect(
      await control.evaluate(
        async () =>
          (
            await (
              window as unknown as ExtensionWindow
            ).chrome.permissions.getAll()
          ).origins,
      ),
    ).toEqual([]);
    await expect
      .poll(() =>
        control.evaluate(() =>
          (
            window as unknown as ExtensionWindow
          ).chrome.scripting.getRegisteredContentScripts(),
        ),
      )
      .toEqual([]);
    await fixture.evaluate(() => window.addEventListener("copy", () => {}));
    await fixture.waitForTimeout(500);
    expect((await snapshot()).records).toEqual([]);
    console.debug(
      JSON.stringify({
        scope: "chromium-extension",
        message:
          "PASS: real popup; exact grant; real listeners; two tabs; host isolation; revoke",
        nativePermissionPrompt: "covered-by-separate-native-test",
        resultsBrowsing: "verified",
        version: context.browser()?.version(),
      }),
    );
  } finally {
    await context.close();
    await rm(profilePath, { recursive: true, force: true });
  }
});
