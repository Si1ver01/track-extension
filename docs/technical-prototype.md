# Технический прототип

## Установка

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm playwright:install
```

`playwright:install` загружает Chromium и Firefox для UI и smoke-проверок. В окружениях без права открыть локальный порт команды Playwright нужно запускать с разрешённым loopback-доступом.

## Проверки

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
pnpm verify:build
pnpm test:e2e:chromium
pnpm test:smoke:firefox
```

`build` создаёт Manifest V3 артефакты в `.output/chrome-mv3` и `.output/firefox-mv3`. `verify:build` проверяет `manifest_version`, permissions, optional host permissions, `document_start` и Firefox `data_collection_permissions`.

## Матрица контекстов

| Контекст                        | Состояние               | Условия                                                                           |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| Верхний document                | Поддерживается          | Hook запускается на `document_start`; ранние регистрации могут быть невидимы.     |
| Same-origin iframe              | Поддерживается          | Content script получает отдельные `frameId` и `documentId`.                       |
| Cross-origin iframe             | Частично                | Нужны host permissions; изоляция браузера может ограничить metadata.              |
| `about:blank` и `srcdoc`        | Частично                | Покрытие зависит от наследования origin и разрешений браузера.                    |
| Open/closed Shadow DOM          | Best effort             | Root регистрируется через `attachShadow`; закрытый root не обходится произвольно. |
| SPA navigation                  | Поддерживается          | `pushState`, `replaceState` и `popstate` создают navigation lifecycle metadata.   |
| Full navigation                 | Поддерживается          | Новый document получает новый `documentId`, устаревший context state очищается.   |
| Dedicated/shared/service Worker | Не поддерживается в MVP | Popup показывает явную capability limitation `UNSUPPORTED_CONTEXT`.               |

Каждая запись содержит `tabId`, `frameId`, `documentId`, `contextKind`, target identity и listener metadata. Event payload, callback body, DOM text, clipboard и input values не собираются и не попадают в logs. Диагностические сообщения используют уровни `DEBUG`, `INFO`, `WARN`, `ERROR`; значения событий и payload в них не выводятся.

Unit и integration tests проверяют нормализацию metadata, запрет payload-полей, маршрутизацию по вкладке/frame/document, target deduplication, Shadow DOM identity, SPA reset и manifest frame invariants. Fixture содержит iframe, open/closed Shadow DOM и SPA transition. Chromium E2E загружает unpacked extension в persistent context, открывает fixture и проверяет popup. Firefox smoke проверяет Firefox fixture и наличие Firefox build; реальная загрузка add-on через WebDriver BiDi и `web-ext lint` остаётся отдельным release gate.

## Ограничения

Hook устанавливается best-effort на `document_start`. Скрипты, выполнившиеся до hook, browser-protected URLs и изолированные cross-origin/frame contexts могут быть недоступны. Расширение не записывает event payload, clipboard/input values или callback body и не выполняет сетевые запросы.

Firefox `gecko.id` в прототипе использует placeholder `listener-lens@example.invalid`. Перед публикацией его нужно заменить на контролируемый стабильный ID и повторить privacy/manifest audit.
