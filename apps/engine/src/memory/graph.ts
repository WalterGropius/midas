// Graph memory over SpacetimeDB's mem_node / mem_edge tables.
//
// Two structures, never conflated (graph-engineering rule):
//   • the canonical graph — entities, events, markets, lessons and the
//     realized reactions linking them (domain truth, with provenance), and
//   • the agent_task ledger — who did what, when (work lineage).
// Retrieval is HippoRAG-style PPR + embeddings, with point-in-time reads for
// replays. Every edge carries evidence; nothing is written without both ends.
import {
  analogReactionPrior,
  buildAdjacency,
  cosine,
  edgeKey,
  hybridRetrieve,
  nodeKey,
  type Adjacency,
  type GEdge,
  type GNode,
  type ReactionPrior,
  type Retrieved,
} from '@midas/core';
import type { MemNode } from '@midas/stdb-bindings/types';
import type { Conn } from '../stdb';
import { msFromTs } from '../util/time';
import { byUnique } from '../util/rows';

export interface NodeUpsert {
  key: string;
  kind: string;
  label: string;
  aliases?: string[];
  summary?: string;
  sessionId?: bigint;
  status?: string;
  salienceDelta?: number;
  helpfulDelta?: number;
  harmfulDelta?: number;
  embedding?: number[];
}

export interface EdgeUpsert {
  srcKey: string;
  dstKey: string;
  rel: string;
  weight?: number;
  value?: number;
  lagMin?: number;
  evidence: string;
  status?: string;
  sessionId?: bigint;
  /** override the default key (src|rel|dst) when several edges may exist */
  key?: string;
}

export interface MemoryContext {
  items: Retrieved[];
  lessons: MemNode[];
  prior: ReactionPrior;
  /** text block with [mN] ids for prompts */
  text: string;
  lessonKeys: string[];
}

export class GraphMemory {
  private adjCache?: { at: number; nodes: number; edges: number; adj: Adjacency };

  constructor(private conn: Conn) {}

  private toGNode(n: MemNode): GNode {
    return {
      id: n.id.toString(),
      key: n.key,
      kind: n.kind,
      label: n.label,
      salience: n.salience,
      mentionCount: n.mentionCount,
      status: n.status,
      updatedAtMs: msFromTs(n.updatedAt),
      createdAtMs: msFromTs(n.createdAt),
      embedding: n.embedding.length > 0 ? n.embedding : undefined,
    };
  }

  private edges(): GEdge[] {
    const out: GEdge[] = [];
    for (const e of this.conn.db.memEdge.iter()) {
      out.push({
        src: e.src.toString(),
        dst: e.dst.toString(),
        rel: e.rel,
        weight: e.weight,
        createdAtMs: msFromTs(e.createdAt),
        invalidated: Boolean(e.invalidatedAt),
        invalidatedAtMs: e.invalidatedAt ? msFromTs(e.invalidatedAt) : undefined,
        status: e.status,
      });
    }
    return out;
  }

  adjacency(asOfMs?: number): Adjacency {
    const nNodes = Number(this.conn.db.memNode.count());
    const nEdges = Number(this.conn.db.memEdge.count());
    const now = Date.now();
    if (asOfMs === undefined && this.adjCache && this.adjCache.nodes === nNodes && this.adjCache.edges === nEdges && now - this.adjCache.at < 60_000) {
      return this.adjCache.adj;
    }
    const nodes = [...this.conn.db.memNode.iter()].map(n => this.toGNode(n));
    const adj = buildAdjacency(nodes, this.edges(), { nowMs: now, asOfMs });
    if (asOfMs === undefined) this.adjCache = { at: now, nodes: nNodes, edges: nEdges, adj };
    return adj;
  }

  node(key: string): MemNode | undefined {
    return byUnique(this.conn.db.memNode.key, key) ?? undefined;
  }

