import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
async function accessibility(...args) {
  const result = await executeFile(
    "python3",
    ["-B", "tests/e2e/chrome-native-accessibility.py", ...args],
    {
      timeout: 15_000,
      maxBuffer: 300_000,
    },
  );
  const value = JSON.parse(result.stdout);
  if (!value.ok) throw new Error(value.error);
  return value;
}
const trust = await accessibility("--check");
if (process.argv.includes("--check-accessibility")) {
  console.log(JSON.stringify(trust));
  process.exit(trust.trusted ? 0 : 78);
}
assert.ok(
  trust.trusted,
  "Для нативных кнопок нужен macOS Accessibility; автоматической выдачи доступа нет.",
);

async function poll(read, accept, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${description}: ${JSON.stringify(value)}`);
}

const profile = await mkdtemp(
  path.join(tmpdir(), "listener-lens-native-chrome-"),
);
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
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, resolve);
});
const fixtureUrl = `http://localhost:${server.address().port}/site-access.html`;
const otherUrl = fixtureUrl.replace("localhost", "127.0.0.1");
const pattern = "http://localhost/*";
const otherPattern = "http://127.0.0.1/*";
let context;
let control;
let extensionId;
let browserPid;
const watchdog = setTimeout(() => {
  console.error("Превышено время нативного браузерного сценария");
  void context?.close();
}, 120_000);
watchdog.unref();

async function launch() {
  const extensionPath = path.resolve(".output/chrome-mv3");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: false,
    args: [
      "--force-renderer-accessibility",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  const cdp = await context.browser().newBrowserCDPSession();
  const version = await cdp.send("Browser.getVersion");
  const processes = await cdp.send("SystemInfo.getProcessInfo");
  browserPid = processes.processInfo.find((item) => item.type === "browser").id;
  console.log(JSON.stringify({ phase: "browser", version: version.product }));
  control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/popup.html`);
}
const origins = () =>
  control.evaluate(async () => (await chrome.permissions.getAll()).origins);
const registrations = () =>
  control.evaluate(() => chrome.scripting.getRegisteredContentScripts());
const popupText = () =>
  control.evaluate(
    () =>
      chrome.extension.getViews({ type: "popup" })[0]?.document.body
        .innerText ?? "",
  );
const snapshot = (tabId) =>
  control.evaluate((id) => {
    const popup = chrome.extension.getViews({ type: "popup" })[0];
    if (!popup) throw new Error("Настоящий popup закрыт");
    return Promise.race([
      popup.chrome.runtime.sendMessage({ type: "get-site-access", tabId: id }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Нет ответа get-site-access")),
          5_000,
        ),
      ),
    ]);
  }, tabId);
const nativeTree = async () => {
  const tree = await accessibility(
    "--pid",
    String(browserPid),
    "--snapshot",
    "--max-depth",
    "20",
    "--max-nodes",
    "1000",
  );
  assert.equal(tree.truncated, false, "Дерево Accessibility обрезано");
  return tree;
};
const press = async (name) => {
  await poll(
    nativeTree,
    (tree) =>
      tree.nodes.some(
        (node) =>
          ["AXButton", "AXPopUpButton"].includes(node.role) &&
          node.title === name &&
          node.enabled,
      ),
    `Не появилась кнопка «${name}»`,
  );
  return accessibility(
    "--pid",
    String(browserPid),
    "--press",
    name,
    "--max-depth",
    "20",
    "--max-nodes",
    "1000",
  );
};
async function openPopup(page) {
  await control.evaluate(() =>
    chrome.extension
      .getViews({ type: "popup" })
      .forEach((view) => view.close()),
  );
  await page.bringToFront();
  const tree = await poll(
    nativeTree,
    (value) =>
      value.nodes.some(
        (node) =>
          node.role === "AXPopUpButton" &&
          ["Расширения", "Extensions"].includes(node.title),
      ),
    "Не найдена нативная кнопка Extensions",
  );
  const menu = tree.nodes.find(
    (node) =>
      node.role === "AXPopUpButton" &&
      ["Расширения", "Extensions"].includes(node.title),
  );
  assert.ok(menu, "Не найдена нативная кнопка Extensions");
  await press(menu.title);
  await press("Listener Lens");
  await poll(
    popupText,
    (text) => text.includes("Listener Lens"),
    "Popup не открылся",
  );
  return control.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
}
async function nativeGrant(page, allow, hostname, promptRequired = true) {
  const id = await openPopup(page);
  await poll(
    popupText,
    (text) => text.includes("Разрешить для этого сайта"),
    "Нет кнопки выдачи доступа",
  );
  await press("Разрешить для этого сайта");
  const expected = `http://${hostname}/*`;
  const result = await poll(
    async () => ({ tree: await nativeTree(), origins: await origins() }),
    ({ tree, origins }) =>
      tree.nodes.some(
        (node) =>
          node.role === "AXSheet" && node.title.includes("Listener Lens"),
      ) ||
      (!promptRequired && allow && origins.includes(expected)),
    "Не появился нативный запрос",
  );
  const sheet = result.tree.nodes.find(
    (node) => node.role === "AXSheet" && node.title.includes("Listener Lens"),
  );
  if (!sheet) {
    assert.ok(!promptRequired && allow && result.origins.includes(expected));
    console.log(
      JSON.stringify({
        phase: "popup-regrant",
        site: hostname,
        nativePrompt: false,
        verified: true,
      }),
    );
    return id;
  }
  const nodes = result.tree.nodes.filter(
    (node) =>
      node.path === sheet.path || node.path.startsWith(`${sheet.path}.`),
  );
  const text = nodes
    .map((node) => `${node.title ?? ""} ${node.value ?? ""}`)
    .join("\n");
  assert.ok(
    text.includes("Listener Lens") && text.includes(hostname),
    "Нативный запрос не соответствует расширению и сайту",
  );
  const names = allow
    ? ["Разрешить", "Allow"]
    : ["Запретить", "Deny", "Cancel"];
  assert.ok(
    nodes.some(
      (node) =>
        node.role === "AXButton" &&
        ["Запретить", "Deny", "Cancel"].includes(node.title),
    ),
    "Нет кнопки отказа в нативном диалоге",
  );
  assert.ok(
    nodes.some(
      (node) =>
        node.role === "AXButton" && ["Разрешить", "Allow"].includes(node.title),
    ),
    "Нет кнопки подтверждения в нативном диалоге",
  );
  const button = nodes.find(
    (node) => node.role === "AXButton" && names.includes(node.title),
  );
  assert.ok(button, "Не найдена кнопка нативного запроса");
  // Chromium откладывает активацию кнопок нового диалога для защиты от случайного подтверждения.
  await delay(1_000);
  await press(button.title);
  await poll(
    nativeTree,
    (value) =>
      !value.nodes.some(
        (node) => node.role === "AXButton" && names.includes(node.title),
      ),
    "Нативный запрос не закрылся после нажатия",
  );
  await poll(
    origins,
    (value) => value.includes(expected) === allow,
    "Неверный результат нативного запроса",
  );
  console.log(
    JSON.stringify({
      phase: allow ? "native-allow" : "native-deny",
      site: hostname,
      verified: true,
    }),
  );
  return id;
}
async function hasClick(tabId) {
  return (await snapshot(tabId)).records.some(
    (record) =>
      record.eventType === "click" &&
      record.frameId === 0 &&
      record.source.target === "element" &&
      record.source.path === "button",
  );
}

try {
  await launch();
  const fixture = await context.newPage();
  await fixture.goto(fixtureUrl);
  assert.deepEqual(await origins(), []);
  assert.deepEqual(await registrations(), []);
  const tabId = await nativeGrant(fixture, false, "localhost");
  assert.deepEqual(await origins(), []);
  assert.deepEqual(await registrations(), []);
  await openPopup(fixture);
  assert.equal((await snapshot(tabId)).status, "no-access");
  assert.deepEqual((await snapshot(tabId)).records, []);
  await nativeGrant(fixture, true, "localhost");
  assert.deepEqual(await origins(), [pattern]);
  await openPopup(fixture);
  await poll(
    popupText,
    (text) => text.includes("Перезагрузить вкладку"),
    "Нет отдельной кнопки reload",
  );
  await press("Перезагрузить вкладку");
  await openPopup(fixture);
  await poll(
    () => hasClick(tabId),
    Boolean,
    "Нет реального обработчика после reload",
  );
  const second = await control.evaluate(
    async (url) => chrome.tabs.create({ url, active: false }),
    fixtureUrl,
  );
  const other = await control.evaluate(
    async (url) => chrome.tabs.create({ url, active: false }),
    otherUrl,
  );
  await poll(
    () => hasClick(second.id),
    Boolean,
    "Нет обработчиков во второй вкладке",
  );
  assert.deepEqual((await snapshot(other.id)).records, []);
  const deniedPage = await poll(
    async () => context.pages().find((page) => page.url() === otherUrl),
    Boolean,
    "Не открылась вкладка второго хоста",
  );
  assert.equal(await openPopup(deniedPage), other.id);
  assert.equal((await snapshot(other.id)).status, "no-access");
  assert.deepEqual((await snapshot(other.id)).records, []);
  assert.deepEqual(await origins(), [pattern]);
  await openPopup(fixture);
  assert.deepEqual(
    (await registrations()).flatMap((entry) => entry.matches),
    [pattern],
  );
  await poll(
    popupText,
    (text) => text.includes("Отозвать доступ"),
    "Нет кнопки revoke",
  );
  await press("Отозвать доступ");
  await poll(
    origins,
    (value) => value.length === 0,
    "Grant остался после revoke",
  );
  await poll(
    registrations,
    (value) => value.length === 0,
    "Регистрация осталась после revoke",
  );
  await openPopup(fixture);
  assert.deepEqual((await snapshot(tabId)).records, []);
  assert.deepEqual((await snapshot(second.id)).records, []);
  await fixture.evaluate(() => window.addEventListener("copy", () => {}));
  await delay(500);
  assert.deepEqual((await snapshot(tabId)).records, []);
  console.log(
    JSON.stringify({ phase: "collection-and-popup-revoke", verified: true }),
  );

  await nativeGrant(fixture, true, "localhost", false);
  await control.evaluate(
    (ids) => Promise.all(ids.map((id) => chrome.tabs.reload(id))),
    [tabId, second.id],
  );
  await openPopup(fixture);
  await poll(() => hasClick(tabId), Boolean, "Regrant не восстановил сбор");
  await poll(
    () => hasClick(second.id),
    Boolean,
    "Regrant не восстановил сбор во второй вкладке",
  );
  const settings = await context.newPage();
  await settings.goto("chrome://extensions/");
  // Настройка «При нажатии» сохраняет withholding; один removeHostPermission этого не делает.
  await settings.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        chrome.developerPrivate.updateExtensionConfiguration(
          { extensionId: id, hostAccess: "ON_CLICK" },
          () => {
            if (chrome.runtime.lastError)
              reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          },
        );
      }),
    extensionId,
  );
  assert.equal(
    await settings.evaluate(
      async (id) =>
        (await chrome.developerPrivate.getExtensionInfo(id)).permissions
          .runtimeHostPermissions.hostAccess,
      extensionId,
    ),
    "ON_CLICK",
  );
  await settings.close();
  await poll(
    origins,
    (value) => value.length === 0,
    "Внешний отзыв не удалил grant",
  );
  await poll(
    registrations,
    (value) => value.length === 0,
    "Внешний отзыв не удалил регистрацию",
  );
  await openPopup(fixture);
  assert.deepEqual((await snapshot(tabId)).records, []);
  assert.deepEqual((await snapshot(second.id)).records, []);
  console.log(JSON.stringify({ phase: "external-revoke", verified: true }));

  const otherPage = await context.newPage();
  await otherPage.goto(otherUrl);
  await nativeGrant(otherPage, true, "127.0.0.1");
  assert.deepEqual(await origins(), [otherPattern]);
  await context.close();
  await launch();
  assert.deepEqual(await origins(), [otherPattern]);
  await poll(
    registrations,
    (value) => value.length === 1 && value[0].matches.join() === otherPattern,
    "Restart не восстановил единственный сохранённый grant",
  );
  const revokedPage = await context.newPage();
  await revokedPage.goto(fixtureUrl);
  const revokedId = await openPopup(revokedPage);
  assert.equal((await snapshot(revokedId)).status, "no-access");
  assert.deepEqual((await snapshot(revokedId)).records, []);
  const restoredPage = await context.newPage();
  await restoredPage.goto(otherUrl);
  const restoredId = await openPopup(restoredPage);
  await poll(
    () => hasClick(restoredId),
    Boolean,
    "После restart нет сбора разрешённого сайта",
  );
  console.log(
    JSON.stringify({
      phase: "PASS",
      nativePermissionPrompt: "verified",
      popupGesture: "native-accessibility",
      restart: "verified",
    }),
  );
} finally {
  clearTimeout(watchdog);
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
