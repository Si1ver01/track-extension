import type { SiteCoverage } from "../../shared/contracts/site-access";
import { RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";

export function CoverageNotice({
  coverage,
  limited,
  onReload,
}: {
  coverage?: SiteCoverage;
  limited: boolean;
  onReload?: () => void;
}) {
  const reasons = coverage?.reasons ?? [];
  return (
    <aside
      className={limited ? "coverage-notice" : "coverage-footnote"}
      aria-label="Покрытие сбора"
      aria-live="polite"
    >
      {limited && (
        <ul>
          {reasons.includes("FRAME_PARTIAL") && (
            <li>
              Покрытие встроенных фреймов ограничено. Разрешение текущего сайта
              не даёт доступа к другим адресам. Если нужен фрейм другого сайта,
              откройте его отдельно, разрешите доступ и перезагрузите исходную
              вкладку.
            </li>
          )}
          {reasons.includes("RECORD_LIMIT_REACHED") && (
            <li>
              Достигнут лимит сбора. В снимке остаётся не более{" "}
              {coverage?.recordLimit} последних записей; поиск проверяет только
              их. Перезагрузка начнёт сбор заново.
            </li>
          )}
          {reasons.length === 0 && (
            <li>
              Причина неполного результата недоступна. Перезагрузите вкладку,
              чтобы повторить сбор.
            </li>
          )}
        </ul>
      )}
      <p>
        Обработчики, зарегистрированные до запуска сборщика, могут
        отсутствовать.
      </p>
      {limited && onReload && (
        <div className="coverage-actions">
          <Button variant="outline" size="sm" onClick={onReload}>
            <RefreshCw />
            Перезагрузить вкладку
          </Button>
        </div>
      )}
    </aside>
  );
}
