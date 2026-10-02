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

Unit и integration tests проверяют нормализацию metadata, запрет payload-полей, маршрутизацию по вкладке/frame и privacy metadata. Chromium E2E загружает unpacked extension в persistent context, открывает fixture и проверяет popup. Firefox smoke проверяет Firefox fixture и наличие Firefox build; реальная загрузка add-on через WebDriver BiDi и `web-ext lint` остаётся отдельным release gate.

## Ограничения

Hook устанавливается best-effort на `document_start`. Скрипты, выполнившиеся до hook, browser-protected URLs и изолированные cross-origin/frame contexts могут быть недоступны. Расширение не записывает event payload, clipboard/input values или callback body и не выполняет сетевые запросы.

Firefox `gecko.id` в прототипе использует placeholder `listener-lens@example.invalid`. Перед публикацией его нужно заменить на контролируемый стабильный ID и повторить privacy/manifest audit.
