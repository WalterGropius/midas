'use client';

import { useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/react';
import { parseSeedYaml } from '@midas/core';
import { reducers } from '@midas/stdb-bindings';
import type { SeedFile } from '@midas/stdb-bindings/types';
import { FileContent, resolveWikiLink } from '@/components/file-view';
import { FileTree } from '@/components/file-tree';
import { Button, Empty, ErrorText, Pill, inputCls, cx } from '@/components/ui';
import { compact, dateTime, relTime, tsMs } from '@/lib/format';
import { sameIdentity, useAction, useNow } from '@/lib/stdb';
import { MAX_FILE_CHARS, safeFileName } from '../onboarding/draft';
import type { SessionCtx } from './context';

/** Humans own raw/, thesis.md and seed.yaml; agents own wiki/ and SCHEMA.md. */
function isUserEditable(path: string): boolean {
  return path.startsWith('raw/') || path === 'thesis.md' || path === 'seed.yaml';
}

export function WikiTab({ ctx }: { ctx: SessionCtx }) {
  const { identity } = useSpacetimeDB();
  const files = ctx.seedFiles;
  const paths = useMemo(() => files.map(f => f.path), [files]);
  const [selected, setSelected] = useState<string | null>(null);
  const current = files.find(f => f.path === selected) ?? files.find(f => f.path === 'wiki/index.md') ?? files[0];
  const mine = sameIdentity(ctx.session.owner, identity);

  if (ctx.seedReady && files.length === 0) {
    return (
      <Empty title="This session has no seed folder">
        Sessions created by onboarding carry seed.yaml, thesis.md, raw/ sources and a wiki/ the agents compile. Upload raw sources below.
        <div className="mt-3">
          <AddRawSource ctx={ctx} onAdded={setSelected} disabled={!mine} />
        </div>
      </Empty>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <aside className="min-w-0 space-y-3 rounded-lg border border-line bg-surface p-3">
        <FileTree
          files={files.map(f => ({ path: f.path, meta: `v${f.version}` }))}
          selected={current?.path ?? null}
          onSelect={setSelected}
          rootLabel={ctx.session.slug}
        />
        <div className="space-y-1.5 border-t border-line pt-3 text-[11px] text-muted">
          <p>
            <span className="text-ink-2">raw/</span> and <span className="text-ink-2">thesis.md</span> are yours — agents cite them, never
            rewrite them. <span className="text-ink-2">wiki/</span> is compiled and kept current by the agents.
          </p>
          <AddRawSource ctx={ctx} onAdded={setSelected} disabled={!mine} />
        </div>
      </aside>
      <section className="min-w-0 rounded-lg border border-line bg-surface">
        {current ? (
          <FilePane
            key={`${current.id.toString()}:${current.version}`}
            file={current}
            ctx={ctx}
            canEdit={mine && isUserEditable(current.path)}
            onWikiLink={t => {
              const p = resolveWikiLink(t, paths);
              if (p) setSelected(p);
            }}
            onDeleted={() => setSelected(null)}
          />
        ) : (
          <div className="p-6 text-xs text-muted">loading files…</div>
        )}
      </section>
    </div>
  );
}

function FilePane({
  file,
  ctx,
  canEdit,
  onWikiLink,
  onDeleted,
}: {
  file: SeedFile;
  ctx: SessionCtx;
  canEdit: boolean;
  onWikiLink: (t: string) => void;
  onDeleted: () => void;
}) {
  const now = useNow(30_000);
  const [draft, setDraft] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const upsert = useReducer(reducers.upsertSeedFile);
  const del = useReducer(reducers.deleteSeedFile);
  const { run, pending, error, clear } = useAction();
  const isWiki = file.path.startsWith('wiki/') || file.path === 'SCHEMA.md';

  const save = () => {
    if (draft === null) return;
    if (draft.length > MAX_FILE_CHARS) return setLocalError(`File too large (${compact(draft.length)} chars, limit ${compact(MAX_FILE_CHARS)}).`);
    if (file.path === 'seed.yaml') {
      try {
        parseSeedYaml(draft);
      } catch (e) {
        return setLocalError(`seed.yaml is not valid YAML: ${(e as Error).message}`);
      }
    }
    setLocalError(null);
    void run(async () => {
      await upsert({ sessionId: ctx.session.id, file: { path: file.path, kind: file.kind, content: draft } });
      setDraft(null);
    });
  };

  return (
    <div>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="num min-w-0 truncate text-[13px] text-ink">{file.path}</span>
        {isWiki ? <Pill title="Agents rewrite this page as news arrives">compiled by agents</Pill> : <Pill>{file.kind}</Pill>}
        <span className="num text-[11px] text-muted" title={dateTime(tsMs(file.updatedAt))}>
          v{file.version} · {file.updatedBy} · {relTime(tsMs(file.updatedAt), now)}
        </span>
        <div className="ml-auto flex gap-1.5">
          {canEdit && draft === null && (
            <Button size="sm" onClick={() => setDraft(file.content)}>
              Edit
            </Button>
          )}
          {canEdit && draft === null && file.path.startsWith('raw/') && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (window.confirm(`Delete ${file.path}? Agents lose this source.`)) void run(async () => (await del({ id: file.id }), onDeleted()));
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </header>
      <div className="space-y-2 p-4">
        <ErrorText error={localError ?? error} onClose={() => (setLocalError(null), clear())} />
        {draft !== null ? (
          <div className="space-y-2">
            {file.path === 'seed.yaml' && (
              <p className="text-[11px] text-muted">
                Feeds and keywords are read from seed.yaml. Bankroll, risk and intelligence changes go through the Settings tab.
              </p>
            )}
            <textarea
              className={cx(inputCls, 'min-h-[420px] font-mono text-[12.5px] leading-relaxed')}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              spellCheck={file.path.endsWith('.md')}
              aria-label={`Edit ${file.path}`}
            />
            <div className="flex gap-2">
              <Button variant="primary" disabled={pending || draft === file.content} onClick={save}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
              <Button onClick={() => (setDraft(null), setLocalError(null))}>Cancel</Button>
              <span className="num self-center text-[11px] text-muted">{compact(draft.length)} chars</span>
            </div>
          </div>
        ) : file.content.trim() ? (
          <FileContent path={file.path} content={file.content} onWikiLink={onWikiLink} />
        ) : (
          <div className="text-xs text-muted">(empty file)</div>
        )}
      </div>
    </div>
  );
}

function AddRawSource({ ctx, onAdded, disabled }: { ctx: SessionCtx; onAdded: (path: string) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const upsert = useReducer(reducers.upsertSeedFile);
  const { run, pending, error, clear } = useAction();
  const [name, setName] = useState('');

  const add = (fileName: string, content: string) =>
    run(async () => {
      if (content.length > MAX_FILE_CHARS) throw new Error(`${fileName}: over ${compact(MAX_FILE_CHARS)} characters`);
      const path = `raw/${safeFileName(fileName)}`;
      await upsert({ sessionId: ctx.session.id, file: { path, kind: 'raw', content } });
      onAdded(path);
    });

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <input
          className={cx(inputCls, 'py-1 text-xs')}
          placeholder="new-note.md"
          value={name}
          onChange={e => setName(e.target.value)}
          disabled={disabled}
          aria-label="New raw note file name"
        />
        <Button
          size="sm"
          disabled={disabled || pending || !name.trim()}
          onClick={() => {
            const n = /\.\w+$/.test(name.trim()) ? name.trim() : `${name.trim()}.md`;
            void add(n, `# ${n.replace(/\.\w+$/, '')}\n\n`).then(ok => ok && setName(''));
          }}
        >
          + note
        </Button>
      </div>
      <Button size="sm" className="w-full" disabled={disabled || pending} onClick={() => input.current?.click()}>
        ↑ Upload raw sources
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept=".md,.markdown,.txt,.csv,.json"
        className="hidden"
        onChange={async e => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          for (const f of list) await add(f.name, await f.text());
        }}
      />
      {disabled && <div className="text-[11px] text-muted">Only the session owner can add sources.</div>}
      <ErrorText error={error} onClose={clear} />
    </div>
  );
}
