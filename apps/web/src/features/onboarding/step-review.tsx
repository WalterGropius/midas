'use client';

import { useMemo, useState } from 'react';
import { buildSeedFiles, slugify, type SeedFile } from '@midas/core';
import { strToU8, zipSync } from 'fflate';
import { FileContent, resolveWikiLink } from '@/components/file-view';
import { FileTree } from '@/components/file-tree';
import { Button, Card, ErrorText } from '@/components/ui';
import { pct, points, usd } from '@/lib/format';
import { toSeedConfig, type Draft } from './draft';

export function useSeedFiles(d: Draft): SeedFile[] {
  return useMemo(
    () =>
      buildSeedFiles(
        toSeedConfig(d),
        d.rawFiles.map(f => ({ path: f.name, content: f.content }))
      ),
    [d]
  );
}

function downloadZip(folder: string, files: SeedFile[]) {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[`${folder}/${f.path}`] = strToU8(f.content);
  const zipped = zipSync(entries, { level: 6 });
  const url = URL.createObjectURL(new Blob([new Uint8Array(zipped)], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${folder}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StepReview({
  d,
  files,
  problems,
  launching,
  error,
  onLaunch,
  connected,
}: {
  d: Draft;
  files: SeedFile[];
  problems: string[];
  launching: boolean;
  error: string | null;
  onLaunch: () => void;
  connected: boolean;
}) {
  const [selected, setSelected] = useState<string>('seed.yaml');
  const folder = slugify(d.name || 'session');
  const current = files.find(f => f.path === selected) ?? files[0];
  const paths = files.map(f => f.path);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Summary label="Money" lines={[`${usd(d.bankrollUsd, 0)} · ${d.mode}`, `Kelly ${d.risk.kellyFraction.toFixed(2)}× · max ${pct(d.risk.maxPositionPct)} / market`, `min edge ${points(d.risk.minEdge).replace('+', '')} · ${d.risk.strategy}`]} />
        <Summary label="Markets" lines={[`${d.markets.length} selected`, ...d.markets.slice(0, 2).map(m => m.question)]} />
        <Summary label="Knowledge" lines={[d.name || '(unnamed)', `${d.rawFiles.length} raw source${d.rawFiles.length === 1 ? '' : 's'} · ${d.keywords.length} keywords`, `${d.feeds.length} feeds`]} />
        <Summary label="Intelligence" lines={[`swarm ${d.intel.swarmSize} · pro ${d.intel.proCallsPerHour}/h`, `budget ${usd(d.intel.dailyLlmBudgetUsd, 0)}/day`]} />
      </div>

      <Card
        title={`Seed folder · ${folder}/`}
        right={
          <Button size="sm" onClick={() => downloadZip(folder, files)}>
            ↓ Download seed folder (.zip)
          </Button>
        }
        pad={false}
      >
        <div className="grid md:grid-cols-[240px_1fr]">
          <div className="border-b border-line p-3 md:border-b-0 md:border-r">
            <FileTree files={files.map(f => ({ path: f.path, meta: f.kind }))} selected={current?.path ?? null} onSelect={setSelected} rootLabel={folder} />
          </div>
          <div className="min-w-0 p-4">
            {current && (
              <>
                <div className="num mb-2 text-[11px] text-muted">
                  {current.path} · {current.kind}
                </div>
                <div className="max-h-[520px] overflow-y-auto">
                  <FileContent
                    path={current.path}
                    content={current.content}
                    onWikiLink={t => {
                      const p = resolveWikiLink(t, paths);
                      if (p) setSelected(p);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </Card>

      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-warn">
            {problems.map(p => (
              <li key={p}>▲ {p}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={launching || problems.some(p => p.startsWith('Required')) || !connected} onClick={onLaunch}>
            {launching ? 'Launching…' : d.mode === 'live' ? 'Launch (awaits admin approval)' : '▶ Launch paper session'}
          </Button>
          <span className="text-xs text-muted">
            {connected
              ? 'Creates the session, its markets and every file above in SpacetimeDB. The engine picks it up within seconds.'
              : 'Not connected to SpacetimeDB — you can still download the folder and import it later with `npm run seed:import`.'}
          </span>
        </div>
        <ErrorText error={error} />
      </div>
    </div>
  );
}

function Summary({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-3">
      <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted">{label}</div>
      {lines.map((l, i) => (
        <div key={i} className={i === 0 ? 'truncate text-[13px] text-ink' : 'truncate text-[11.5px] text-ink-2'} title={l}>
          {l}
        </div>
      ))}
    </div>
  );
}
