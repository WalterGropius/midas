'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from '@midas/stdb-bindings';
import { connectionTarget, loadToken, saveToken } from '@/lib/config';

export function Providers({ children }: { children: ReactNode }) {
  const builder = useMemo(() => {
    const target = connectionTarget();
    return DbConnection.builder()
      .withUri(target.uri)
      .withDatabaseName(target.db)
      .withToken(loadToken(target))
      .onConnect((_conn, _identity, token) => saveToken(target, token))
      .onConnectError((_ctx, err) => {
        // A token minted by another server (or a wiped database) is rejected:
        // forget it so the next reconnect gets a fresh anonymous identity.
        if (/401|unauthori[sz]ed|invalid token/i.test(String(err?.message ?? err))) saveToken(target, null);
        console.warn('[midas] SpacetimeDB connect error', err);
      });
  }, []);

  return <SpacetimeDBProvider connectionBuilder={builder}>{children}</SpacetimeDBProvider>;
}

/**
 * Everything below renders only in the browser. The static HTML is just the
 * shell; data arrives over the WebSocket, so there is nothing to prerender and
 * this sidesteps hydration mismatches from clocks and localStorage.
 */
export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : <>{fallback}</>;
}
