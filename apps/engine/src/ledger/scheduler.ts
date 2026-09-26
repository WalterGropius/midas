// The heartbeat of the slow loops: enqueue periodic tasks with time-bucketed
// dedupe keys, so any number of leaders can run without double-scheduling.
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { task, type TaskInput } from './types';

function bucket(minutes: number): number {
  return Math.floor(Date.now() / (minutes * 60_000));
}

export async function schedule(ctx: EngineCtx) {
  const l = config.loops;
  const tasks: TaskInput[] = [];
  const watched = ctx.hub.watched().size;
  if (watched > 0) {
    tasks.push(task('forecast', `forecast:${bucket(l.forecastEveryMin)}`, {}, { priority: 30, maxAttempts: 1 }));
    tasks.push(task('arb', `arb:${bucket(10)}`, {}, { priority: 20, maxAttempts: 1 }));
  }
  tasks.push(task('calibrate', `calibrate:${bucket(l.calibrateEveryMin)}`, {}, { priority: 10, maxAttempts: 1 }));
  tasks.push(task('dream', `dream:${bucket(l.dreamEveryMin)}`, {}, { priority: 1, maxAttempts: 1 }));
  tasks.push(task('evolve', `evolve:${bucket(l.evolveEveryMin)}`, {}, { priority: 5, maxAttempts: 1 }));
  tasks.push(task('coach', `coach:${bucket(l.coachEveryMin)}`, {}, { priority: 5, maxAttempts: 1 }));
  for (const s of ctx.conn.db.session.iter()) {
    if (s.status !== 'running' && s.status !== 'paused') continue;
    tasks.push(task('wiki', `wiki:${s.id}:${bucket(l.wikiEveryMin)}`, { sessionId: s.id.toString() }, { sessionId: s.id, priority: 3, maxAttempts: 1 }));
  }
  await ctx.conn.reducers.enqueueTasks({ tasks });
}
