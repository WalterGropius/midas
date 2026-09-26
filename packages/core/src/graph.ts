// Graph memory retrieval.
//
// Seeds (entities extracted from a headline, the market node) → Personalized
// PageRank over the memory graph (HippoRAG-style) blended with embedding
// similarity, recency and salience. Edges decay with age (bi-temporal: an
// invalidated fact contributes nothing). Analog events that already carry a
// realized market reaction become an empirical prior for the next reaction —
// this is where experience compounds numerically, not just as prose.
import { weightedQuantile } from './prob';

export interface GNode {
  id: string;
  key: string;
  kind: string;
  label: string;
  salience: number;
  mentionCount: number;
  status: string;
  updatedAtMs: number;
  createdAtMs?: number;
  embedding?: ArrayLike<number>;
}

export interface GEdge {
  src: string;
  dst: string;
  rel: string;
  weight: number;
  createdAtMs: number;
  invalidated: boolean;
  /** when the fact stopped being true (bi-temporal); required for as-of reads */
  invalidatedAtMs?: number;
  status?: string;
}

export interface Adjacency {
  out: Map<string, { to: string; w: number }[]>;
  nodes: Map<string, GNode>;
}

export interface GraphOptions {
  nowMs: number;
  /** edge weight halves every halfLifeDays */
  halfLifeDays?: number;
  /** per-relation multipliers; unknown relations use 1 */
  relWeights?: Record<string, number>;
  /** multiplier for draft (unverified) edges */
  draftWeight?: number;
  /**
   * Point-in-time read: only facts recorded at or before asOfMs, judged valid
   * as of then. Replays and evolution fitness must set this, or they see the
   * future.
   */
  asOfMs?: number;
}

export const DEFAULT_REL_WEIGHTS: Record<string, number> = {
  mentions: 1,
  about: 1.2,
  affects: 1.5,
  moved: 2,
  lesson_for: 1.5,
  learned_from: 1,
  similar_to: 0.8,
  merged_into: 3,
  related: 0.6,
};

export function buildAdjacency(nodes: GNode[], edges: GEdge[], opts: GraphOptions): Adjacency {
  const halfLife = opts.halfLifeDays ?? 21;
  const rel = { ...DEFAULT_REL_WEIGHTS, ...opts.relWeights };
  const draftW = opts.draftWeight ?? 0.5;
  const nodeMap = new Map<string, GNode>();
  for (const n of nodes) {
    if (n.status === 'retracted') continue;
    if (opts.asOfMs !== undefined && n.createdAtMs !== undefined && n.createdAtMs > opts.asOfMs) continue;
    nodeMap.set(n.id, n);
  }
  const out = new Map<string, { to: string; w: number }[]>();
  const add = (a: string, b: string, w: number) => {
    let list = out.get(a);
    if (!list) out.set(a, (list = []));
    list.push({ to: b, w });
  };
  const asOf = opts.asOfMs;
  for (const e of edges) {
    if (asOf !== undefined) {
      if (e.createdAtMs > asOf) continue;
      if (e.invalidatedAtMs !== undefined && e.invalidatedAtMs <= asOf) continue;
    } else if (e.invalidated) continue;
    if (!nodeMap.has(e.src) || !nodeMap.has(e.dst)) continue;
    const ageDays = Math.max(0, ((asOf ?? opts.nowMs) - e.createdAtMs) / 86_400_000);
    const decay = Math.pow(0.5, ageDays / halfLife);
    const w = Math.max(0, e.weight) * (rel[e.rel] ?? 1) * decay * (e.status === 'draft' ? draftW : 1);
    if (w <= 0) continue;
    add(e.src, e.dst, w);
    add(e.dst, e.src, w); // retrieval walks both directions
  }
  return { out, nodes: nodeMap };
}

export interface PprOptions {
  /** probability of following an edge (HippoRAG uses 0.5) */
  damping?: number;
  iterations?: number;
  tolerance?: number;
}

/** Personalized PageRank by power iteration with restart on the seed vector. */
export function personalizedPageRank(
  adj: Adjacency,
  seeds: Map<string, number>,
  opts: PprOptions = {}
): Map<string, number> {
  const d = opts.damping ?? 0.5;
  const iters = opts.iterations ?? 50;
  const tol = opts.tolerance ?? 1e-9;
  const restart = new Map<string, number>();
  let total = 0;
  for (const [id, w] of seeds) {
    if (!adj.nodes.has(id) || !(w > 0)) continue;
    restart.set(id, w);
    total += w;
  }
  if (total === 0) return new Map();
  for (const [id, w] of restart) restart.set(id, w / total);

  const outSum = new Map<string, number>();
  for (const [id, list] of adj.out) outSum.set(id, list.reduce((s, e) => s + e.w, 0));

  let r = new Map(restart);
  for (let it = 0; it < iters; it++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const [id, score] of r) {
      const list = adj.out.get(id);
      const sum = outSum.get(id) ?? 0;
      if (!list || sum <= 0) {
        dangling += score;
        continue;
      }
      for (const e of list) next.set(e.to, (next.get(e.to) ?? 0) + (d * score * e.w) / sum);
    }
    // restart mass + dangling mass both return to the seeds
    for (const [id, s] of restart) next.set(id, (next.get(id) ?? 0) + (1 - d) * s + d * dangling * s);
    let delta = 0;
    for (const [id, s] of next) delta += Math.abs(s - (r.get(id) ?? 0));
    for (const [id, s] of r) if (!next.has(id)) delta += s;
    r = next;
    if (delta < tol) break;
  }
  return r;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** HippoRAG node specificity: rare nodes are better seeds than hubs. */
