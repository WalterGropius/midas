'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { Timestamp, type Identity } from 'spacetimedb';
import { DbConnection, tables } from '@midas/stdb-bindings';

export function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
  return !!a && !!b && a.toHexString() === b.toHexString();
}

/** The live connection (typed), or null before the socket exists. */
export function useConnection(): DbConnection | null {
  const { getConnection } = useSpacetimeDB();
  return getConnection() as DbConnection | null;
}

/** Ticking clock for relative times and freshness checks. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * A timestamp cutoff for "last N ms" subscriptions (null = everything), rounded
 * to `granMs` so the subscription SQL stays stable between renders: a new SQL
 * string means a new subscription.
 */
export function useCutoff(windowMs: number | null, granMs = 10 * 60_000): Timestamp {
  const now = useNow(granMs);
  const bucket = Math.floor(now / granMs);
  return useMemo(() => {
    if (windowMs === null) return new Timestamp(0n);
    const ms = Math.floor((bucket * granMs - windowMs) / granMs) * granMs;
    return new Timestamp(BigInt(ms) * 1000n);
  }, [bucket, windowMs, granMs]);
}

/** Start of the current UTC day (budgets and "today" stats are UTC). */
export function useUtcDayStart(): Timestamp {
  const now = useNow(60_000);
  const day = Math.floor(now / 86_400_000);
  return useMemo(() => new Timestamp(BigInt(day * 86_400_000) * 1000n), [day]);
}

/** My operator role ('admin' | 'engine') or undefined. */
export function useMyRole(): { role: string | undefined; ready: boolean } {
  const { identity } = useSpacetimeDB();
  const [ops, ready] = useTable(tables.operator);
  const role = ops.find(o => sameIdentity(o.identity, identity))?.role;
  return { role, ready };
}

/**
 * Wraps a reducer call with pending + error state so every button can surface
 * the server's SenderError message.
 */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { run, pending, error, clear };
}
