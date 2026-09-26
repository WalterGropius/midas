// Minimal structured logger: one line per event, greppable key=value pairs.
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.MIDAS_LOG_LEVEL as Level) ?? 'info'] ?? 20;

function fmt(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  } catch {
    return String(v);
  }
}

function emit(level: Level, scope: string, msg: string, kv?: Record<string, unknown>) {
  if (ORDER[level] < MIN) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), `[${scope}]`, msg];
  if (kv) for (const [k, v] of Object.entries(kv)) parts.push(`${k}=${fmt(v)}`);
  const line = parts.join(' ');
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, kv?: Record<string, unknown>) => emit('debug', scope, msg, kv),
    info: (msg: string, kv?: Record<string, unknown>) => emit('info', scope, msg, kv),
    warn: (msg: string, kv?: Record<string, unknown>) => emit('warn', scope, msg, kv),
    error: (msg: string, kv?: Record<string, unknown>) => emit('error', scope, msg, kv),
  };
}

export type Logger = ReturnType<typeof logger>;
