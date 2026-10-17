[К README](../README.md) · [Доступ к сайту →](site-access.md)

# Сборка и проверки

Manifest задаёт Chrome 119+ и Firefox 128+ для динамической регистрации с origin fallback. Фактически проверенные версии зависят от установленного набора Playwright; минимальная версия в manifest не означает, что весь этот диапазон протестирован.

## Установка

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm playwright:install
```

`playwright:install` загружает Chromium и Firefox для браузерных проверок. В окружениях без права открыть локальный порт или запустить браузер команды нужно выполнять с соответствующим разрешением.

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
pnpm test:e2e:firefox
pnpm test:smoke:firefox
```

`build` создаёт Manifest V3 артефакты в `.output/chrome-mv3` и `.output/firefox-mv3` и запускает `verify:build`. Проверяем permissions, отсутствие широкого обязательного доступа и статического запуска на всех сайтах, упакованные content/bridge scripts и Firefox `data_collection_permissions`. Параметры динамической регистрации проверяются тестами координатора доступа.

Unit-команда включает integration-тесты. Общий `format:check` также захватывает локальные файлы инструментов; исходные замечания вне изменённых файлов не исправляем массовым форматированием.

## Матрица контекстов

| Контекст                        | Состояние                       | Условия                                                                                      |
| ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Верхний document                | После разрешения и перезагрузки | Динамический script запускается на `document_start`; ранние регистрации могут быть невидимы. |
| Same-origin iframe              | После разрешения                | Content script получает отдельные `frameId` и `documentId`.                                  |
| Cross-origin iframe             | Частично                        | Нужен отдельный grant сайта iframe; разрешение верхней страницы его не заменяет.             |
| `about:blank` и `srcdoc`        | Частично                        | Нужны поддержка origin fallback и подтверждённый браузером origin; иначе сбор отключён.      |
| Open/closed Shadow DOM          | Best effort                     | Root регистрируется через `attachShadow`; закрытый root не обходится произвольно.            |
| SPA navigation                  | Поддерживается                  | `pushState`, `replaceState` и `popstate` создают navigation lifecycle metadata.              |
| Full navigation                 | Поддерживается                  | Новый document получает новый `documentId`, устаревший context state очищается.              |
| Dedicated/shared/service Worker | Не поддерживается в MVP         | Popup сообщает об отсутствии поддержки Worker-контекстов.                                    |

Каждая запись содержит `tabId`, `frameId`, `documentId`, `contextKind`, target identity и listener metadata. Event payload, callback body, DOM text, clipboard и input values не собираются и не попадают в logs. Диагностические сообщения используют уровни `DEBUG`, `INFO`, `WARN`, `ERROR`; значения событий и payload в них не выводятся.

Unit и integration tests проверяют границы site scope, нормализацию metadata, permissions reconciliation, readiness и UI-действия. Браузерные проверки расширения должны устанавливать настоящую сборку, выдавать одному сайту доступ и проверять реальные записи после reload, изоляцию второго hostname и очистку после revoke.

Firefox smoke открывает fixture и проверяет наличие сборки; add-on он не устанавливает. Команда `test:e2e:firefox` проверяет установленный add-on через встроенный Marionette и управляет настоящим диалогом разрешений Firefox. WebDriver BiDi позволяет установить add-on, но ограничивает переход на `moz-extension:` для управления popup.

`test:e2e:chromium` проверяет сбор и изоляцию с программной подготовкой grant. Отдельная команда `pnpm test:e2e:chromium:native` на macOS открывает настоящий action popup и управляет нативным диалогом через Accessibility. Она проверяет отказ, подтверждение, reload, отзыв, изоляцию и полный restart с сохранённым grant; программной подготовки grant в ней нет. Проверка прошла на Playwright Chromium `153.0.8010.12`, а стабильный Google Chrome и весь заявленный диапазон версий отдельно не проверялись. Требования и ручной сценарий описаны в [доступе к сайту](site-access.md#проверка-нативного-запроса). Нативный тест не входит в общий headless-набор. `web-ext lint` остаётся отдельным release gate.

## Ограничения

Hook устанавливается best-effort на `document_start`. Скрипты, выполнившиеся до hook, browser-protected URLs и изолированные cross-origin/frame contexts могут быть недоступны. Расширение не записывает event payload, clipboard/input values или callback body и не выполняет сетевые запросы.

Firefox `gecko.id` в прототипе использует placeholder `listener-lens@example.invalid`. Перед публикацией его нужно заменить на контролируемый стабильный ID и повторить privacy/manifest audit.

## Логирование

В development `createLogger` использует `DEBUG`; уровень можно изменить через `globalThis.LOG_LEVEL` (`debug`, `info`, `warn`, `error`) в нужном контексте. В production порог — `WARN`. Диагностика доступа содержит ID операции/вкладки/документа и код причины, без URL, nonce и пользовательских данных.

## См. также

- [Доступ к сайту](site-access.md)
- [README](../README.md)
