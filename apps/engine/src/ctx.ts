// The engine context threaded through every loop and task handler.
import type { Identity } from 'spacetimedb';
import type { Alerts } from './connectors/alerts';
import type { MarketHub } from './market/hub';
import type { GraphMemory } from './memory/graph';
import type { ReflexEngine } from './s1/reflexes';
import type { Conn } from './stdb';

export interface ActivityItem {
  sessionId: bigint;
  level: 'debug' | 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  refId: string;
}

export interface EngineCtx {
  conn: Conn;
  identity: Identity;
  reflexes: ReflexEngine;
  hub: MarketHub;
  graph: GraphMemory;
  alerts: Alerts;
  activity(item: Omit<ActivityItem, 'refId'> & { refId?: string }): void;
}

/** Buffers activity rows and flushes them in one reducer call. */
export class ActivityBuffer {
  private items: ActivityItem[] = [];
  push(i: Omit<ActivityItem, 'refId'> & { refId?: string }) {
    this.items.push({ ...i, refId: i.refId ?? '' });
    if (this.items.length > 500) this.items.splice(0, this.items.length - 500);
  }
  async flush(conn: Conn) {
    if (this.items.length === 0) return;
    const items = this.items.splice(0, 200);
    await conn.reducers.logActivities({ items });
  }
}
