# Listener Lens

## TL;DR

Технический прототип browser extension фиксирует метаданные регистрации поддерживаемых DOM-событий и показывает их в popup. Пользовательские payloads, значения полей, clipboard content и callback body не собираются.

## Features

- `document_start` content script и best-effort listener hook.
- Локальный каталог описаний событий.
- Типизированная нормализация listener records.
- In-memory state с группировкой по вкладке и frame.
- Popup-first UI со статусом сканирования и списком событий.
- Manifest V3 metadata для Chromium и Firefox.

## Installation

```bash
pnpm install
pnpm exec wxt
```

## Usage

```bash
pnpm test
pnpm build
```

## Architecture / Stack

Проект использует `WXT`, `React`, `TypeScript`, Manifest V3 и `webextension-polyfill`. Content script передаёт records через bridge в background service worker. Service worker хранит ограниченное состояние текущих вкладок и отдаёт его popup через `browser.runtime`.

## Ограничения

Hook регистрируется best-effort. Скрипты, выполнившиеся раньше hook, browser-protected URLs и изолированные cross-origin/frame contexts могут быть недоступны. Сетевой запрос для описания событий не выполняется.
