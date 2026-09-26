'use client';

import { useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { Button, Card, ErrorText, Field, inputCls } from '@/components/ui';
import {
  DEFAULT_STDB_DB,
  DEFAULT_STDB_URI,
  ENGINE_URL,
  connectionTarget,
  hasConnectionOverride,
  saveToken,
  setConnectionOverride,
} from '@/lib/config';

export function ConnectionCard() {
  const { isActive, identity, connectionError } = useSpacetimeDB();
  const target = connectionTarget();
  const [uri, setUri] = useState(target.uri);
  const [db, setDb] = useState(target.db);
  const [copied, setCopied] = useState(false);
  const hex = identity?.toHexString() ?? '';

  const apply = () => {
    setConnectionOverride(uri === DEFAULT_STDB_URI && db === DEFAULT_STDB_DB ? null : { uri: uri.trim(), db: db.trim() });
    window.location.reload();
  };

  return (
    <Card title="Connection">
      <div className="space-y-3 text-xs">
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted">Status</dt>
          <dd className={isActive ? 'text-good' : connectionError ? 'text-crit' : 'text-warn'}>
            <span aria-hidden>{isActive ? '●' : '○'}</span> {isActive ? 'connected' : connectionError ? `error: ${connectionError.message}` : 'connecting…'}
          </dd>
          <dt className="text-muted">SpacetimeDB</dt>
          <dd className="num break-all text-ink">{target.uri}</dd>
          <dt className="text-muted">Database</dt>
          <dd className="num text-ink">{target.db}</dd>
          <dt className="text-muted">My identity</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="num min-w-0 break-all text-ink">{hex || '—'}</span>
            {hex && (
              <button
                type="button"
                className="shrink-0 text-accent hover:underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(hex).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
                }}
              >
                {copied ? 'copied' : 'copy'}
              </button>
            )}
          </dd>
        </dl>
        <p className="text-muted">
          Your identity is a token kept in this browser. Sessions you create belong to it; clearing site data or using another browser gives
          you a different identity.
        </p>
        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-ink-2">Point this browser at another database</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_160px]">
            <Field label="URI" hint="e.g. wss://maincloud.spacetimedb.com">
              <input className={inputCls} value={uri} onChange={e => setUri(e.target.value)} />
            </Field>
            <Field label="Database">
              <input className={inputCls} value={db} onChange={e => setDb(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={apply} disabled={!uri.trim() || !db.trim()}>
              Save & reconnect
            </Button>
            {hasConnectionOverride() && (
              <Button size="sm" variant="ghost" onClick={() => (setConnectionOverride(null), window.location.reload())}>
                Use build default ({DEFAULT_STDB_URI})
              </Button>
            )}
          </div>
        </details>
        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-ink-2">Reset my identity</summary>
          <p className="mt-2 text-muted">
            Forgets the token for this database and reconnects as a brand-new identity. You lose control of sessions and operator roles tied to
            the current one.
          </p>
          <Button
            size="sm"
            variant="danger"
            className="mt-2"
            onClick={() => {
              if (window.confirm('Forget this identity? This cannot be undone from the UI.')) {
                saveToken(target, null);
                window.location.reload();
              }
            }}
          >
            Forget identity & reconnect
          </Button>
        </details>
      </div>
    </Card>
  );
}

export function EnginePing() {
  const [state, setState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ENGINE_URL) {
    return (
      <p className="text-xs text-muted">
        No engine control URL configured (NEXT_PUBLIC_ENGINE_URL). The UI does not need one: engine status comes from heartbeats in
        SpacetimeDB.
      </p>
    );
  }
  const ping = async () => {
    setState('pinging…');
    setError(null);
    const t0 = performance.now();
    try {
      const res = await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(8000) });
      setState(`HTTP ${res.status} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      setState(null);
      setError(`unreachable: ${(e as Error).message}`);
    }
  };
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-ink-2">{ENGINE_URL}</span>
        <Button size="sm" onClick={() => void ping()}>
          Ping engine
        </Button>
        <a className="text-accent hover:underline" href={`${ENGINE_URL}/health`} target="_blank" rel="noopener noreferrer">
          open ↗
        </a>
        {state && <span className="num text-muted">{state}</span>}
      </div>
      <ErrorText error={error} />
    </div>
  );
}
