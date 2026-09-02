import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, todayLocal } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const THRESHOLD: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = THRESHOLD[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? THRESHOLD.info;

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (THRESHOLD[level] < minLevel) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const detail = extra === undefined ? '' : ` ${safeStringify(extra)}`;

  // stdout so `launchctl` captures it too, and a dated file for scrollback.
  const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  sink.write(line + detail + '\n');

  try {
    appendFileSync(join(PATHS.logs, `${todayLocal()}.log`), line + detail + '\n');
  } catch {
    // Logging must never take the agent down.
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => write('debug', scope, message, extra),
    info: (message: string, extra?: unknown) => write('info', scope, message, extra),
    warn: (message: string, extra?: unknown) => write('warn', scope, message, extra),
    error: (message: string, extra?: unknown) => write('error', scope, message, extra),
  };
}
