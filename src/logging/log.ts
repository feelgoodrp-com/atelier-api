/**
 * In-memory ring buffer logger for the admin dashboard "Server-Logs" panel.
 * Keeps the last N structured lines and mirrors them to the console so the
 * container logs keep everything too. Subscribers (the SSE stream) get live
 * pushes. Process-local + ephemeral — NOT an audit trail (that's
 * atelierActivity), just operational visibility for whoever runs the server.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  seq: number;
  ts: number; // epoch ms
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
let seq = 0;
const subscribers = new Set<(e: LogEntry) => void>();

function push(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    seq: ++seq,
    ts: Date.now(),
    level,
    scope,
    msg,
    ...(data ? { data } : {}),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  const line = `[atelier-api:${scope}] ${msg}`;
  if (level === "error") console.error(line, data ?? "");
  else if (level === "warn") console.warn(line, data ?? "");
  else console.log(line, data ?? "");

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A broken subscriber must never break logging.
    }
  }
}

export const log = {
  info: (scope: string, msg: string, data?: Record<string, unknown>) => push("info", scope, msg, data),
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => push("warn", scope, msg, data),
  error: (scope: string, msg: string, data?: Record<string, unknown>) => push("error", scope, msg, data),
};

/** Snapshot of the last `limit` entries (oldest first). */
export function recentLogs(limit = MAX_ENTRIES): LogEntry[] {
  const n = Math.max(1, Math.min(limit, MAX_ENTRIES));
  return n >= buffer.length ? [...buffer] : buffer.slice(buffer.length - n);
}

/** Subscribe to live log entries. Returns an unsubscribe function. */
export function subscribeLogs(fn: (e: LogEntry) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
