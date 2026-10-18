import { useEffect, useRef } from "react";
import { useSiteAccess } from "./useSiteAccess";
import { ResultsPanel } from "./ResultsPanel";
import { CoverageNotice } from "./CoverageNotice";

const statusMessages = {
  unsupported:
    "На этой странице расширение недоступно. Откройте обычный сайт по HTTP или HTTPS.",
  "no-access":
    "Разрешите доступ, чтобы видеть обработчики событий на этом сайте.",
  "reload-required":
    "Доступ разрешён. Перезагрузите вкладку, чтобы начать сбор с загрузки страницы.",
  recovering: "Ожидаем готовности страницы и собираем обработчики…",
  ready: "Сбор обработчиков работает.",
  limited:
    "Часть обработчиков может быть недоступна. Ниже показаны полученные данные.",
  error:
    "Не удалось запустить сбор обработчиков. Повторите проверку или перезагрузите страницу.",
};

const issueMessages = {
  load: "Не удалось получить состояние вкладки. Повторите проверку.",
  grant: "Не удалось разрешить доступ. Повторите запрос.",
  reload:
    "Не удалось перезагрузить вкладку. Проверьте, что она открыта, и повторите попытку.",
  revoke: "Не удалось отозвать доступ. Повторите попытку.",
  denied: "Доступ не предоставлен. Вы можете разрешить его позже.",
  changed: "Вкладка перешла на другой сайт. Проверьте доступ заново.",
  timeout:
    "Страница не подтвердила готовность. Повторите проверку или перезагрузите её.",
};

const pendingMessages = {
  grant: "Подтвердите доступ в окне браузера…",
  reload: "Перезагружаем вкладку…",
  revoke: "Отзываем доступ…",
};

export function App() {
  const { snapshot, pending, issue, grant, reload, revoke, retry } =
    useSiteAccess();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const status = snapshot?.status;
  const hasAccess =
    snapshot?.site && status !== "no-access" && status !== "unsupported";
  const showRecords =
    (status === "ready" || status === "limited") && !pending && !issue;

  useEffect(() => {
    if (issue || status === "reload-required") statusRef.current?.focus();
  }, [issue, status]);

  const message = pending
    ? pendingMessages[pending]
    : issue
      ? issueMessages[issue]
      : status
        ? statusMessages[status]
        : "Проверяем доступ к сайту…";

  return (
    <main aria-busy={Boolean(pending) || (!snapshot && !issue)}>
      <h1>Listener Lens</h1>
      {snapshot?.site && <p className="site">{snapshot.site.label}</p>}
      <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite">
        {message}
      </p>
      {snapshot?.site && status !== "unsupported" && (
        <p className="scope">
          Доступ действует для всех страниц и портов этого адреса.
        </p>
      )}
      <div className="actions">
        {status === "no-access" && snapshot?.site && (
          <button type="button" disabled={Boolean(pending)} onClick={grant}>
            Разрешить для этого сайта
          </button>
        )}
        {(status === "reload-required" || status === "limited") && (
          <button type="button" disabled={Boolean(pending)} onClick={reload}>
            Перезагрузить вкладку
          </button>
        )}
        {(issue || status === "error") && (
          <button type="button" disabled={Boolean(pending)} onClick={retry}>
            Повторить проверку
          </button>
        )}
        {hasAccess && (
          <button
            type="button"
            className="secondary"
            disabled={Boolean(pending)}
            onClick={revoke}
          >
            Отозвать доступ
          </button>
        )}
      </div>
      {showRecords && snapshot && (
        <>
          <CoverageNotice
            coverage={snapshot.coverage}
            limited={status === "limited"}
          />
          <ResultsPanel
            key={JSON.stringify([
              snapshot.tabId,
              snapshot.site?.pattern,
              snapshot.documentId,
            ])}
            records={snapshot.records}
            partial={status === "limited"}
          />
          <p className="scope">Worker-контексты не поддерживаются в MVP.</p>
        </>
      )}
    </main>
  );
}
