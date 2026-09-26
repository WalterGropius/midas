// Concurrency primitives: a semaphore-style limiter, retries with backoff,
// timeouts, and a periodic loop that never overlaps itself.
import { logger } from '../log';

const log = logger('async');

export function limiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };
  function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  }
  limit.active = () => active;
  limit.pending = () => queue.length;
  return limit;
}

export type Limiter = ReturnType<typeof limiter>;

/** Runs callbacks sharing a key one at a time (e.g. one decision per session). */
export function keyedMutex() {
  const tails = new Map<string, Promise<unknown>>();
  return function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body = ''
  ) {
    super(message);
  }
}

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  const msg = String((err as Error)?.message ?? err);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timeout|aborted/i.test(msg);
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; maxMs?: number; label?: string } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 20_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryable(err)) break;
      const delay = Math.min(max, base * 2 ** i) * (0.5 + Math.random());
      log.debug('retrying', { label: opts.label, attempt: i + 1, delayMs: Math.round(delay), err: String(err) });
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`${init.method ?? 'GET'} ${url} → ${res.status}`, res.status, text.slice(0, 500));
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` every `ms`; a slow run delays the next instead of overlapping it. */
export function every(label: string, ms: number, fn: () => Promise<void>, opts: { immediate?: boolean } = {}) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try {
      await fn();
    } catch (err) {
      log.error('loop failed', { loop: label, err: String((err as Error)?.stack ?? err) });
    }
    if (!stopped) timer = setTimeout(run, Math.max(0, ms - (Date.now() - t0)));
  };
  timer = setTimeout(run, opts.immediate === false ? ms : 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function jsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}
