// SpacetimeDB connection for the engine. The engine subscribes to every table,
// so its client cache is a live replica of the whole world state; reads are
// local and instant, writes go through reducers.
import fs from 'node:fs';
import { DbConnection } from '@midas/stdb-bindings';
import type { Identity } from 'spacetimedb';
import { config } from './config';
import { logger } from './log';
import { sleep } from './util/async';

const log = logger('stdb');

export type Conn = DbConnection;

function readToken(): string | undefined {
  if (config.stdb.token) return config.stdb.token;
  try {
    return fs.readFileSync(config.stdb.tokenFile, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string) {
  try {
    fs.writeFileSync(config.stdb.tokenFile, token, { mode: 0o600 });
  } catch (err) {
    log.warn('could not persist token', { err: String(err) });
  }
}

export interface Stdb {
  conn: Conn;
  identity: Identity;
}

/** Connect, persist the identity token, subscribe to everything, and wait for the initial sync. */
export async function connectStdb(): Promise<Stdb> {
  return new Promise<Stdb>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`SpacetimeDB connect timeout (${config.stdb.uri}/${config.stdb.database})`));
    }, 30_000);
    DbConnection.builder()
      .withUri(config.stdb.uri)
      .withDatabaseName(config.stdb.database)
      .withToken(readToken())
      .onConnect((conn, identity, token) => {
        writeToken(token);
        log.info('connected', { identity: identity.toHexString().slice(0, 16), db: config.stdb.database });
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ conn, identity });
          })
          .onError(ctx => {
            log.error('subscription error', { err: String((ctx as { event?: unknown }).event ?? 'unknown') });
          })
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      })
      .onDisconnect((_ctx, err) => {
        log.error('disconnected from SpacetimeDB — exiting so the supervisor restarts us', { err: String(err ?? '') });
        // All state lives in SpacetimeDB: a clean restart is the recovery strategy.
        setTimeout(() => process.exit(2), 500);
      })
      .build();
  });
}

/** Claim the 'engine' role (first engine wins; later ones queue for admin approval). */
export async function ensureEngineRole(stdb: Stdb): Promise<void> {
  const { conn, identity } = stdb;
  const me = () => conn.db.operator.identity.find(identity);
  if (me()?.role === 'engine' || me()?.role === 'admin') return;
  await conn.reducers.claimOperator({ role: 'engine' });
  for (let i = 0; i < 20 && !me(); i++) await sleep(100);
  const role = me()?.role;
  if (role !== 'engine' && role !== 'admin') {
    throw new Error(
      `this engine identity (${identity.toHexString()}) is not an operator; an admin must approve its request in the UI (Settings → Operators)`
    );
  }
  log.info('operator role', { role });
}

export function haltAll(conn: Conn): boolean {
  return conn.db.globalFlag.key.find('halt_all')?.value === 'true';
}
