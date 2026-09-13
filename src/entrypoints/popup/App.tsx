import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import type { TabState } from '../../shared/contracts/records';

export function App() {
  const [state, setState] = useState<TabState | null>(null);
  useEffect(() => { browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab.id !== undefined && browser.runtime.sendMessage({ type: 'get-tab-state', tabId: tab.id }).then(setState)); }, []);
  if (!state) return <main><p>Сканирование…</p></main>;
  return <main><h1>Listener Lens</h1><p>Статус: {state.status}</p>{state.records.length === 0 ? <p>События не найдены.</p> : <ul>{state.records.map((record) => <li key={record.id}><strong>{record.eventType}</strong><br />{record.description}<br /><small>{record.source.path} · frame {record.frameId}</small></li>)}</ul>}</main>;
}
