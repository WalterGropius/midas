// Build-time defaults (NEXT_PUBLIC_* are inlined by Next) with an optional
// per-browser override saved from the Settings page, so one static deploy can
// point at any SpacetimeDB host.

export const DEFAULT_STDB_URI = process.env.NEXT_PUBLIC_STDB_URI || 'ws://127.0.0.1:3000';
export const DEFAULT_STDB_DB = process.env.NEXT_PUBLIC_STDB_DB || 'midas';
export const ENGINE_URL = (process.env.NEXT_PUBLIC_ENGINE_URL || '').replace(/\/+$/, '');

const OVERRIDE_KEY = 'midas.connection';

export interface ConnectionTarget {
  uri: string;
  db: string;
}

function readStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: nothing to persist */
  }
}

export function connectionTarget(): ConnectionTarget {
  const raw = readStorage(OVERRIDE_KEY);
  if (raw) {
    try {
      const o = JSON.parse(raw) as Partial<ConnectionTarget>;
      if (o.uri && o.db) return { uri: o.uri, db: o.db };
    } catch {
      /* ignore corrupt override */
    }
  }
  return { uri: DEFAULT_STDB_URI, db: DEFAULT_STDB_DB };
}

export function setConnectionOverride(t: ConnectionTarget | null) {
  writeStorage(OVERRIDE_KEY, t ? JSON.stringify(t) : null);
}

export function hasConnectionOverride(): boolean {
  return readStorage(OVERRIDE_KEY) !== null;
}

function tokenKey(t: ConnectionTarget) {
  return `midas.token:${t.uri}/${t.db}`;
}

export function loadToken(t: ConnectionTarget): string | undefined {
  return readStorage(tokenKey(t)) || undefined;
}

export function saveToken(t: ConnectionTarget, token: string | null) {
  writeStorage(tokenKey(t), token);
}
