'use client';

import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Button, cx, ErrorText, Field, inputCls } from '@/components/ui';
import { FEED_GROUPS } from '@/lib/feeds';
import { compact } from '@/lib/format';
import { MAX_FILE_CHARS, safeFileName, type Draft, type RawFile } from './draft';

const ACCEPT = '.md,.markdown,.txt,.csv,.json';

export function StepKnowledge({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <Field label="Session name" hint="Shown everywhere; the seed folder is named after it.">
          <input className={inputCls} value={d.name} maxLength={120} onChange={e => set({ name: e.target.value })} placeholder="e.g. Fed path Q4" />
        </Field>
        <Field
          label="Thesis"
          hint="Your view, priors and red lines. Agents read it first and treat it as a hypothesis, not a fact — they will tell you when news contradicts it."
        >
          <textarea
            className={cx(inputCls, 'min-h-[180px] font-mono text-[12.5px] leading-relaxed')}
            value={d.thesis}
            onChange={e => set({ thesis: e.target.value })}
            placeholder={'- Inflation is re-accelerating; the market underprices a hold in December.\n- Ignore single Fed speaker headlines unless the Chair.\n- Never hold through the FOMC decision itself.'}
          />
        </Field>
        <KeywordInput value={d.keywords} onChange={keywords => set({ keywords })} />
        <RawSources files={d.rawFiles} onChange={rawFiles => set({ rawFiles })} />
      </div>
      <div className="min-w-0">
        <FeedPicker value={d.feeds} onChange={feeds => set({ feeds })} />
      </div>
    </div>
  );
}

function KeywordInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    onChange([...new Set([...value, ...parts])]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <Field label="Keywords" hint="Extra terms that make a headline relevant (names, tickers, places). Enter or comma to add.">
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-bg px-2 py-1.5 focus-within:border-accent">
        {value.map(k => (
          <span key={k} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink">
            {k}
            <button type="button" className="text-muted hover:text-ink" aria-label={`Remove ${k}`} onClick={() => onChange(value.filter(x => x !== k))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="min-w-[120px] flex-1 bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={add}
          placeholder={value.length ? '' : 'Powell, FOMC, CPI…'}
        />
      </div>
    </Field>
  );
}

function RawSources({ files, onChange }: { files: RawFile[]; onChange: (f: RawFile[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ingest = async (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (!/\.(md|markdown|txt|csv|json)$/i.test(f.name)) {
        problems.push(`${f.name}: only .md, .txt, .csv and .json are accepted`);
        continue;
      }
      const content = await f.text();
      if (content.length > MAX_FILE_CHARS) {
        problems.push(`${f.name}: ${compact(content.length)} characters (limit ${compact(MAX_FILE_CHARS)}) — split it into smaller files`);
        continue;
      }
      const name = safeFileName(f.name);
      const i = next.findIndex(x => x.name === name);
      if (i >= 0) next[i] = { name, content };
      else next.push({ name, content });
    }
    onChange(next);
    setError(problems.length ? problems.join('\n') : null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void ingest(e.dataTransfer.files);
  };

  return (
    <div>
      <div className="mb-1 text-xs text-ink-2">Raw sources</div>
      <div
        onDragOver={e => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cx(
          'rounded-lg border border-dashed px-4 py-5 text-center transition-colors',
          drag ? 'border-accent bg-accent/10' : 'border-line-strong bg-bg'
        )}
      >
        <div className="text-[13px] text-ink-2">Drop notes, articles or data here</div>
        <div className="mt-0.5 text-[11px] text-muted">
          .md .txt .csv .json — read in your browser, stored as <span className="num">raw/&lt;file&gt;</span>. Agents cite them but never edit them.
        </div>
        <Button size="sm" className="mt-2" onClick={() => input.current?.click()}>
          Choose files…
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={e => {
            void ingest(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      <div className="mt-2">
        <ErrorText error={error} onClose={() => setError(null)} />
      </div>
      {files.length > 0 && (
        <ul className="mt-2 divide-y divide-line rounded-md border border-line">
          {files.map(f => (
            <li key={f.name} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="num min-w-0 flex-1 truncate text-ink">raw/{f.name}</span>
              <span className="num text-muted">{compact(f.content.length)} chars</span>
              <button type="button" className="text-muted hover:text-crit" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter(x => x.name !== f.name))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const on = new Set(value);
  const known = new Set(FEED_GROUPS.flatMap(g => g.ids));
  const customFeeds = value.filter(v => !known.has(v));
  const toggle = (id: string) => onChange(on.has(id) ? value.filter(v => v !== id) : [...value, id]);

  const addCustom = () => {
    const url = custom.trim();
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      setError('Enter a full http(s) URL of an RSS or Atom feed.');
      return;
    }
    if (!on.has(url)) onChange([...value, url]);
    setCustom('');
    setError(null);
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">
          News feeds <span className="num text-muted">{value.length} on</span>
        </h3>
        <p className="text-xs text-muted">The engine polls these (conditional GETs) and matches every headline against your markets.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {FEED_GROUPS.map(g => {
          const all = g.ids.every(id => on.has(id));
          return (
            <fieldset key={g.label} className="rounded-lg border border-line bg-bg p-2.5">
              <legend className="px-1 text-xs text-ink-2">
                {g.label}{' '}
                <button
                  type="button"
                  className="ml-1 text-[11px] text-accent hover:underline"
                  onClick={() => onChange(all ? value.filter(v => !g.ids.includes(v)) : [...new Set([...value, ...g.ids])])}
                >
                  {all ? 'none' : 'all'}
                </button>
              </legend>
              {g.ids.map(id => (
                <label key={id} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
                  <input type="checkbox" className="accent-[var(--accent)]" checked={on.has(id)} onChange={() => toggle(id)} />
                  <span className="num text-ink-2">{id}</span>
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      <div>
        <div className="mb-1 text-xs text-ink-2">Custom RSS / Atom URL</div>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={custom}
            onChange={e => setCustom(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCustom())}
            placeholder="https://example.com/feed.xml"
          />
          <Button onClick={addCustom}>Add</Button>
        </div>
        <div className="mt-1">
          <ErrorText error={error} />
        </div>
        {customFeeds.length > 0 && (
          <ul className="mt-2 space-y-1">
            {customFeeds.map(u => (
              <li key={u} className="flex items-center gap-2 text-xs">
                <span className="num min-w-0 flex-1 truncate text-ink-2">{u}</span>
                <button type="button" className="text-muted hover:text-crit" aria-label={`Remove ${u}`} onClick={() => toggle(u)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
