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

| Контекст                        | Состояние                       | Условия                                                                                                                               |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Верхний document                | После разрешения и перезагрузки | Динамический script запускается на `document_start`; ранние регистрации могут быть невидимы.                                          |
| Same-origin iframe              | После разрешения                | Content script получает отдельные `frameId` и `documentId`.                                                                           |
| Cross-origin iframe             | Частично                        | Нужен отдельный grant сайта iframe; разрешение верхней страницы его не заменяет.                                                      |
| `about:blank` и `srcdoc`        | Частично                        | Нужны поддержка origin fallback и подтверждённый браузером origin; иначе сбор отключён.                                               |
| Open/closed Shadow DOM          | Best effort                     | Новые open/closed roots наблюдаются через `attachShadow`; доступны и существовавшие open roots. Обход старых closed roots недоступен. |
| SPA navigation                  | Поддерживается                  | `pushState`, `replaceState` и `popstate` сохраняют document identity и доставку записей.                                              |
| Full navigation                 | Поддерживается                  | Новый document получает новый `documentId`, устаревший context state очищается.                                                       |
| BFCache                         | Требуется перезагрузка          | `pagehide` останавливает сборщик; возврат с `pageshow.persisted=true` не возобновляет сбор автоматически.                             |
| Dedicated/shared/service Worker | Не поддерживается в MVP         | Popup сообщает об отсутствии поддержки Worker-контекстов.                                                                             |

Каждая запись содержит `tabId`, `frameId`, `documentId`, `contextKind`, target identity и listener metadata. Event payload, callback body, DOM text, clipboard и input values не собираются и не попадают в logs. Диагностические сообщения используют уровни `DEBUG`, `INFO`, `WARN`, `ERROR`; значения событий и payload в них не выводятся.

Unit и integration tests проверяют границы site scope, нормализацию metadata, permissions reconciliation, readiness и UI-действия. Браузерные проверки расширения должны устанавливать настоящую сборку, выдавать одному сайту доступ и проверять реальные записи после reload, изоляцию второго hostname и очистку после revoke.

Панель результатов проверяется на поиск по разрешённым полям, группировку, счётчики и доступность карточек. При обновлении снимка того же главного документа поиск сохраняется; смена сайта, документа или отзыв доступа сбрасывают его. Идентификатор главного документа передаётся из подтверждённой background session, поэтому сброс работает и без main-frame записей. Chromium и Firefox E2E проверяют поиск и раскрытие metadata в настоящем action popup.

Общий сценарий `tests/e2e/detection-coverage.mjs` проверяет property/inline assign, replace, remove и readd со стабильным ID, нативные getter и `return false`, новые open/closed Shadow DOM, три перехода SPA, замену документа при полной навигации, переполнение буфера и отсутствие тестовых секретов в снимке. Отдельная регистрация после подтверждения установки сборщиков проверяет разрешённый iframe и изоляцию фрейма другого hostname.

Сценарий прошёл 18 октября 2026 года на Playwright Chromium `153.0.8010.12` и Firefox `155.0` с установленными production-сборками расширения.

Проверка BFCache требует настоящего перехода A → B → назад: fixture должна получить `pageshow.persisted=true` и сохранить случайный токен документа. Затем проверяем `reload-required`, отсутствие старых записей и новый сбор после reload. Для Chromium убираем флаг Playwright `--disable-back-forward-cache`. В тестовой сборке Firefox после запуска включаем `fission.bfcacheInParent` через Marionette: startup сбрасывает значение из профиля. Синтетическое событие или повторная загрузка страницы не засчитываются.

Допустимые имена регистраций и русские описания задаёт единый модуль `src/shared/event-catalog/catalog.ts`. Bridge, проверка inline/property surfaces и production background используют один каталог из 37 типов. В `addEventListener` и сообщениях background имена проверяются с учётом регистра; HTML-атрибуты нормализуются при чтении поверхности. Список групп и ограничения приведены в [каталоге событий](event-catalog.md).

Firefox smoke открывает fixture и проверяет наличие сборки; add-on он не устанавливает. Команда `test:e2e:firefox` проверяет установленный add-on через встроенный Marionette и управляет настоящим диалогом разрешений Firefox. WebDriver BiDi позволяет установить add-on, но ограничивает переход на `moz-extension:` для управления popup.

`test:e2e:chromium` проверяет сбор и изоляцию с программной подготовкой grant. Отдельная команда `pnpm test:e2e:chromium:native` на macOS открывает настоящий action popup и управляет нативным диалогом через Accessibility. Она проверяет отказ, подтверждение, reload, отзыв, изоляцию и полный restart с сохранённым grant; программной подготовки grant в ней нет. Проверка прошла на Playwright Chromium `153.0.8010.12`, а стабильный Google Chrome и весь заявленный диапазон версий отдельно не проверялись. Требования и ручной сценарий описаны в [доступе к сайту](site-access.md#проверка-нативного-запроса). Нативный тест не входит в общий headless-набор. `web-ext lint` остаётся отдельным release gate.

## Ограничения

Hook устанавливается best-effort на `document_start`. Скрипты, выполнившиеся до hook, browser-protected URLs и изолированные cross-origin/frame contexts могут быть недоступны. Расширение не записывает event payload, clipboard/input values или callback body и не выполняет сетевые запросы.

Property hooks сохраняют нативные configurable accessors `on...` на `window`, `document` и поддерживаемых DOM-прототипах. Callback не оборачивается; forwarding-свойства `body`/`frameset` для `blur`, `error`, `focus`, `load`, `scroll` используют общий slot с `window`. Собственные descriptors страницы могут обойти hook. Inline observer отслеживает имена атрибутов, их изменения и вставленные поддеревья, не читая код атрибутов. Изменения одного inline slot в пределах microtask объединяются по текущему состоянию.

Firefox `gecko.id` в прототипе использует placeholder `listener-lens@example.invalid`. Перед публикацией его нужно заменить на контролируемый стабильный ID и повторить privacy/manifest audit.

## Логирование

В development `createLogger` использует `DEBUG`; уровень можно изменить через `globalThis.LOG_LEVEL` (`debug`, `info`, `warn`, `error`) в нужном контексте. В production порог — `WARN`. Диагностика доступа содержит ID операции/вкладки/документа и код причины, без URL, nonce и пользовательских данных.

## См. также

- [Каталог событий](event-catalog.md)
- [Панель результатов](popup-results.md)
- [Доступ к сайту](site-access.md)
