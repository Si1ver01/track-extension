# Технический прототип

## Запуск

```bash
pnpm install
pnpm dev
```

Для проверки сборки используйте `pnpm build`, для тестов — `pnpm test`.

## Ограничения

Прототип собирает только метаданные регистрации listeners. Содержимое clipboard/input, значения пользовательских полей и callback body не передаются и не логируются. Hook устанавливается best-effort на `document_start`; скрипты, выполнившиеся раньше него, browser-protected URLs и изолированные cross-origin frames могут быть недоступны.