  /**
   * Context for a (news, market) pair: PPR from ≤5 seeds (the entities and the
   * market — HippoRAG 2 found few, specific seeds work best), embedding
   * similarity to the headline, the lessons attached, and an empirical prior
   * from the realized reactions to similar past events.
   */
  context(opts: {
    entityKeys: string[];
    marketKey: string;
    embedding?: number[];
    asOfMs?: number;
    k?: number;
    excludeKeys?: string[];
  }): MemoryContext {
    const adj = this.adjacency(opts.asOfMs);
    const seedIds: string[] = [];
    for (const key of [opts.marketKey, ...opts.entityKeys].slice(0, 5)) {
      const n = this.node(key);
      if (n) seedIds.push(n.id.toString());
    }
    const exclude = new Set(opts.excludeKeys ?? []);
    const items = hybridRetrieve(adj, seedIds, {
      nowMs: opts.asOfMs ?? Date.now(),
      k: (opts.k ?? 16) + exclude.size,
      queryEmbedding: opts.embedding,
      kinds: ['event', 'entity', 'lesson', 'market'],
    }).filter(r => !exclude.has(r.node.key));

    const lessons: MemNode[] = [];
    for (const r of items) {
      if (r.node.kind !== 'lesson') continue;
      const n = this.node(r.node.key);
      // ACE-style pruning: lessons that hurt more than they helped are skipped
      if (n && n.harmful <= n.helpful + 1) lessons.push(n);
    }

    const prior = this.analogPrior(opts.marketKey, opts.embedding, opts.asOfMs, exclude);
    const lines = items.slice(0, opts.k ?? 16).map((r, i) => {
      const n = this.node(r.node.key);
      const summary = n?.summary ? ` — ${n.summary.slice(0, 220)}` : '';
      return `[m${i + 1}] (${r.node.kind}) ${r.node.label}${summary}`;
    });
    if (prior.n > 0) {
      lines.push(
        `[analogs] ${prior.n} similar past events moved related markets by ${(prior.mean * 100).toFixed(1)} points on average (10–90%: ${(prior.q10 * 100).toFixed(1)} to ${(prior.q90 * 100).toFixed(1)}; effective n ${prior.effN.toFixed(1)})`
      );
    }
    return { items, lessons, prior, text: lines.join('\n'), lessonKeys: lessons.map(l => l.key) };
  }

  /**
   * Realized reactions of similar past events. Uses 'moved' edges
   * (event → market, value = realized Δ at 2h) on this market first, then on
   * any market; similarity is the embedding cosine between headlines.
   */
  analogPrior(marketKey: string, embedding: number[] | undefined, asOfMs?: number, exclude?: Set<string>): ReactionPrior {
    if (!embedding) return { mean: 0, q10: 0, q90: 0, n: 0, effN: 0 };
    const market = this.node(marketKey);
    const now = asOfMs ?? Date.now();
    const analogs: { similarity: number; delta: number; ageDays: number }[] = [];
    for (const e of this.conn.db.memEdge.iter()) {
      if (e.rel !== 'moved' || e.invalidatedAt) continue;
      const created = msFromTs(e.createdAt);
      if (created > now) continue;
      const ev = this.conn.db.memNode.id.find(e.src);
      if (!ev || ev.embedding.length === 0 || exclude?.has(ev.key)) continue;
      const sameMarket = market ? e.dst === market.id : false;
      const sim = cosine(embedding, ev.embedding) * (sameMarket ? 1 : 0.9);
      analogs.push({ similarity: sim, delta: e.value, ageDays: (now - created) / 86_400_000 });
    }
    return analogReactionPrior(analogs);
  }

  async upsertNodes(nodes: NodeUpsert[]) {
    if (nodes.length === 0) return;
    for (let i = 0; i < nodes.length; i += 100) {
      await this.conn.reducers.upsertMemNodes({
        nodes: nodes.slice(i, i + 100).map(n => ({
          key: n.key,
          kind: n.kind,
          label: n.label.slice(0, 300),
          aliases: n.aliases ?? [],
          summary: n.summary ?? '',
          sessionId: n.sessionId ?? 0n,
          status: n.status ?? 'draft',
          salienceDelta: n.salienceDelta ?? 1,
          helpfulDelta: n.helpfulDelta ?? 0,
          harmfulDelta: n.harmfulDelta ?? 0,
          embedding: n.embedding ?? [],
        })),
      });
    }
  }

  async upsertEdges(edges: EdgeUpsert[]) {
    if (edges.length === 0) return;
    for (let i = 0; i < edges.length; i += 200) {
      await this.conn.reducers.upsertMemEdges({
        edges: edges.slice(i, i + 200).map(e => ({
          key: e.key ?? edgeKey(e.srcKey, e.rel, e.dstKey),
          srcKey: e.srcKey,
          dstKey: e.dstKey,
          rel: e.rel,
          weight: e.weight ?? 1,
          value: e.value ?? 0,
          lagMin: e.lagMin ?? 0,
          evidence: e.evidence,
          sessionId: e.sessionId ?? 0n,
          status: e.status ?? 'draft',
        })),
      });
    }
  }

  /** ACE-style credit: a lesson that was in context for a good call gets +1 helpful. */
  async creditLessons(keys: string[], helpful: boolean) {
    const nodes = keys
      .map(k => this.node(k))
      .filter((n): n is MemNode => Boolean(n))
      .map(n => ({
        key: n.key,
        kind: n.kind,
        label: n.label,
        salienceDelta: helpful ? 0.5 : -0.5,
        helpfulDelta: helpful ? 1 : 0,
        harmfulDelta: helpful ? 0 : 1,
        status: n.status,
      }));
    await this.upsertNodes(nodes);
  }
}

export const keys = {
  market: (conditionId: string) => `market:${conditionId}`,
  event: (newsId: bigint | string) => `event:news-${newsId}`,
  entity: (name: string) => nodeKey('entity', name),
  lesson: (slug: string) => nodeKey('lesson', slug),
};
