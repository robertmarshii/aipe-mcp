// stderr logging (plan §3.2): codes, tool names and request ids only; never bodies, headers,
// keys or third-party text. stdout carries JSON-RPC frames and nothing else (U12).
import type { LogLevel } from './config.ts';

const ORDER: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

export type Logger = (level: LogLevel, code: string, detail?: Record<string, string | number | boolean | undefined>) => void;

export function makeLogger(level: LogLevel, write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  return (at, code, detail) => {
    if (ORDER[at] > ORDER[level]) return;
    const safe: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(detail ?? {})) {
      if (v === undefined) continue;
      safe[k] = typeof v === 'string' ? v.replace(/[^A-Za-z0-9_.:/-]/g, '').slice(0, 80) : v;
    }
    write(`aipe-mcp ${at} ${code}${Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : ''}\n`);
  };
}

/** Anything a dependency prints with console.* goes to stderr, never stdout. */
export function routeConsoleToStderr(): void {
  const toErr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : '[object]')).join(' ')}\n`);
  };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}
