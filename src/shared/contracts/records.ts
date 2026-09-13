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

export interface TabState {
  tabId: number;
  records: ListenerRecord[];
  status: 'scanning' | 'ready' | 'limited' | 'error';
}
