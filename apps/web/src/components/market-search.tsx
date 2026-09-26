'use client';

import { useEffect, useState } from 'react';
import { lookupSlug, marketTitle, searchMarkets, slugFromInput, type GammaMarket } from '@/lib/gamma';
import { cents, compact, dateOnly, pct } from '@/lib/format';
import { Button, ErrorText, inputCls } from './ui';

/** Search Polymarket (Gamma public-search) or paste a URL / slug. */
export function MarketSearch({
  selected,
  onPick,
  pickLabel = 'Add',
}: {
  selected: Set<string>;
  onPick: (m: GammaMarket) => void;
  pickLabel?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GammaMarket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState('');

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setError(null);
      setSearched('');
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const slug = slugFromInput(query);
        let found: GammaMarket[] = slug ? await lookupSlug(slug, ctrl.signal) : [];
        if (found.length === 0 && !/^https?:/i.test(query)) found = await searchMarkets(query, ctrl.signal);
        setResults(found);
        setSearched(query);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message || 'search failed');
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          className={inputCls}
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search Polymarket (e.g. “fed rate cut”) or paste a polymarket.com URL / slug"
          aria-label="Search markets"
        />
        {loading && <span className="absolute right-2.5 top-2 font-mono text-[11px] text-muted">searching…</span>}
      </div>
      <ErrorText error={error} />
      {searched && !loading && results.length === 0 && !error && (
        <div className="text-xs text-muted">No open markets match “{searched}”. Try fewer words, or paste the market URL.</div>
      )}
      {results.length > 0 && (
        <ul className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-md border border-line">
          {results.map(m => {
            const added = selected.has(m.conditionId);
            return (
              <li key={m.conditionId} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink">{marketTitle(m)}</div>
                  {m.eventTitle && m.eventTitle !== m.question && (
                    <div className="truncate text-[11px] text-muted">{m.eventTitle}</div>
                  )}
                  <div className="num mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-2">
                    <span title="YES price">YES {cents(m.yesPrice)}</span>
                    <span title="24h volume">vol ${compact(m.volume24h)}</span>
                    <span title="End date">ends {dateOnly(m.endDate)}</span>
                    <span title="Taker fee rate">fee {pct(m.feeRate, 1)}</span>
                    {m.negRisk && <span className="text-muted">neg-risk</span>}
                    {!m.active && <span className="text-warn">inactive</span>}
                  </div>
                </div>
                <Button size="sm" variant={added ? 'ghost' : 'default'} disabled={added} onClick={() => onPick(m)}>
                  {added ? 'added ✓' : pickLabel}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
