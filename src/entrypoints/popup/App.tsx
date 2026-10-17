import { useEffect, useState } from "react";
import browser from "webextension-polyfill";
import {
  contextCapabilities,
  type TabState,
} from "../../shared/contracts/records";
import { createLogger } from "../../shared/logger";

const logger = createLogger("popup");

export function App() {
  const [state, setState] = useState<TabState | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab || tab.id === undefined)
          throw new Error("active tab has no id");
        const nextState = (await browser.runtime.sendMessage({
          type: "get-tab-state",
          tabId: tab.id,
        })) as TabState | undefined;
        if (!nextState) throw new Error("background returned no tab state");
        if (active) setState(nextState);
      } catch (requestError) {
        logger.warn("[FIX] popup state request failed", {
          error: String(requestError),
        });
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  if (error)
    return (
      <main>
        <p>Не удалось получить состояние вкладки.</p>
      </main>
    );
  if (!state)
    return (
      <main>
        <p>Сканирование…</p>
      </main>
    );
  return (
    <main>
      <h1>Listener Lens</h1>
      <p>Статус: {state.status}</p>
      <p>
        Worker-контексты:{" "}
        {contextCapabilities.find(
          (capability) => capability.contextKind === "worker",
        )?.supported
          ? "поддерживаются"
          : "не поддерживаются в MVP"}
      </p>
      {state.records.length === 0 ? (
        <p>События не найдены.</p>
      ) : (
        <ul>
          {state.records.map((record) => (
            <li key={record.id}>
              <strong>{record.eventType}</strong>
              <br />
              {record.description}
              <br />
              <small>
                {record.source.path} · frame {record.frameId} · document{" "}
                {record.documentId}
              </small>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
