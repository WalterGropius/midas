// Ledger workers: pull runnable tasks from the SpacetimeDB synaptic ledger
// under a lease, run the handler, report completion (which cascades to
// dependents inside the database). Any number of engine processes can run
// workers; the lease makes each task run once, and a dead worker's tasks
// return to the queue when the lease expires.
import type { AgentTask } from '@midas/stdb-bindings/types';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { BudgetExceeded } from '../llm/gemini';
import { logger } from '../log';
import { jsonStringify, safeJson } from '../util/async';
import type { Handler } from './types';

const log = logger('worker');

interface Pool {
  name: string;
  kinds: string[];
  size: number;
  inflight: Set<bigint>;
}

export class LedgerWorker {
  private pools: Pool[];
  private inflight = new Map<bigint, AgentTask>();
  private timers: NodeJS.Timeout[] = [];
  private claiming = false;
  completed = 0;
  failed = 0;

  constructor(
    private ctx: EngineCtx,
    private handlers: Record<string, Handler>
  ) {
    const w = config.workers;
    this.pools = [
      { name: 'triage', kinds: ['triage'], size: w.triage, inflight: new Set() },
      { name: 'swarm', kinds: ['swarm'], size: w.swarm, inflight: new Set() },
      { name: 'deliberate', kinds: ['deliberate'], size: w.deliberate, inflight: new Set() },
      { name: 'decide', kinds: ['decide'], size: w.decide, inflight: new Set() },
      {
        name: 'background',
        kinds: Object.keys(handlers).filter(k => !['triage', 'swarm', 'deliberate', 'decide'].includes(k)),
        size: w.background,
        inflight: new Set(),
      },
    ];
  }

  start() {
    this.timers.push(setInterval(() => void this.tick(), 400));
    this.timers.push(setInterval(() => void this.extendLeases(), 30_000));
    log.info('workers up', { pools: this.pools.map(p => `${p.name}×${p.size}`).join(' '), worker: config.workerId });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  private runnable(kinds: string[]): boolean {
    const now = BigInt(Date.now()) * 1000n;
    for (const t of this.ctx.conn.db.agentTask.status.filter('pending')) {
      if (kinds.includes(t.kind) && t.notBefore.microsSinceUnixEpoch <= now) return true;
    }
    return false;
  }

  private async tick() {
    if (this.claiming) return;
    this.claiming = true;
    try {
      for (const pool of this.pools) {
        const free = pool.size - pool.inflight.size;
        if (free <= 0 || !this.runnable(pool.kinds)) continue;
        await this.ctx.conn.reducers.claimTasks({ workerId: config.workerId, kinds: pool.kinds, max: free, leaseSec: config.workers.leaseSec });
        for (const t of this.ctx.conn.db.agentTask.status.filter('running')) {
          if (t.leaseOwner !== config.workerId || this.inflight.has(t.id) || !pool.kinds.includes(t.kind)) continue;
          if (pool.inflight.size >= pool.size) break;
          pool.inflight.add(t.id);
          this.inflight.set(t.id, t);
          void this.run(pool, t);
        }
      }
    } catch (err) {
      log.warn('claim failed', { err: String(err) });
    } finally {
      this.claiming = false;
    }
  }

  private async run(pool: Pool, t: AgentTask) {
    const handler = this.handlers[t.kind];
    const t0 = Date.now();
    try {
      if (!handler) throw new Error(`no handler for task kind "${t.kind}"`);
      const out = await handler(this.ctx, t, safeJson(t.payload, {}));
      await this.ctx.conn.reducers.completeTask({
        id: t.id,
        workerId: config.workerId,
        result: jsonStringify(out.result ?? {}).slice(0, 15_000),
        usage: {
          model: out.usage?.model ?? '',
          tokensIn: Math.round(out.usage?.tokensIn ?? 0),
          tokensOut: Math.round(out.usage?.tokensOut ?? 0),
          cachedTokens: Math.round(out.usage?.cachedTokens ?? 0),
          costUsd: out.usage?.costUsd ?? 0,
        },
        followups: out.followups ?? [],
      });
      this.completed++;
      log.debug('task done', { kind: t.kind, id: t.id, ms: Date.now() - t0 });
    } catch (err) {
      this.failed++;
      // budget exhaustion is not the task's fault: park it for an hour
      const retryInSec = err instanceof BudgetExceeded ? 3600 : Math.min(600, 15 * 2 ** t.attempts);
      log.warn('task failed', { kind: t.kind, id: t.id, attempt: t.attempts, err: String((err as Error)?.message ?? err).slice(0, 300) });
      await this.ctx.conn.reducers
        .failTask({ id: t.id, workerId: config.workerId, error: String((err as Error)?.stack ?? err).slice(0, 1800), retryInSec })
        .catch(e => log.error('failTask failed', { err: String(e) }));
    } finally {
      pool.inflight.delete(t.id);
      this.inflight.delete(t.id);
    }
  }

  private async extendLeases() {
    if (this.inflight.size === 0) return;
    await this.ctx.conn.reducers
      .extendLeases({ workerId: config.workerId, ids: [...this.inflight.keys()], leaseSec: config.workers.leaseSec })
      .catch(err => log.warn('lease extension failed', { err: String(err) }));
  }
}
