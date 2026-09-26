import { Timestamp } from 'spacetimedb';

export function tsFromMs(ms: number): Timestamp {
  return new Timestamp(BigInt(Math.round(ms)) * 1000n);
}

export function msFromTs(ts: Timestamp): number {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

export function minutesSince(ts: Timestamp, nowMs = Date.now()): number {
  return (nowMs - msFromTs(ts)) / 60_000;
}

export function ref(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function utcDay(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}
