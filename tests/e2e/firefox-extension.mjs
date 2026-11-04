import assert from "node:assert/strict";
import path from "node:path";
import {
  popupRevealProbe,
  revealProbe,
  verifyTargetReveal,
} from "./reveal-targets.mjs";
import {
  verifyDetectionCoverage,
  verifyRevokedBFCache,
} from "./detection-coverage.mjs";
import {
  extensionUuid,
  launchFirefoxExtension,
  poll,
} from "./firefox-driver.mjs";
import { startFixtureServer } from "./start-fixture-server.mjs";

const { server, port } = await startFixtureServer();
const fixtureUrl = `http://localhost:${port}/site-access.html`;
const otherUrl = `http://127.0.0.1:${port}/site-access.html`;
const pattern = "http://localhost/*";
let driver;

try {
  driver = await launchFirefoxExtension();
  const { call, execute, executeAsync } = driver;
  await call("Marionette:SetContext", { value: "chrome" });
  // Тестовая сборка выключает этот механизм при старте. Включаем после
  // запуска; реальное восстановление подтверждает общий сценарий по pageshow.
  const environment =
    await execute(`Services.prefs.setBoolPref('fission.bfcacheInParent', true);
    return { version: Services.appinfo.version, bfcache: Services.prefs.getBoolPref('fission.bfcacheInParent') };`);
  assert.equal(environment.bfcache, true);
  console.debug(
    JSON.stringify({
      scope: "firefox-extension",
      phase: "окружение",
      ...environment,
    }),
  );
  await execute(
    `const tab = gBrowser.addTab(arguments[0], {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
  }); gBrowser.selectedTab = tab;`,
    [`moz-extension://${extensionUuid}/popup.html`],
  );
  await call("Marionette:SetContext", { value: "content" });
  const handles = await call("WebDriver:GetWindowHandles");
  let popupHandle = handles.at(-1);
  await call("WebDriver:SwitchToWindow", { handle: popupHandle });
  await poll(
    () => execute("return typeof browser === 'object';"),
    Boolean,
    "Extension page unavailable",
  );
  const api = (script, args = []) => executeAsync(script, args);
  const origins = () =>
    api("return (await browser.permissions.getAll()).origins;");
  const scripts = () =>
    api("return browser.scripting.getRegisteredContentScripts();");
  async function openActionPopup(tabId) {
    await api("await browser.tabs.update(arguments[0], { active: true });", [
      tabId,
    ]);
    await call("Marionette:SetContext", { value: "chrome" });
    await execute(`const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const extension = ExtensionParent.GlobalManager.getExtension("listener-lens@example.invalid");
      ExtensionParent.apiManager.global.browserActionFor(extension).triggerAction(window);`);
    await call("Marionette:SetContext", { value: "content" });
    await poll(
      () => api("return browser.extension.getViews({type: 'popup'}).length;"),
      Boolean,
      "Firefox action popup unavailable",
    );
  }
  async function message(request) {
    if (
      !(await api("return browser.extension.getViews({type: 'popup'}).length;"))
    ) {
      await openActionPopup(request.tabId);
    }
    return api(
      "return browser.extension.getViews({type: 'popup'})[0].browser.runtime.sendMessage(arguments[0]);",
      [request],
    );
  }
  const snapshot = (tabId) => message({ type: "get-site-access", tabId });
  const popupResults = () =>
    api(`const popup = browser.extension.getViews({type: 'popup'})[0];
      if (!popup) return null;
      const document = popup.document;
      const panel = document.querySelector('[role="tabpanel"]:not([hidden])') || document;
      const input = document.querySelector('input[type="search"]');
      return {
        search: input && {
          value: input.value,
          label: document.querySelector('label[for="' + input.id + '"]')?.textContent.trim()
        },
        groups: [...panel.querySelectorAll('h3')].map(group => group.textContent.trim()),
        count: panel.querySelector('.results-count')?.textContent.trim(),
        filters: [...panel.querySelectorAll('.results-filters select')].map(select => select.value),
        text: document.body.innerText,
        records: [...panel.querySelectorAll('details.listener-record')].map(record => ({
          eventType: record.querySelector('.record-event')?.textContent.trim(),
          context: record.querySelector('.record-context')?.textContent.trim(),
          open: record.open,
          metadata: Object.fromEntries([...record.querySelectorAll('.record-metadata > div')]
            .map(row => [row.querySelector('dt').textContent.trim(), row.querySelector('dd').textContent.trim()]))
        }))
      };`);
  async function searchPopup(query) {
    await api(
      `const popup = browser.extension.getViews({type: 'popup'})[0];
      const input = popup.document.querySelector('input[type="search"]');
      if (!input) throw new Error('Поле поиска настоящего popup недоступно');
      Object.getOwnPropertyDescriptor(popup.HTMLInputElement.prototype, 'value').set.call(input, arguments[0]);
      input.dispatchEvent(new popup.Event('input', {bubbles: true}));`,
      [query],
    );
  }
  async function selectPopupTab(label) {
    await api(
      `const popup = browser.extension.getViews({type: 'popup'})[0];
      const tab = [...popup.document.querySelectorAll('[role="tab"]')].find(node => node.textContent.trim() === arguments[0]);
      if (!tab) throw new Error('Вкладка настоящего popup недоступна: ' + arguments[0]);
      tab.dispatchEvent(new popup.MouseEvent('mousedown', {bubbles: true, button: 0}));
      await new Promise(resolve => popup.setTimeout(resolve, 0));`,
      [label],
    );
  }
  async function filterPopup(label, value) {
    await api(
      `const popup = browser.extension.getViews({type: 'popup'})[0];
      const filterToggle = popup.document.querySelector('button[aria-label="Фильтры"]');
      if (filterToggle?.getAttribute('aria-expanded') !== 'true') {
        filterToggle?.click();
        await new Promise(resolve => popup.setTimeout(resolve, 0));
      }
      const label = [...popup.document.querySelectorAll('label')].find(node => node.textContent === arguments[0]);
      const select = label && popup.document.getElementById(label.htmlFor);
      if (!select || ![...select.options].some(option => option.value === arguments[1])) throw new Error('Фильтр настоящего popup недоступен');
      Object.getOwnPropertyDescriptor(popup.HTMLSelectElement.prototype, 'value').set.call(select, arguments[1]);
      select.dispatchEvent(new popup.Event('change', {bubbles: true}));`,
      [label, value],
    );
  }
  const fixture = await api(
    "return browser.tabs.create({ url: arguments[0], active: false });",
    [fixtureUrl],
  );
  const other = await api(
    "return browser.tabs.create({ url: arguments[0], active: false });",
    [otherUrl],
  );
  assert.deepEqual(await origins(), []);
  assert.deepEqual(await scripts(), []);

  // Встроенный обработчик action выдаёт только временный activeTab.
  await openActionPopup(fixture.id);
  assert.deepEqual(
    await origins(),
    [],
    "activeTab must not become a persistent origin grant",
  );
  assert.equal((await snapshot(fixture.id)).status, "no-access");
  assert.deepEqual(await scripts(), []);
  console.debug(
    JSON.stringify({
      scope: "firefox-extension",
      message: "activeTab verified",
      persistentOrigins: [],
    }),
  );

  async function permissionPrompt(allow) {
    await call("WebDriver:SwitchToWindow", { handle: popupHandle });
    await execute(
      `document.querySelector('#test-grant')?.remove();
      delete document.body.dataset.testGrant;
      const button = document.createElement('button');
      button.id = 'test-grant'; button.textContent = 'Проверить запрос разрешения';
      button.onclick = () => browser.permissions.request({ origins: [arguments[0]] })
        .then(value => { document.body.dataset.testGrant = String(value); },
          error => { document.body.dataset.testGrant = String(error); });
      document.body.append(button);`,
      [pattern],
    );
    const element = (
      await call("WebDriver:FindElement", {
        using: "css selector",
        value: "#test-grant",
      })
    ).value;
    await call("WebDriver:ElementClick", {
      id: element["element-6066-11e4-a52e-4f735466cecf"],
    });
    await call("Marionette:SetContext", { value: "chrome" });
    const displayedOrigins = await poll(
      () =>
        execute(
          "return document.querySelector('#addon-webext-perm-list-required')?.textContent ?? '';",
        ),
      (text) => text.includes("localhost"),
      "Native Firefox optional-permissions prompt unavailable",
    );
    assert.match(displayedOrigins, /localhost/);
    const buttonClass = allow
      ? "popup-notification-primary-button"
      : "popup-notification-secondary-button";
    await execute(
      "document.querySelector('#addon-webext-permissions-notification .' + arguments[0]).click();",
      [buttonClass],
    );
    await call("Marionette:SetContext", { value: "content" });
    await poll(
      () => execute("return document.body.dataset.testGrant;"),
      (value) => value === String(allow),
      "Native permission result unavailable",
    );
  }

  await permissionPrompt(false);
  assert.deepEqual(await origins(), []);
  assert.deepEqual(await scripts(), []);
  assert.equal((await snapshot(fixture.id)).records.length, 0);
  await permissionPrompt(true);
  assert.deepEqual(await origins(), [pattern]);
  const activated = await message({
    type: "activate-site",
    tabId: fixture.id,
    pattern,
  });
  assert.equal(activated.status, "reload-required");
  const registered = await scripts();
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].matches, [pattern]);
  const secondFixture = await api(
    "return browser.tabs.create({ url: arguments[0], active: false });",
    [fixtureUrl],
  );
  await api("await browser.tabs.reload(arguments[0]);", [fixture.id]);
  const collected = await poll(
    () => snapshot(fixture.id),
    (state) =>
      state.records.some(
        (record) => record.eventType === "click" && record.frameId === 0,
      ),
    "Firefox failed to capture a real click listener",
  );
  assert.ok(["ready", "limited"].includes(collected.status));
  const allowedDocuments = await api(
    "return browser.scripting.executeScript({target:{tabId:arguments[0],allFrames:true},func:()=>location.hostname});",
    [fixture.id],
  );
  for (const frame of allowedDocuments) {
    await poll(
      () =>
        api(
          `try {
      const status = await browser.tabs.sendMessage(arguments[0], {type: 'collector-status'}, {frameId: arguments[1]});
      return status?.installed === true;
    } catch { return false; }`,
          [fixture.id, frame.frameId],
        ),
      Boolean,
      "Firefox не установил сборщик разрешённого фрейма",
    );
  }
  await api(
    `return browser.scripting.executeScript({
    target: {tabId: arguments[0], allFrames: true}, world: 'MAIN',
    func: () => document.querySelector('#frame-button')?.addEventListener('click', () => {})
  });`,
    [fixture.id],
  );
  const frameState = await poll(
    () => snapshot(fixture.id),
    (state) =>
      state.records.some(
        (record) =>
          record.frameId > 0 &&
          record.documentId !== state.documentId &&
          record.source.path === "button" &&
          record.eventType === "click",
      ),
    "Firefox не собрал отдельный документ разрешённого iframe",
  );
  assert.deepEqual(frameState.coverage?.reasons, ["FRAME_PARTIAL"]);
  assert.ok(allowedDocuments.length >= 2);
  assert.ok(allowedDocuments.every((frame) => frame.result === "localhost"));
  assert.ok(
    frameState.records.every((record) =>
      allowedDocuments.some(
        (frame) =>
          frame.frameId === record.frameId &&
          frame.documentId === record.documentId,
      ),
    ),
  );
  await poll(
    () => snapshot(secondFixture.id),
    (state) => state.records.some((record) => record.eventType === "click"),
    "Firefox failed to collect in a second authorized tab",
  );
  assert.equal((await snapshot(other.id)).records.length, 0);

  // Проверяем результаты настоящего action popup на записях установленного add-on.
  const buttonRecord = collected.records.find(
    (record) =>
      record.eventType === "click" &&
      record.frameId === 0 &&
      record.source.path === "button",
  );
  assert.ok(
    buttonRecord,
    "Firefox не собрал обработчик кнопки основной страницы",
  );
  await api(
    "browser.extension.getViews({type: 'popup'}).forEach(view => view.close());",
  );
  await poll(
    () => api("return browser.extension.getViews({type: 'popup'}).length;"),
    (count) => count === 0,
    "Firefox не закрыл предыдущий action popup",
  );
  await openActionPopup(fixture.id);
  const initialResults = await poll(
    popupResults,
    (results) =>
      results?.records.some((record) => record.eventType === "click"),
    "Настоящий popup Firefox не показал собранные записи",
  );
  assert.equal(initialResults.search.label, "Поиск по метаданным");
  assert.match(initialResults.text, /Покрытие встроенных фреймов ограничено/);
  assert.ok(
    initialResults.groups.some((group) => group.startsWith("click · ")),
  );

  await searchPopup("click button");
  const filteredResults = await poll(
    popupResults,
    (results) =>
      results?.records.length > 0 &&
      results.records.every(
        (record) =>
          record.eventType === "click" &&
          record.context.startsWith("button · "),
      ) &&
      results.records.length < initialResults.records.length,
    "Поиск Firefox не оставил только обработчики click на button",
  );
  assert.ok(
    filteredResults.records.some(
      (record) =>
        record.metadata["Документ (documentId)"] === buttonRecord.documentId &&
        record.metadata["Фрейм (frameId)"] === "0",
    ),
    "Поиск Firefox потерял обработчик кнопки основной страницы",
  );

  await searchPopup("несуществующий-обработчик-2026");
  await poll(
    popupResults,
    (results) =>
      results?.records.length === 0 &&
      results.text.includes("По запросу ничего не найдено."),
    "Firefox не показал пустой результат поиска",
  );
  await api(`const popup = browser.extension.getViews({type: 'popup'})[0];
    const reset = [...popup.document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Сбросить поиск');
    if (!reset) throw new Error('Кнопка сброса поиска недоступна');
    reset.click();`);
  const restoredResults = await poll(
    popupResults,
    (results) =>
      results?.search?.value === "" &&
      results.records.length === initialResults.records.length,
    "Firefox не восстановил карточки после сброса поиска",
  );
  assert.deepEqual(restoredResults.groups, initialResults.groups);
  assert.equal(restoredResults.count, initialResults.count);
  await api(
    `const popup = browser.extension.getViews({type: 'popup'})[0];
    const record = [...popup.document.querySelectorAll('details.listener-record')]
      .find(record => record.querySelector('.record-context')?.textContent.trim() === arguments[0]);
    if (!record) throw new Error('Карточка обработчика основной страницы недоступна');
    record.querySelector('summary').click();`,
    [`button · frame 0 · document ${buttonRecord.documentId}`],
  );
  const expandedResults = await poll(
    popupResults,
    (results) =>
      results?.records.some(
        (record) =>
          record.open &&
          record.metadata["Документ (documentId)"] ===
            buttonRecord.documentId &&
          record.metadata["Путь (path)"] === "button",
      ),
    "Firefox не раскрыл стандартную карточку details",
  );
  const expandedRecord = expandedResults.records.find(
    (record) =>
      record.open &&
      record.metadata["Документ (documentId)"] === buttonRecord.documentId &&
      record.metadata["Путь (path)"] === "button",
  );
  assert.equal(expandedRecord.metadata["Фрейм (frameId)"], "0");
  assert.equal(
    expandedRecord.metadata["Источник (sourceKind)"],
    buttonRecord.source.sourceKind ?? "Неизвестно",
  );
  assert.equal(expandedRecord.metadata.capture, "false");
  assert.equal(expandedRecord.metadata.passive, "Неизвестно");
  assert.equal(expandedRecord.metadata.once, "Неизвестно");

  // MAIN регистрирует настоящие listeners; события и их payload не отправляем.
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
  await api(
    `return browser.scripting.executeScript({
      target: {tabId: arguments[0], frameIds: [0]}, world: 'MAIN',
      args: [arguments[1]],
      func: (eventTypes) => {
        const target = document.createElement('input');
        target.id = 'listener-catalog-probe';
        target.value = 'listener-catalog-private-input';
        document.body.append(target);
        const listener = () => {
          const callbackPayload = 'listener-catalog-callback-content';
          void callbackPayload;
        };
        window.__listenerLensCatalogProbe = {target, listener};
        for (const eventType of eventTypes) {
          target.addEventListener(eventType, listener, {
            capture: true, passive: false, once: false
          });
        }
      }
    });`,
    [fixture.id, newEventTypes],
  );
  const expandedCatalogState = await poll(
    () => snapshot(fixture.id),
    (state) =>
      newEventTypes.every((eventType) =>
        state.records.some(
          (record) =>
            record.eventType === eventType &&
            record.frameId === 0 &&
            record.source.path === "input" &&
            record.lifecycle === "active",
        ),
      ),
    "Firefox не передал регистрации новых семейств через background",
  );
  const newRecords = expandedCatalogState.records.filter(
    (record) =>
      newEventTypes.includes(record.eventType) &&
      record.frameId === 0 &&
      record.source.path === "input",
  );
  assert.equal(newRecords.length, newEventTypes.length);
  for (const record of newRecords) {
    assert.equal(record.documentId, expandedCatalogState.documentId);
    assert.equal(record.source.sourceKind, "add-event-listener");
    assert.deepEqual(record.listenerOptions, {
      capture: true,
      passive: false,
      once: false,
    });
    assert.match(record.description, /[А-Яа-яЁё]/);
    assert.doesNotMatch(
      record.description,
      /Назначение этого типа события пока не описано/,
    );
    for (const field of ["value", "payload", "data", "callbackBody"]) {
      assert.equal(Object.hasOwn(record, field), false);
      assert.equal(Object.hasOwn(record.source, field), false);
    }
  }
  assert.doesNotMatch(
    JSON.stringify(expandedCatalogState.records),
    /listener-catalog-private-input|listener-catalog-callback-content/,
  );
  const pointerRecord = newRecords.find(
    (record) => record.eventType === "pointerdown",
  );
  await searchPopup("pointerdown");
  await filterPopup("Состояние обработчика", "active");
  await filterPopup("Источник регистрации", "add-event-listener");
  await filterPopup("Фрейм", "0");
  await poll(
    popupResults,
    (results) => results?.records.length === 1,
    "Firefox не применил пересечение фильтров",
  );
  await api(`const popup = browser.extension.getViews({type: 'popup'})[0];
    [...popup.document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Запомнить снимок').click();`);
  await poll(
    popupResults,
    (results) => results?.text.includes("Заменить снимок"),
    "Firefox не сохранил базовый снимок",
  );
  await api("browser.extension.getViews({type: 'popup'})[0].close();");
  await poll(
    () => api("return browser.extension.getViews({type: 'popup'}).length;"),
    (count) => count === 0,
    "Firefox не закрыл popup перед изменением страницы",
  );
  await api(
    `return browser.scripting.executeScript({
      target: {tabId: arguments[0], frameIds: [0]}, world: 'MAIN',
      func: () => {
        const probe = window.__listenerLensCatalogProbe;
        probe.target.removeEventListener('pointerdown', probe.listener, true);
      }
    });`,
    [fixture.id],
  );
  await openActionPopup(fixture.id);
  await selectPopupTab("Сравнение");
  await poll(
    popupResults,
    (results) => results?.text.includes("active → removed"),
    "Firefox не восстановил сравнение после закрытия popup",
  );
  await selectPopupTab("Обработчики");
  await searchPopup("pointerdown");
  await filterPopup("Состояние обработчика", "active");
  await filterPopup("Источник регистрации", "add-event-listener");
  await filterPopup("Фрейм", "0");
  await poll(
    () => snapshot(fixture.id),
    (state) =>
      state.records.some(
        (record) =>
          record.id === pointerRecord.id &&
          record.eventType === "pointerdown" &&
          record.lifecycle === "removed",
      ),
    "Firefox не сохранил lifecycle removed для pointerdown",
  );
  await poll(
    popupResults,
    (results) =>
      results?.records.length === 0 &&
      results.text.includes("По выбранным фильтрам ничего не найдено"),
    "Firefox не обновил выдачу после удаления активного обработчика",
  );
  await selectPopupTab("Сравнение");
  await poll(
    popupResults,
    (results) => results?.text.includes("active → removed"),
    "Firefox не сравнил lifecycle с базовым снимком",
  );
  await selectPopupTab("Обработчики");
  await filterPopup("Состояние обработчика", "removed");
  await searchPopup("pointerdown removed");
  const removedResults = await poll(
    popupResults,
    (results) =>
      results?.records.length === 1 &&
      results.records[0].eventType === "pointerdown" &&
      results.records[0].metadata["Состояние (lifecycle)"] ===
        "Удалён (removed)",
    "Firefox не показал удалённый pointerdown в настоящем popup",
  );
  assert.deepEqual(removedResults.groups, ["pointerdown · 1"]);
  assert.equal(
    removedResults.records[0].metadata["Идентификатор записи (id)"],
    pointerRecord.id,
  );
  async function exportPopup(label) {
    return api(
      `const popup = browser.extension.getViews({type: 'popup'})[0];
       const original = popup.URL.createObjectURL.bind(popup.URL);
       let exported;
       popup.URL.createObjectURL = blob => { exported = blob.text(); return original(blob); };
       try {
         const trigger = [...popup.document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Экспорт JSON');
         if (!trigger) throw new Error('Кнопка экспорта popup отсутствует');
         trigger.dispatchEvent(new popup.PointerEvent('pointerdown', {bubbles: true, button: 0, ctrlKey: false, pointerType: 'mouse', isPrimary: true}));
         await new Promise(resolve => popup.setTimeout(resolve, 0));
         const item = [...popup.document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.trim().startsWith(arguments[0]));
         if (!item) throw new Error('Пункт экспорта popup недоступен: ' + arguments[0]);
         item.click();
         if (!exported) throw new Error('Экспорт не создал Blob');
         return exported.then(JSON.parse);
       } finally { popup.URL.createObjectURL = original; }`,
      [label],
    );
  }
  const filteredExport = await exportPopup("Экспорт выборки");
  assert.equal(filteredExport.scope, "filtered");
  assert.deepEqual(
    filteredExport.records.map((record) => record.id),
    [pointerRecord.id],
  );
  assert.equal(filteredExport.coverage.partial, true);
  const fullExport = await exportPopup("Экспорт всего снимка");
  assert.equal(fullExport.scope, "all");
  assert.equal(fullExport.exportedCount, fullExport.totalCount);
  assert.ok(fullExport.exportedCount > 1);
  assert.doesNotMatch(
    JSON.stringify(fullExport),
    /listener-catalog-private-input|listener-catalog-callback-content/,
  );
  await filterPopup("Источник регистрации", "event-handler-property");
  await poll(
    popupResults,
    (results) => results?.records.length === 0,
    "Firefox не отфильтровал источник регистрации",
  );
  await api(`const popup = browser.extension.getViews({type: 'popup'})[0];
    [...popup.document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Сбросить фильтры').click();`);
  await poll(
    popupResults,
    (results) =>
      results?.search?.value === "" &&
      results.filters.every((value) => value === "all"),
    "Firefox не сбросил поиск и фильтры после проверки lifecycle",
  );
  const childFrameId = frameState.records.find(
    (record) => record.frameId > 0,
  ).frameId;
  await filterPopup("Фрейм", String(childFrameId));
  const childResults = await poll(
    popupResults,
    (results) =>
      results?.records.length > 0 &&
      results.records.every(
        (record) => record.metadata["Фрейм (frameId)"] === String(childFrameId),
      ),
    "Firefox не показал точную выборку фрейма",
  );
  assert.ok(
    childResults.records.every(
      (record) => record.metadata["Фрейм (frameId)"] === String(childFrameId),
    ),
  );
  await api(`const popup = browser.extension.getViews({type: 'popup'})[0];
    [...popup.document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Сбросить фильтры').click();`);
  const filterResetResults = await poll(
    popupResults,
    (results) => results?.filters.every((value) => value === "all"),
    "Firefox не сбросил фильтр фрейма",
  );
  const filterResetCount = (await snapshot(fixture.id)).records.length;
  assert.equal(
    filterResetResults.count,
    `Показано записей: ${filterResetCount} из ${filterResetCount}.`,
  );
  console.debug(
    JSON.stringify({
      scope: "firefox-extension",
      phase: "расширенный-каталог-и-фильтры",
      filters: "lifecycle/source/frame и сброс проверены",
      registeredCount: newRecords.length,
      removedCount: 1,
      privacy: "проверена",
    }),
  );
  console.debug(
    JSON.stringify({
      scope: "firefox-extension",
      message: "real collection verified",
    }),
  );

  const coverageAdapter = {
    label: "firefox-extension",
    navigate: async (pathname) => {
      const url = new URL(pathname, fixtureUrl).href;
      await api(
        "await browser.tabs.update(arguments[0], {url: arguments[1]});",
        [fixture.id, url],
      );
      await poll(
        () => api("return browser.tabs.get(arguments[0]);", [fixture.id]),
        (tab) => tab.status === "complete" && tab.url === url,
        "Firefox не завершил навигацию fixture",
      );
    },
    run: async (operation) => {
      const results = await api(
        `return browser.scripting.executeScript({
        target: {tabId: arguments[0], frameIds: [0]}, world: 'MAIN',
        func: name => window.__coverageFixture?.run(name) ?? null,
        args: [arguments[1]]
      });`,
        [fixture.id, operation],
      );
      return results[0]?.result ?? null;
    },
    snapshot: () => snapshot(fixture.id),
    back: () => api("await browser.tabs.goBack(arguments[0]);", [fixture.id]),
    reload: () => api("await browser.tabs.reload(arguments[0]);", [fixture.id]),
    coverageText: async () => (await popupResults())?.text ?? "",
    lifecyclePopup: async ({ beforeAbort, abort }) => {
      await selectPopupTab("Обработчики");
      await filterPopup("Состояние обработчика", "unknown");
      await filterPopup("Источник регистрации", "add-event-listener");
      await filterPopup("Фрейм", "0");
      await searchPopup(`${beforeAbort.eventType} ${beforeAbort.source.path}`);
      await poll(
        popupResults,
        (state) =>
          state.records.some(
            (record) =>
              record.metadata["Идентификатор записи (id)"] === beforeAbort.id,
          ),
        "Firefox popup не показал once-запись",
      );
      await api(
        `const popup = browser.extension.getViews({type: "popup"})[0];
        const card = [...popup.document.querySelectorAll("details.listener-record")].find(node => node.textContent.includes(arguments[0]));
        if (!card) throw new Error("Once-запись отсутствует в настоящем popup");
        card.open = true;`,
        [beforeAbort.id],
      );
      await poll(
        popupResults,
        (state) => state.text.includes("Срабатывания не отслеживаются"),
        "Firefox popup не объясняет неизвестный lifecycle",
      );
      const exported = await exportPopup("Экспорт выборки");
      assert.equal(exported.version, 1);
      const once = exported.records.find(
        (record) => record.id === beforeAbort.id,
      );
      assert.equal(once.lifecycle, "unknown");
      assert.ok(once.reasonCodes.includes("LIFECYCLE_UNVERIFIED"));
      assert.deepEqual(once.listenerOptions, beforeAbort.listenerOptions);
      assert.doesNotMatch(JSON.stringify(exported), /coverage-.*secret/);
      const current = await snapshot(fixture.id);
      await api(
        `const popup = browser.extension.getViews({type: "popup"})[0];
        const button = [...popup.document.querySelectorAll("button")].find(node => node.textContent.trim() === arguments[0]);
        if (!button) throw new Error("Кнопка baseline отсутствует");
        button.click();`,
        [current.baseline ? "Заменить снимок" : "Запомнить снимок"],
      );
      await poll(
        () => snapshot(fixture.id),
        (state) =>
          state.baseline?.records.find((record) => record.id === beforeAbort.id)
            ?.lifecycle === "unknown",
        "Firefox не сохранил once baseline",
      );
      await abort();
      await filterPopup("Состояние обработчика", "removed");
      await poll(
        popupResults,
        (state) =>
          state.records.some(
            (record) =>
              record.metadata["Идентификатор записи (id)"] === beforeAbort.id &&
              record.metadata["Состояние (lifecycle)"] === "Удалён (removed)",
          ),
        "Firefox popup не показал abort tombstone",
      );
      const removedExport = await exportPopup("Экспорт выборки");
      const removed = removedExport.records.find(
        (record) => record.id === beforeAbort.id,
      );
      assert.equal(removed.lifecycle, "removed");
      assert.ok(!removed.reasonCodes.includes("LIFECYCLE_UNVERIFIED"));
      await selectPopupTab("Сравнение");
      await poll(
        popupResults,
        (state) => state.text.includes("unknown → removed"),
        "Firefox diff не показал подтверждённое удаление",
      );
      assert.equal(
        (await snapshot(fixture.id)).baseline.records.find(
          (record) => record.id === beforeAbort.id,
        ).lifecycle,
        "unknown",
      );
      await selectPopupTab("Обработчики");
      await searchPopup("");
      await filterPopup("Состояние обработчика", "all");
      await filterPopup("Источник регистрации", "all");
      await filterPopup("Фрейм", "all");
      await poll(
        popupResults,
        (state) =>
          state.search?.value === "" &&
          state.filters.every((value) => value === "all"),
        "Firefox не сбросил lifecycle-фильтры",
      );
    },
    restartBackground: async () => {
      await call("Marionette:SetContext", { value: "chrome" });
      const stopped = await executeAsync(`
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const extension = ExtensionParent.GlobalManager.getExtension("listener-lens@example.invalid");
        const views = () => [...extension.views].filter(view => view.viewType === "background").map(view => view.contextId);
        const previous = views();
        if (!previous.length) throw new Error("Работающий background context отсутствует");
        if (typeof extension.terminateBackground === "function")
          await extension.terminateBackground({ disableResetIdleForTest: true });
        else if (typeof extension.backgroundContext?.shutdown === "function")
          await extension.backgroundContext.shutdown(false);
        else throw new Error("Background stop API отсутствует: " + JSON.stringify({state: extension.backgroundState, contextType: extension.backgroundContext?.constructor?.name}));
        return { previous, remaining: views(), state: extension.backgroundState };
      `);
      assert.equal(stopped.state, "stopped");
      assert.ok(
        stopped.previous.every((id) => !stopped.remaining.includes(id)),
      );
      await call("Marionette:SetContext", { value: "content" });
      return async () => {
        await call("Marionette:SetContext", { value: "chrome" });
        await poll(
          () =>
            execute(`
          const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const extension = ExtensionParent.GlobalManager.getExtension("listener-lens@example.invalid");
          return [...extension.views].filter(view => view.viewType === "background").map(view => view.contextId);
        `),
          (ids) => ids.some((id) => !stopped.previous.includes(id)),
          "Firefox не создал новый background context",
        );
        await call("Marionette:SetContext", { value: "content" });
      };
    },
  };
  await verifyTargetReveal({
    label: "firefox-extension",
    run: async (operation) => {
      const results = await api(
        `return browser.scripting.executeScript({target: {tabId: arguments[0], frameIds: [0]}, world: 'MAIN', func: ${revealProbe.toString()}, args: [arguments[1]]});`,
        [fixture.id, operation],
      );
      return results[0]?.result;
    },
    popup: (args) =>
      api(`return (${popupRevealProbe.toString()})(arguments[0]);`, [args]),
    snapshot: () => snapshot(fixture.id),
  });
  await verifyDetectionCoverage(coverageAdapter);

  // Переустановка того же temporary add-on проходит через настоящий update lifecycle.
  await call("Addon:Install", {
    path: path.resolve(".output/firefox-mv3"),
    temporary: true,
  });
  const remainingHandles = await call("WebDriver:GetWindowHandles");
  await call("WebDriver:SwitchToWindow", { handle: remainingHandles[0] });
  await call("Marionette:SetContext", { value: "chrome" });
  await execute(
    `const tab = gBrowser.addTab(arguments[0], {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
  }); gBrowser.selectedTab = tab;`,
    [`moz-extension://${extensionUuid}/popup.html`],
  );
  await call("Marionette:SetContext", { value: "content" });
  popupHandle = (await call("WebDriver:GetWindowHandles")).at(-1);
  await call("WebDriver:SwitchToWindow", { handle: popupHandle });
  await poll(
    () => execute("return typeof browser === 'object';"),
    Boolean,
    "Reloaded extension control page unavailable",
  );
  assert.deepEqual(await origins(), [pattern]);
  await poll(
    scripts,
    (value) => value.length === 1,
    "Firefox failed to restore dynamic registration after add-on reload",
  );
  await api("await browser.tabs.reload(arguments[0]);", [fixture.id]);
  await poll(
    () => snapshot(fixture.id),
    (state) =>
      state.records.some(
        (record) => record.eventType === "click" && record.frameId === 0,
      ),
    "Firefox failed to collect after add-on reload",
  );

  // Удаляем разрешение через API браузера, минуя обработчик revoke-site.
  assert.equal(
    await api("return browser.permissions.remove({origins:[arguments[0]]});", [
      pattern,
    ]),
    true,
  );
  await poll(
    scripts,
    (value) => value.length === 0,
    "Firefox kept a registration after external permission removal",
  );
  assert.equal((await snapshot(fixture.id)).records.length, 0);
  assert.equal((await snapshot(secondFixture.id)).records.length, 0);
  await permissionPrompt(true);
  assert.deepEqual(await origins(), [pattern]);
  await message({ type: "activate-site", tabId: fixture.id, pattern });
  await api(
    "await browser.tabs.reload(arguments[0]); await browser.tabs.reload(arguments[1]);",
    [fixture.id, secondFixture.id],
  );
  await poll(
    () => snapshot(fixture.id),
    (state) =>
      state.records.some(
        (record) => record.eventType === "click" && record.frameId === 0,
      ),
    "Firefox failed to collect after a second permission grant",
  );
  await poll(
    () => snapshot(secondFixture.id),
    (state) => state.records.some((record) => record.eventType === "click"),
    "Firefox failed to collect in second tab after a second permission grant",
  );

  // После revoke executeScript больше недоступен. Страницей управляет сам
  // WebDriver, поэтому проверка не возвращает расширению отозванный grant.
  const currentFixtureUrl = await api(
    "return (await browser.tabs.get(arguments[0])).url;",
    [fixture.id],
  );
  let fixtureHandle;
  try {
    for (const handle of await call("WebDriver:GetWindowHandles")) {
      await call("WebDriver:SwitchToWindow", { handle });
      if ((await execute("return location.href;")) === currentFixtureUrl) {
        fixtureHandle = handle;
        break;
      }
    }
  } finally {
    await call("WebDriver:SwitchToWindow", { handle: popupHandle });
  }
  assert.ok(fixtureHandle, "WebDriver не нашёл вкладку fixture перед revoke");
  await verifyRevokedBFCache({
    ...coverageAdapter,
    run: async (operation) => {
      await call("WebDriver:SwitchToWindow", { handle: fixtureHandle });
      try {
        return await execute(
          "return (window.wrappedJSObject ?? window).__coverageFixture?.run(arguments[0]) ?? null;",
          [operation],
        );
      } finally {
        await call("WebDriver:SwitchToWindow", { handle: popupHandle });
      }
    },
    revoke: () => message({ type: "revoke-site", tabId: fixture.id, pattern }),
  });
  assert.deepEqual(await origins(), []);
  assert.equal((await snapshot(secondFixture.id)).records.length, 0);
  await poll(
    popupResults,
    (results) => results && !results.search && results.records.length === 0,
    "Firefox оставил поиск или карточки после отзыва доступа",
  );
  await poll(
    scripts,
    (value) => value.length === 0,
    "Firefox kept a revoked registration",
  );
  await api("await browser.tabs.reload(arguments[0]);", [fixture.id]);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await snapshot(fixture.id)).records.length, 0);
  console.debug(
    JSON.stringify({
      scope: "firefox-extension",
      message:
        "PASS: temporary add-on; native deny/allow; activeTab isolation; exact host and frames; real collection; поиск и карточки настоящего popup; update; external revoke; regrant; two-tab revoke",
      nativePermissionPrompt: "verified",
    }),
  );
} catch (error) {
  console.error(driver?.output());
  throw error;
} finally {
  await driver?.close();
  await new Promise((resolve) => server.close(resolve));
}
