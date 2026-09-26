'use client';

import { cx } from './ui';

export interface TreeFile {
  path: string;
  /** right-aligned hint, e.g. "v3" */
  meta?: string;
}

interface Dir {
  name: string;
  dirs: Map<string, Dir>;
  files: TreeFile[];
}

function build(files: TreeFile[]): Dir {
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { name: p, dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }
  return root;
}

// Root config files first, then raw/ (human), then wiki/ (agents).
const DIR_ORDER = ['raw', 'wiki'];
const ROOT_ORDER = ['seed.yaml', 'thesis.md', 'SCHEMA.md'];

function sortDirs(a: Dir, b: Dir) {
  const ia = DIR_ORDER.indexOf(a.name);
  const ib = DIR_ORDER.indexOf(b.name);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.name.localeCompare(b.name);
}

function sortFiles(a: TreeFile, b: TreeFile) {
  const ia = ROOT_ORDER.indexOf(a.path);
  const ib = ROOT_ORDER.indexOf(b.path);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.path.localeCompare(b.path);
}

export function FileTree({
  files,
  selected,
  onSelect,
  rootLabel,
}: {
  files: TreeFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  rootLabel?: string;
}) {
  const root = build(files);
  return (
    <div className="font-mono text-[12px]">
      {rootLabel && <div className="mb-1 text-muted">{rootLabel}/</div>}
      <DirView dir={root} depth={0} selected={selected} onSelect={onSelect} />
    </div>
  );
}

function DirView({ dir, depth, selected, onSelect }: { dir: Dir; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  return (
    <ul>
      {[...dir.files].sort(sortFiles).map(f => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => onSelect(f.path)}
            className={cx(
              'flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left',
              selected === f.path ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-surface-2'
            )}
            style={{ paddingLeft: 6 + depth * 12 }}
          >
            <span className="min-w-0 flex-1 truncate">{f.path.split('/').pop()}</span>
            {f.meta && <span className="shrink-0 text-[10.5px] text-muted">{f.meta}</span>}
          </button>
        </li>
      ))}
      {[...dir.dirs.values()].sort(sortDirs).map(d => (
        <li key={d.name}>
          <div className="px-1.5 py-0.5 text-muted" style={{ paddingLeft: 6 + depth * 12 }}>
            {d.name}/
          </div>
          <DirView dir={d} depth={depth + 1} selected={selected} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}
