import { useEffect, useRef, useState } from "react";
import type { ListenerRecord } from "../../shared/contracts/records";
import type { RevealResult, RevealStatus } from "../../shared/contracts/reveal";

const messages: Record<RevealStatus, string> = {
  REVEALED: "Элемент подсвечен на странице на 2 секунды.",
  SHADOW_HOST: "Подсвечен host элемента Shadow DOM на 2 секунды.",
  TARGET_UNAVAILABLE: "Элемент удалён, скрыт или больше недоступен сборщику.",
  NO_ELEMENT: "У этой цели нет отдельного DOM-элемента.",
  DOCUMENT_CHANGED: "Документ изменился. Обновите снимок и повторите попытку.",
  ACCESS_DENIED:
    "Доступ к этому документу недоступен. Проверьте разрешение сайта.",
  REVEAL_FAILED:
    "Не удалось показать элемент. Обновите снимок и повторите попытку.",
  TIMEOUT: "Страница не ответила. Повторите попытку или перезагрузите её.",
  CANCELLED: "Подсветка отменена при смене состояния страницы.",
};

export type RevealAction = (record: ListenerRecord) => Promise<RevealResult>;

export function RevealTarget({
  record,
  onReveal,
}: {
  record: ListenerRecord;
  onReveal?: RevealAction;
}) {
  const [status, setStatus] = useState<RevealStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (record.source.target !== "element")
    return (
      <p className="scope">
        Цель: {record.source.target}. Отдельного DOM-элемента нет.
      </p>
    );
  async function reveal() {
    if (!onReveal || pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const result = await onReveal(record);
      if (mounted.current) setStatus(result.status);
    } catch {
      if (mounted.current) setStatus("REVEAL_FAILED");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="snapshot-tools">
      <button
        type="button"
        className="secondary"
        disabled={!onReveal || busy}
        onClick={() => void reveal()}
      >
        {busy ? "Ищем элемент…" : "Показать элемент"}
      </button>
      {status && <p role="status">{messages[status]}</p>}
    </div>
  );
}
