export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(scope: string) {
  const configured = import.meta.env?.PROD ? 'warn' : ((globalThis as { LOG_LEVEL?: LogLevel }).LOG_LEVEL ?? 'debug');
  return Object.fromEntries(
    (Object.keys(levelOrder) as LogLevel[]).map((level) => [level, (message: string, context?: unknown) => {
      if (levelOrder[level] < levelOrder[configured]) return;
      const method = level === 'debug' ? 'debug' : level;
      console[method](`[${scope}] ${message}`, context ?? '');
    }]),
  ) as Record<LogLevel, (message: string, context?: unknown) => void>;
}
