import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import {
  extensionUuid,
  launchFirefoxExtension,
  poll,
} from "./firefox-driver.mjs";

const server = createServer((request, response) => {
  const name = path.basename(new URL(request.url, "http://localhost").pathname);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  createReadStream(path.resolve("tests/e2e/fixtures", name))
    .on("error", () => {
      response.statusCode = 404;
      response.end();
    })
    .pipe(response);
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const fixtureUrl = `http://localhost:${port}/site-access.html`;
const otherUrl = `http://127.0.0.1:${port}/site-access.html`;
const pattern = "http://localhost/*";
let driver;

try {
  driver = await launchFirefoxExtension();
  const { call, execute, executeAsync } = driver;
  await call("Marionette:SetContext", { value: "chrome" });
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
      const input = document.querySelector('input[type="search"]');
      return {
        search: input && {
          value: input.value,
          label: document.querySelector('label[for="' + input.id + '"]')?.textContent.trim()
        },
        groups: [...document.querySelectorAll('h3')].map(group => group.textContent.trim()),
        count: document.querySelector('.results-count')?.textContent.trim(),
        text: document.body.textContent,
        records: [...document.querySelectorAll('details.listener-record')].map(record => ({
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
  assert.ok(allowedDocuments.length >= 2);
  assert.ok(allowedDocuments.every((frame) => frame.result === "localhost"));
  assert.ok(
    collected.records.every((record) =>
      allowedDocuments.some((frame) => frame.documentId === record.documentId),
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
  console.debug(
    JSON.stringify({
      scope: "firefox-extension",
      message: "real collection verified",
    }),
  );

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

  const revoked = await message({
    type: "revoke-site",
    tabId: fixture.id,
    pattern,
  });
  assert.equal(revoked.records.length, 0);
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
