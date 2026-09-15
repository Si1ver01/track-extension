export type BrowserName = 'chrome' | 'firefox' | 'unknown';
export type ListenerTarget = 'window' | 'document' | 'element' | 'unknown';

export interface SourceMetadata {
  target: ListenerTarget;
  path: string;
  options?: string[];
  scriptLocation?: string;
}

export interface ListenerRecord {
  id: string;
  eventType: string;
  description: string;
  tabId: number;
  frameId: number;
  source: SourceMetadata;
  browser: BrowserName;
  capturedAt: number;
  limitations: string[];
}

export interface ListenerMessage {
  type: 'listener-record' | 'scan-status' | 'get-tab-state';
  record?: ListenerRecord;
  tabId?: number;
}

export interface BridgeHandshake {
  source: 'listener-lens';
  type: 'install-bridge';
  nonce: string;
}

export interface BridgeRecordMessage extends ListenerMessage {
  source: 'listener-lens';
  nonce: string;
}

export function isListenerMessage(value: unknown): value is ListenerMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ListenerMessage>;
  if (message.type === 'get-tab-state') return Number.isInteger(message.tabId) && message.tabId! >= 0;
  if (message.type === 'scan-status') return true;
  if (message.type !== 'listener-record' || !message.record) return false;
  const record = message.record;
  return typeof record.id === 'string'
    && typeof record.eventType === 'string'
    && Number.isInteger(record.tabId) && record.tabId >= 0
    && Number.isInteger(record.frameId) && record.frameId >= 0
    && typeof record.source?.path === 'string';
}

export interface TabState {
  tabId: number;
  records: ListenerRecord[];
  status: 'scanning' | 'ready' | 'limited' | 'error';
}
