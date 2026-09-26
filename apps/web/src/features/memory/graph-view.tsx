'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { MemEdge, MemNode } from '@midas/stdb-bindings/types';
import { useWidth } from '@/components/charts/util';

export const KIND_STYLE: Record<string, { color: string; shape: 'circle' | 'diamond' | 'square' | 'triangle'; label: string }> = {
  entity: { color: 'var(--s1)', shape: 'circle', label: 'entity' },
  event: { color: 'var(--s2)', shape: 'diamond', label: 'event' },
  market: { color: 'var(--s3)', shape: 'square', label: 'market' },
  // Only three hues validate all-pairs; lessons take the neutral + their own shape.
  lesson: { color: 'var(--muted)', shape: 'triangle', label: 'lesson' },
};
const OTHER = { color: 'var(--ink-2)', shape: 'circle' as const, label: 'other' };

export function kindStyle(kind: string) {
  return KIND_STYLE[kind] ?? OTHER;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: MemNode;
  r: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  edge: MemEdge;
}

export function Glyph({ shape, x, y, r, fill, stroke, strokeWidth }: { shape: string; x: number; y: number; r: number; fill: string; stroke?: string; strokeWidth?: number }) {
  const common = { fill, stroke, strokeWidth, paintOrder: 'stroke' as const };
  if (shape === 'square') return <rect x={x - r * 0.88} y={y - r * 0.88} width={r * 1.76} height={r * 1.76} rx={1.5} {...common} />;
  if (shape === 'diamond') return <path d={`M${x},${y - r * 1.2}L${x + r * 1.2},${y}L${x},${y + r * 1.2}L${x - r * 1.2},${y}Z`} {...common} />;
  if (shape === 'triangle') return <path d={`M${x},${y - r * 1.2}L${x + r * 1.1},${y + r * 0.8}L${x - r * 1.1},${y + r * 0.8}Z`} {...common} />;
  return <circle cx={x} cy={y} r={r} {...common} />;
}

const HEIGHT = 620;

