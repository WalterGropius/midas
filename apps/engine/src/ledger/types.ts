import type { AgentTask } from '@midas/stdb-bindings/types';
import type { EngineCtx } from '../ctx';
import { jsonStringify } from '../util/async';

export interface Usage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
}

export interface TaskInput {
  kind: string;
  sessionId: bigint;
  priority: number;
  dependsOn: string[];
  dedupeKey: string;
  payload: string;
  maxAttempts: number;
  notBeforeMicros: bigint;
}

export interface TaskResult {
  result?: unknown;
  followups?: TaskInput[];
  usage?: Usage;
}

export type Handler = (ctx: EngineCtx, task: AgentTask, payload: any) => Promise<TaskResult>;

export function task(
  kind: string,
  dedupeKey: string,
  payload: unknown,
  opts: { sessionId?: bigint; priority?: number; dependsOn?: string[]; maxAttempts?: number; notBeforeMs?: number } = {}
): TaskInput {
  return {
    kind,
    sessionId: opts.sessionId ?? 0n,
    priority: opts.priority ?? 50,
    dependsOn: opts.dependsOn ?? [],
    dedupeKey,
    payload: jsonStringify(payload),
    maxAttempts: opts.maxAttempts ?? 3,
    notBeforeMicros: opts.notBeforeMs ? BigInt(Math.round(opts.notBeforeMs)) * 1000n : 0n,
  };
}

/** Accumulates LLM usage across the several calls one task may make. */
export class UsageSum {
  model = '';
  tokensIn = 0;
  tokensOut = 0;
  cachedTokens = 0;
  costUsd = 0;
  add(u: { model: string; tokensIn: number; tokensOut: number; cachedTokens: number; costUsd: number }) {
    this.model = this.model && this.model !== u.model ? 'mixed' : u.model;
    this.tokensIn += u.tokensIn;
    this.tokensOut += u.tokensOut;
    this.cachedTokens += u.cachedTokens;
    this.costUsd += u.costUsd;
  }
  get(): Usage {
    return { model: this.model, tokensIn: this.tokensIn, tokensOut: this.tokensOut, cachedTokens: this.cachedTokens, costUsd: this.costUsd };
  }
}