export function seedWeight(node: GNode): number {
  return 1 / Math.log(2 + Math.max(0, node.mentionCount));
}

export interface RetrieveOptions {
  nowMs: number;
  k?: number;
  kinds?: string[];
  queryEmbedding?: ArrayLike<number>;
  weights?: { ppr?: number; sim?: number; recency?: number; salience?: number };
  recencyHalfLifeDays?: number;
  ppr?: PprOptions;
}

export interface Retrieved {
  node: GNode;
  score: number;
  ppr: number;
  sim: number;
}

export function hybridRetrieve(adj: Adjacency, seedIds: string[], opts: RetrieveOptions): Retrieved[] {
  const seeds = new Map<string, number>();
  for (const id of seedIds) {
    const n = adj.nodes.get(id);
    if (n) seeds.set(id, seedWeight(n));
  }
  const pr = personalizedPageRank(adj, seeds, opts.ppr);
  const maxPr = Math.max(1e-12, ...pr.values());
  const w = { ppr: 0.55, sim: 0.3, recency: 0.1, salience: 0.05, ...opts.weights };
  const halfLife = opts.recencyHalfLifeDays ?? 14;
  const maxSal = Math.max(1e-9, ...[...adj.nodes.values()].map(n => n.salience));
  const out: Retrieved[] = [];
  for (const node of adj.nodes.values()) {
    if (opts.kinds && !opts.kinds.includes(node.kind)) continue;
    if (node.status === 'merged') continue;
    const p = (pr.get(node.id) ?? 0) / maxPr;
    const sim = opts.queryEmbedding && node.embedding ? Math.max(0, cosine(opts.queryEmbedding, node.embedding)) : 0;
    if (p === 0 && sim < 0.3) continue;
    const ageDays = Math.max(0, (opts.nowMs - node.updatedAtMs) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / halfLife);
    const score = w.ppr * p + w.sim * sim + w.recency * recency + w.salience * (node.salience / maxSal);
    out.push({ node, score, ppr: p, sim });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, opts.k ?? 20);
}

export interface Analog {
  /** cosine similarity of the analog event to the current headline */
  similarity: number;
  /** realized Δprob of the relevant market after that analog event */
  delta: number;
  ageDays: number;
}

export interface ReactionPrior {
  mean: number;
  q10: number;
  q90: number;
  n: number;
  /** effective sample size of the kernel weights */
  effN: number;
}

/** Kernel-weighted empirical prior over realized reactions to similar news. */
export function analogReactionPrior(
  analogs: Analog[],
  opts: { bandwidth?: number; halfLifeDays?: number; minSimilarity?: number } = {}
): ReactionPrior {
  const bw = opts.bandwidth ?? 0.08;
  const hl = opts.halfLifeDays ?? 90;
  const minSim = opts.minSimilarity ?? 0.55;
  const rows = analogs.filter(a => a.similarity >= minSim && Number.isFinite(a.delta));
  if (rows.length === 0) return { mean: 0, q10: 0, q90: 0, n: 0, effN: 0 };
  const w = rows.map(a => Math.exp((a.similarity - 1) / bw) * Math.pow(0.5, a.ageDays / hl));
  const sw = w.reduce((s, x) => s + x, 0);
  const sw2 = w.reduce((s, x) => s + x * x, 0);
  const deltas = rows.map(a => a.delta);
  const m = deltas.reduce((s, d, i) => s + d * w[i], 0) / sw;
  return {
    mean: m,
    q10: weightedQuantile(deltas, w, 0.1),
    q90: weightedQuantile(deltas, w, 0.9),
    n: rows.length,
    effN: sw2 > 0 ? (sw * sw) / sw2 : 0,
  };
}

/** Canonical node keys: stable, lowercase, punctuation-free. */
export function nodeKey(kind: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${kind}:${slug || 'unknown'}`;
}

export function edgeKey(srcKey: string, rel: string, dstKey: string): string {
  return `${srcKey}|${rel}|${dstKey}`;
}

/** Serialize a retrieved neighbourhood for a prompt, with citable edge ids. */
export function serializeSubgraph(items: Retrieved[], maxChars = 4000): string {
  const lines: string[] = [];
  let used = 0;
  for (const [i, r] of items.entries()) {
    const line = `[m${i + 1}] (${r.node.kind}) ${r.node.label}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
