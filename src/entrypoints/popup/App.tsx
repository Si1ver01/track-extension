import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Camera,
  CircleAlert,
  GitCompare,
  Globe,
  List,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";
import { useSiteAccess } from "./useSiteAccess";
import { ResultsPanel } from "./ResultsPanel";
import { CoverageNotice } from "./CoverageNotice";
import { SnapshotComparison } from "./SnapshotComparison";
import { SnapshotExport } from "./SnapshotExport";
import type { ListenerRecord } from "../../shared/contracts/records";

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
  const {
    snapshot,
    pending,
    issue,
    grant,
    reload,
    revoke,
    retry,
    reveal,
    changeBaseline,
  } = useSiteAccess();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [visibleRecords, setVisibleRecords] = useState<ListenerRecord[]>([]);
  const status = snapshot?.status;
  const hasAccess =
    snapshot?.site && status !== "no-access" && status !== "unsupported";
  const showRecords =
    (status === "ready" || status === "limited") && !pending && !issue;
  const showGrantAction = status === "no-access" && Boolean(snapshot?.site);
  const showReloadAction = status === "reload-required" || status === "limited";
  const hasBottomAction = showGrantAction || showReloadAction;

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
  const statusLabel = pending
    ? "Ожидание"
    : status === "ready"
      ? "Сбор активен"
      : status === "limited"
        ? "Неполное покрытие"
        : status === "no-access"
          ? "Нет доступа"
          : status === "reload-required"
            ? "Нужна перезагрузка"
            : status === "unsupported"
              ? "Недоступно"
              : issue || status === "error"
                ? "Ошибка"
                : "Проверка";
  const statusClass =
    status === "ready"
      ? "status-ready"
      : status === "limited"
        ? "status-limited"
        : status === "no-access" || status === "unsupported"
          ? "status-blocked"
          : "status-waiting";
  const stateTitle =
    status === "no-access"
      ? "Разрешите сбор обработчиков"
      : status === "reload-required"
        ? "Начните сбор с загрузки страницы"
        : status === "recovering" || pending
          ? "Собираем обработчики…"
          : status === "unsupported"
            ? "Страница недоступна"
            : issue || status === "error"
              ? "Не удалось запустить сбор"
              : "Проверяем доступ к сайту…";

  return (
    <div
      className="app-shell"
      aria-busy={Boolean(pending) || (!snapshot && !issue)}
    >
      <header className="app-header">
        <div className="app-brand">
          <span className="brand-mark" aria-hidden="true">
            <Activity />
          </span>
          <h1>Listener Lens</h1>
        </div>
        <div className="header-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Обновить данные"
            title="Обновить данные"
            disabled={Boolean(pending)}
            onClick={retry}
          >
            <RefreshCw />
          </Button>
          {hasAccess && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Управление доступом"
                  title="Управление доступом"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={Boolean(pending)}
                  onSelect={() => revoke()}
                >
                  <ShieldX />
                  Отозвать доступ
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      {snapshot?.site && (
        <div className="site-meta">
          <span className="site-label">
            <Globe aria-hidden="true" />
            <span>{snapshot.site.label}</span>
          </span>
          <Badge variant="secondary" className={"status-badge " + statusClass}>
            {statusLabel}
          </Badge>
        </div>
      )}
      {showRecords && snapshot ? (
        <>
          <Tabs defaultValue="records" className="app-tabs">
            <TabsList
              className="app-tabs-list"
              aria-label="Разделы Listener Lens"
            >
              <TabsTrigger value="records">
                <List aria-hidden="true" />
                Обработчики
              </TabsTrigger>
              <TabsTrigger value="comparison">
                <GitCompare aria-hidden="true" />
                Сравнение
              </TabsTrigger>
            </TabsList>
            <TabsContent value="records" className="app-tab-panel">
              <p
                ref={statusRef}
                className="sr-only"
                tabIndex={-1}
                role="status"
                aria-live="polite"
              >
                {message}
              </p>
              <CoverageNotice
                coverage={snapshot.coverage}
                limited={status === "limited"}
                onReload={reload}
              />
              <ResultsPanel
                key={JSON.stringify([
                  snapshot.tabId,
                  snapshot.site?.pattern,
                  snapshot.documentId,
                ])}
                records={snapshot.records}
                partial={status === "limited"}
                coverage={snapshot.coverage}
                documentId={snapshot.documentId}
                onRefresh={retry}
                onReveal={reveal}
                onVisibleRecordsChange={setVisibleRecords}
                showExport={false}
              />
              <p className="scope">Worker-контексты не поддерживаются в MVP.</p>
            </TabsContent>
            <TabsContent value="comparison" className="app-tab-panel">
              <SnapshotComparison
                records={snapshot.records}
                context={{
                  partial: status === "limited",
                  coverage: snapshot.coverage,
                  documentId: snapshot.documentId,
                }}
                onRefresh={retry}
                baseline={snapshot.baseline ?? null}
                onBaselineChange={changeBaseline}
                hideCaptureAction
              />
            </TabsContent>
          </Tabs>
          <footer className="app-footer" aria-label="Действия со снимком">
            <Button
              onClick={() => void changeBaseline(true)}
              disabled={Boolean(pending)}
            >
              <Camera />
              {snapshot.baseline ? "Заменить снимок" : "Запомнить снимок"}
            </Button>
            <SnapshotExport
              records={snapshot.records}
              visibleRecords={visibleRecords}
              context={{
                partial: status === "limited",
                coverage: snapshot.coverage,
                documentId: snapshot.documentId,
              }}
            />
          </footer>
        </>
      ) : (
        <main className="state-main">
          <section className="state-content" aria-labelledby="state-title">
            <span
              className={
                "state-icon " +
                (issue || status === "error"
                  ? "state-icon-danger"
                  : status === "reload-required"
                    ? "state-icon-warning"
                    : "state-icon-neutral")
              }
              aria-hidden="true"
            >
              {issue || status === "error" ? <CircleAlert /> : <ShieldCheck />}
            </span>
            <h2 id="state-title">{stateTitle}</h2>
            <Alert
              ref={statusRef}
              tabIndex={-1}
              role={issue || status === "error" ? "alert" : "status"}
              aria-live="polite"
              variant={issue || status === "error" ? "destructive" : "default"}
              className="status-alert"
            >
              <AlertDescription>{message}</AlertDescription>
            </Alert>
            {(issue || status === "error") && (
              <div className="state-actions">
                <Button disabled={Boolean(pending)} onClick={retry}>
                  <RefreshCw />
                  Повторить проверку
                </Button>
              </div>
            )}
          </section>
          {(hasBottomAction || hasAccess) && (
            <footer className="state-footer">
              <p>
                {hasAccess
                  ? `Доступ к ${snapshot?.site?.label} уже разрешён`
                  : "Доступ действует для всех страниц и портов этого адреса."}
              </p>
              {hasBottomAction && (
                <div className="state-actions">
                  {showGrantAction && (
                    <Button disabled={Boolean(pending)} onClick={grant}>
                      <ShieldCheck />
                      Разрешить для этого сайта
                    </Button>
                  )}
                  {showReloadAction && (
                    <Button disabled={Boolean(pending)} onClick={reload}>
                      <RefreshCw />
                      Перезагрузить вкладку
                    </Button>
                  )}
                </div>
              )}
            </footer>
          )}
        </main>
      )}
    </div>
  );
}