export function GraphView({
  nodes,
  edges,
  selected,
  onSelect,
  highlight,
}: {
  nodes: MemNode[];
  edges: MemEdge[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  highlight: Set<string>;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(800);
  const [, setFrame] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const posRef = useRef(new Map<string, { x: number; y: number }>());
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  const widthRef = useRef(width);
  widthRef.current = width;

  /** Zoom and center so every node (plus room for labels) is visible. */
  const shownIds = useRef<string[]>([]);
  const userMoved = useRef(false);
  const fit = () => {
    userMoved.current = false;
    const ps = shownIds.current.map(id => posRef.current.get(id)).filter((p): p is { x: number; y: number } => !!p);
    if (ps.length === 0) return;
    const xs = ps.map(p => p.x);
    const ys = ps.map(p => p.y);
    const minX = Math.min(...xs) - 30;
    const maxX = Math.max(...xs) + 160; // labels run to the right
    const minY = Math.min(...ys) - 30;
    const maxY = Math.max(...ys) + 30;
    const k = Math.min(1.6, Math.max(0.2, Math.min(widthRef.current / (maxX - minX), HEIGHT / (maxY - minY))));
    setView({ k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k });
  };

  const maxSal = useMemo(() => Math.max(1e-6, ...nodes.map(n => n.salience)), [nodes]);
  const structureKey = useMemo(
    () => `${nodes.map(n => n.id.toString()).join(',')}|${edges.map(e => e.id.toString()).join(',')}`,
    [nodes, edges]
  );

  const { simNodes, simLinks } = useMemo(() => {
    const prev = posRef.current;
    const simNodes: SimNode[] = nodes.map((n, i) => {
      const id = n.id.toString();
      const p = prev.get(id);
      const angle = i * 2.399963; // golden-angle spiral seeds a stable, overlap-free start
      const rad = 12 * Math.sqrt(i + 1);
      return { id, node: n, r: 3 + 7 * Math.sqrt(Math.max(0, n.salience) / maxSal), x: p?.x ?? Math.cos(angle) * rad, y: p?.y ?? Math.sin(angle) * rad };
    });
    const have = new Set(simNodes.map(n => n.id));
    const simLinks: SimLink[] = edges
      .filter(e => have.has(e.src.toString()) && have.has(e.dst.toString()) && e.src !== e.dst)
      .map(e => ({ id: e.id.toString(), edge: e, source: e.src.toString(), target: e.dst.toString() }));
    shownIds.current = simNodes.map(n => n.id);
    return { simNodes, simLinks };
    // rebuild only when the node/edge set changes, not on every row update
  }, [structureKey, maxSal]);

  useEffect(() => {
    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id(d => d.id)
          .distance(70)
          .strength(l => 0.1 + 0.4 * Math.min(1, Math.max(0, l.edge.weight)))
      )
      .force('charge', forceManyBody<SimNode>().strength(-160).distanceMax(500))
      .force('x', forceX<SimNode>(0).strength(0.03))
      .force('y', forceY<SimNode>(0).strength(0.03))
      .force('collide', forceCollide<SimNode>(d => d.r + 6))
      .stop();
    const fresh = simNodes.some(n => !posRef.current.has(n.id));
    // settle off-screen first so the graph appears laid out, then animate gently
    sim.tick(fresh ? 300 : 10);
    let raf = 0;
    sim.on('tick', () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          for (const n of simNodes) posRef.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
          setFrame(f => f + 1);
        });
    });
    sim.alpha(fresh ? 0.08 : 0.1).alphaMin(0.02).restart();
    simRef.current = sim;
    for (const n of simNodes) posRef.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
    if (fresh || !userMoved.current) fit();
    setFrame(f => f + 1);
    return () => {
      sim.stop();
      cancelAnimationFrame(raf);
    };
  }, [simNodes, simLinks]);

  const toWorld = (clientX: number, clientY: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    return { x: (clientX - rect.left - width / 2 - view.x) / view.k, y: (clientY - rect.top - HEIGHT / 2 - view.y) / view.k };
  };

  useEffect(() => {
    if (!userMoved.current) fit();
  }, [width]);

  // Wheel zoom around the pointer. Native listener: React's onWheel is passive
  // and could not stop the page from scrolling underneath.
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      userMoved.current = true;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - widthRef.current / 2;
      const py = e.clientY - rect.top - HEIGHT / 2;
      setView(v => {
        const k = Math.min(6, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest('[data-node]');
    const id = target?.getAttribute('data-node') ?? undefined;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: id ? 'node' : 'pan', id, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
    if (d.kind === 'pan') {
      userMoved.current = true;
      setView(v => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    }
    else if (d.moved) {
      const n = simNodes.find(s => s.id === d.id);
      if (!n) return;
      const w = toWorld(e.clientX, e.clientY, e.currentTarget);
      n.fx = w.x;
      n.fy = w.y;
      simRef.current?.alphaTarget(0.2).restart();
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'node') {
      const n = simNodes.find(s => s.id === d.id);
      if (n) (n.fx = null), (n.fy = null);
      simRef.current?.alphaTarget(0);
      if (!d.moved && d.id) onSelect(d.id === selected ? null : d.id);
    } else if (!d.moved) onSelect(null);
  };

  // Label sparingly: the most salient, the selected, hovered and search hits.
  const labelled = useMemo(() => {
    const top = [...simNodes].sort((a, b) => b.node.salience - a.node.salience).slice(0, 20).map(n => n.id);
    return new Set([...top, ...highlight]);
  }, [simNodes, highlight]);
  const neighbors = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const l of simLinks) {
      const a = l.edge.src.toString();
      const b = l.edge.dst.toString();
      if (a === selected) s.add(b);
      if (b === selected) s.add(a);
    }
    return s;
  }, [selected, simLinks]);

  const pos = (id: string) => posRef.current.get(id) ?? { x: 0, y: 0 };
  const maxW = Math.max(1e-6, ...simLinks.map(l => l.edge.weight));
  const hovered = hover ? simNodes.find(n => n.id === hover) : undefined;

  return (
    <div ref={ref} className="relative overflow-hidden rounded-lg border border-line bg-surface" style={{ height: HEIGHT }}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Memory graph: ${simNodes.length} nodes, ${simLinks.length} edges`}
        ref={svgRef}
        className="block cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <g transform={`translate(${width / 2 + view.x},${HEIGHT / 2 + view.y}) scale(${view.k})`}>
          {simLinks.map(l => {
            const a = pos(l.edge.src.toString());
            const b = pos(l.edge.dst.toString());
            const invalid = l.edge.invalidatedAt !== undefined;
            const dim = neighbors && !(neighbors.has(l.edge.src.toString()) && neighbors.has(l.edge.dst.toString()));
            const op = (0.12 + 0.6 * Math.max(0, l.edge.weight) / maxW) * (invalid ? 0.5 : 1) * (dim ? 0.25 : 1);
            return (
              <line
                key={l.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--ink-2)"
                strokeOpacity={op}
                strokeWidth={1 / view.k}
                strokeDasharray={invalid ? '3 3' : undefined}
              />
            );
          })}
          {simNodes.map(n => {
            const p = pos(n.id);
            const st = kindStyle(n.node.kind);
            const isSel = n.id === selected;
            const dim = neighbors && !neighbors.has(n.id);
            return (
              <g
                key={n.id}
                data-node={n.id}
                className="cursor-pointer"
                opacity={dim ? 0.25 : n.node.status === 'retracted' || n.node.status === 'merged' ? 0.5 : 1}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(h => (h === n.id ? null : h))}
              >
                <circle cx={p.x} cy={p.y} r={Math.max(10, n.r + 4)} fill="transparent" />
                {(isSel || highlight.has(n.id)) && <circle cx={p.x} cy={p.y} r={n.r + 4} fill="none" stroke="var(--accent)" strokeWidth={isSel ? 2 : 1} />}
                <Glyph shape={st.shape} x={p.x} y={p.y} r={n.r} fill={st.color} stroke="var(--surface)" strokeWidth={1.5} />
                {(labelled.has(n.id) || isSel || hover === n.id) && (
                  <text
                    x={p.x + n.r + 3}
                    y={p.y}
                    dy="0.32em"
                    fontSize={11 / view.k}
                    fill={isSel ? 'var(--ink)' : 'var(--ink-2)'}
                    stroke="var(--surface)"
                    strokeWidth={3 / view.k}
                    paintOrder="stroke"
                    pointerEvents="none"
                  >
                    {n.node.label.length > 32 ? `${n.node.label.slice(0, 31)}…` : n.node.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute left-2 top-2 max-w-[320px] rounded-md border border-line-strong bg-surface-2/95 px-2.5 py-1.5 text-[11px]">
          <div className="font-medium text-ink">{hovered.node.label}</div>
          <div className="text-muted">
            {hovered.node.kind} · salience {hovered.node.salience.toFixed(2)} · {hovered.node.mentionCount} mentions
          </div>
        </div>
      )}
      <div className="absolute bottom-2 right-2 flex gap-1">
        <button type="button" className="rounded border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink-2 hover:text-ink" onClick={() => setView(v => ({ ...v, k: Math.min(6, v.k * 1.3) }))} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="rounded border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink-2 hover:text-ink" onClick={() => setView(v => ({ ...v, k: Math.max(0.2, v.k / 1.3) }))} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="rounded border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink-2 hover:text-ink" onClick={fit}>
          fit
        </button>
      </div>
    </div>
  );
}
