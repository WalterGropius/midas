// What every session tab needs: the session row, its markets, and a label for
// each market even before the engine has fetched it (falls back to seed.yaml).
import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { parseSeedYaml } from '@midas/core';
import { tables } from '@midas/stdb-bindings';
import type { Market, SeedFile, Session, SessionMarket } from '@midas/stdb-bindings/types';
import { shortHex } from '@/lib/format';

export interface SessionCtx {
  session: Session;
  sessionMarkets: readonly SessionMarket[];
  /** market rows for this session's markets (may be missing until the engine syncs) */
  markets: Map<string, Market>;
  label: (conditionId: string) => string;
  seedFiles: readonly SeedFile[];
  seedReady: boolean;
  conditionIds: string[];
}

export function useSessionData(id: bigint) {
  const sessionQ = useMemo(() => tables.session.where(r => r.id.eq(id)), [id]);
  const smQ = useMemo(() => tables.sessionMarket.where(r => r.sessionId.eq(id)), [id]);
  const seedQ = useMemo(() => tables.seedFile.where(r => r.sessionId.eq(id)), [id]);
  const [sessions, sessionReady] = useTable(sessionQ);
  const [sessionMarkets] = useTable(smQ);
  const [seedFiles, seedReady] = useTable(seedQ);
  const [allMarkets] = useTable(tables.market);

  const seedQuestions = useMemo(() => {
    const yaml = seedFiles.find(f => f.path === 'seed.yaml');
    if (!yaml) return new Map<string, string>();
    try {
      return new Map(parseSeedYaml(yaml.content).markets.filter(m => m.question).map(m => [m.conditionId, m.question!]));
    } catch {
      return new Map<string, string>();
    }
  }, [seedFiles]);

  const conditionIds = useMemo(
    () => [...sessionMarkets].sort((a, b) => Number(a.id - b.id)).map(m => m.conditionId),
    [sessionMarkets]
  );
  const markets = useMemo(() => {
    const want = new Set(conditionIds);
    return new Map(allMarkets.filter(m => want.has(m.conditionId)).map(m => [m.conditionId, m]));
  }, [allMarkets, conditionIds]);
  const allByCid = useMemo(() => new Map(allMarkets.map(m => [m.conditionId, m])), [allMarkets]);

  const label = useMemo(
    () => (cid: string) => {
      const m = allByCid.get(cid);
      const q = m?.question || seedQuestions.get(cid);
      if (!q) return shortHex(cid, 12);
      return m?.outcomeLabel && !q.includes(m.outcomeLabel) ? `${q} — ${m.outcomeLabel}` : q;
    },
    [allByCid, seedQuestions]
  );

  const session = sessions[0];
  const ctx: SessionCtx | undefined = session
    ? { session, sessionMarkets, markets, label, seedFiles, seedReady, conditionIds }
    : undefined;
  return { ctx, ready: sessionReady };
}
