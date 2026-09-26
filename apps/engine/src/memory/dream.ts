// autoDream: background memory consolidation, run only when the queue is
// idle. Entity resolution is the dangerous step (false merges poison the
// graph), so candidates come from cheap lexical similarity, the decision from
// the `entity.same` reflex at a high threshold, and every merge is reversible.
import { tokens } from '@midas/core';
import type { MemNode } from '@midas/stdb-bindings/types';
import type { EngineCtx } from '../ctx';
import { logger } from '../log';
import type { Handler } from '../ledger/types';

const log = logger('dream');

function similar(a: MemNode, b: MemNode): boolean {
  const la = a.label.toLowerCase();
  const lb = b.label.toLowerCase();
  if (la === lb) return true;
  if (la.length > 3 && lb.length > 3 && (la.includes(lb) || lb.includes(la))) return true;
  const ta = new Set(tokens(a.label));
  const tb = new Set(tokens(b.label));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size) >= 0.6;
}

export const dream: Handler = async ctx => {
  const busy = [...ctx.conn.db.agentTask.status.filter('pending')].some(t => t.kind === 'triage' || t.kind === 'swarm' || t.kind === 'decide');
  if (busy) return { result: { skipped: 'queue busy — dreaming later' } };

  // 1. entity resolution candidates
  const entities = [...ctx.conn.db.memNode.kind.filter('entity')].filter(n => n.status !== 'merged' && n.status !== 'retracted');
  entities.sort((a, b) => b.mentionCount - a.mentionCount);
  const pairs: [MemNode, MemNode][] = [];
  for (let i = 0; i < entities.length && pairs.length < 40; i++) {
    for (let j = i + 1; j < entities.length && pairs.length < 40; j++) {
      if (similar(entities[i], entities[j])) pairs.push([entities[i], entities[j]]);
    }
  }
  const firings = await ctx.reflexes.fireMany(
    ['entity.same'],
    pairs.map(([a, b]) => ({
      refId: `merge:${a.key}|${b.key}`,
      state: { text: `NAME A: ${a.label} (${a.summary})\nNAME B: ${b.label} (${b.summary})`, features: { a: a.label, b: b.label } },
    }))
  );
  let merged = 0;
  for (const [i, [a, b]] of pairs.entries()) {
    const f = firings[i]?.['entity.same'];
    if (!f?.fire || f.prob < 0.9) continue;
    const [into, from] = a.mentionCount >= b.mentionCount ? [a, b] : [b, a];
    await ctx.conn.reducers.mergeMemNodes({ fromKey: from.key, intoKey: into.key, evidence: `entity.same p=${f.prob.toFixed(2)}` });
    merged++;
  }

  // 2. promote well-attested drafts; retract lessons that keep hurting
  const promote = [];
  for (const n of ctx.conn.db.memNode.iter()) {
    if (n.status === 'draft' && n.kind === 'entity' && n.mentionCount >= 3) promote.push({ key: n.key, kind: n.kind, label: n.label, status: 'canonical', salienceDelta: 0 });
    if (n.kind === 'lesson' && n.status !== 'retracted' && n.harmful >= n.helpful + 2) promote.push({ key: n.key, kind: n.kind, label: n.label, status: 'retracted', salienceDelta: -1 });
    if (n.kind === 'lesson' && n.status === 'draft' && n.helpful >= n.harmful + 3) promote.push({ key: n.key, kind: n.kind, label: n.label, status: 'canonical', salienceDelta: 1 });
  }
  if (promote.length) await ctx.graph.upsertNodes(promote.map(p => ({ ...p, helpfulDelta: 0, harmfulDelta: 0 })));
  log.info('dreamt', { candidates: pairs.length, merged, statusChanges: promote.length });
  return { result: { candidates: pairs.length, merged, statusChanges: promote.length } };
};
