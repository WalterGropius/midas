// The portfolio loop: mark every session to market, enforce circuit breakers,
// settle resolved markets, and run exits — target, stop, time stop, and the
// System-1 `position.exit` reflex fanned out over every open position.
import { circuitBreaker, type RiskLimits } from '@midas/core';
import type { Position, Session } from '@midas/stdb-bindings/types';
import type { EngineCtx } from '../ctx';
import { logger } from '../log';
import { msFromTs, ref, utcDay } from '../util/time';
import { book, execute, simulateRestingOrders } from './executor';

const log = logger('portfolio');

const lastEquityPoint = new Map<string, number>();
const lastExitReflex = new Map<string, number>();
let currentDay = utcDay();

/** Liquidation value of one share of `outcome` (the bid you could sell into). */
function markFor(ctx: EngineCtx, p: Position): number | undefined {
  const px = ctx.hub.price(p.conditionId);
  if (!px) return undefined;
  return p.outcome === 'YES' ? px.bid : 1 - px.ask;
}

async function closePosition(ctx: EngineCtx, s: Session, p: Position, why: string) {
  const m = ctx.hub.market(p.conditionId);
  if (!m) return;
  const bookRes = await ctx.hub.freshBook(p.conditionId, p.outcome as 'YES' | 'NO').catch(() => undefined);
  const bids = bookRes?.bids ?? [];
  if (bids.length === 0) {
    log.warn('no bids to exit into', { market: m.slug, why });
    return;
  }
  const fill = await execute(ctx, {
    session: s,
    market: m,
    outcome: p.outcome as 'YES' | 'NO',
    side: 'SELL',
    size: p.shares,
    limitPrice: Math.max(0.001, bids[0].price - 0.05),
    orderType: 'FAK',
    postOnly: false,
    decisionRef: ref('exit'),
    levels: bids,
    note: `exit: ${why}`,
  });
  const msg = `EXIT ${p.outcome} ${fill.filled.toFixed(1)}/${p.shares.toFixed(1)} @ ${fill.avgPrice.toFixed(3)} (${why}) — ${m.question.slice(0, 80)}`;
  ctx.activity({ sessionId: s.id, level: 'info', kind: 'exit', message: msg });
  await ctx.alerts.send('trade', msg);
}

async function settle(ctx: EngineCtx, s: Session, p: Position, outcomeYes: number) {
  const m = ctx.hub.market(p.conditionId);
  if (!m) return;
  const payout = p.outcome === 'YES' ? outcomeYes : 1 - outcomeYes;
  await book(ctx, { session: s, market: m, outcome: p.outcome as 'YES' | 'NO', side: 'SELL' }, { filled: p.shares, avgPrice: payout, fee: 0 });
  const pnl = p.shares * (payout - p.avgPrice);
  const msg = `SETTLED ${p.outcome} ${p.shares.toFixed(1)} @ ${payout} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} — ${m.question.slice(0, 80)}`;
  ctx.activity({ sessionId: s.id, level: 'info', kind: 'settle', message: msg });
  await ctx.alerts.send('trade', msg);
}

export async function markAll(ctx: EngineCtx) {
  await simulateRestingOrders(ctx);
  const day = utcDay();
  const newDay = day !== currentDay;
  currentDay = day;

  for (const s0 of [...ctx.conn.db.session.iter()]) {
    if (s0.status === 'archived') continue;
    let s = s0;
    const open = [...ctx.conn.db.position.sessionId.filter(s.id)].filter(p => !p.closed);

    // 1. settlement and exits
    for (const p of open) {
      const m = ctx.hub.market(p.conditionId);
      if (m?.resolved && m.outcomeYes !== undefined) {
        await settle(ctx, s, p, m.outcomeYes);
        continue;
      }
      if (s.status === 'stopped' || s.status === 'killed') {
        await closePosition(ctx, s, p, `session ${s.status}`);
        continue;
      }
      const mark = markFor(ctx, p);
      if (mark === undefined) continue;
      const nowMs = Date.now();
      if (p.targetPrice > 0 && mark >= p.targetPrice) await closePosition(ctx, s, p, `target ${p.targetPrice.toFixed(3)} hit`);
      else if (p.stopPrice > 0 && mark <= p.stopPrice) await closePosition(ctx, s, p, `stop ${p.stopPrice.toFixed(3)} hit`);
      else if (p.timeStopMicros > 0n && nowMs * 1000 >= Number(p.timeStopMicros)) await closePosition(ctx, s, p, 'time stop');
    }

    // 2. System-1 exit reflex over the remaining reaction positions (every 5 min each)
    const stillOpen = [...ctx.conn.db.position.sessionId.filter(s.id)].filter(p => !p.closed && p.strategy === 'reaction');
    const due = stillOpen.filter(p => Date.now() - (lastExitReflex.get(p.id.toString()) ?? 0) > 5 * 60_000);
    if (due.length > 0 && s.status === 'running') {
      const firings = await ctx.reflexes.fireMany(
        ['position.exit'],
        due.map(p => {
          lastExitReflex.set(p.id.toString(), Date.now());
          const m = ctx.hub.market(p.conditionId);
          const mark = markFor(ctx, p) ?? p.markPrice;
          const heldMin = (Date.now() - msFromTs(p.openedAt)) / 60_000;
          const expectedMove = Math.max(1e-6, p.targetPrice - p.avgPrice);
          const remaining = Math.max(0, (p.targetPrice - mark) / expectedMove);
          const pnlPct = (mark - p.avgPrice) / Math.max(0.01, p.avgPrice);
          return {
            refId: `pos:${p.id}:${Math.floor(Date.now() / 300_000)}`,
            state: {
              text: `POSITION: ${p.outcome} on "${m?.question ?? p.conditionId}" entered at ${p.avgPrice.toFixed(3)} ${heldMin.toFixed(0)} min ago; now ${mark.toFixed(3)}; target ${p.targetPrice.toFixed(3)}; stop ${p.stopPrice.toFixed(3)}; ${Math.round(remaining * 100)}% of the expected move still to come.`,
              features: { remainingMoveFrac: remaining, pnlPct },
            },
          };
        })
      );
      for (const [i, p] of due.entries()) {
        const f = firings[i]?.['position.exit'];
        if (f?.fire) await closePosition(ctx, s, p, `exit reflex p=${f.prob.toFixed(2)}`);
      }
    }

    // 3. mark to market (cash, fees and realized PnL only ever move in bookFill)
    let exposure = 0;
    const marks = [];
    const held = [...ctx.conn.db.position.sessionId.filter(s.id)].filter(p => !p.closed);
    for (const p of held) {
      const mark = markFor(ctx, p) ?? p.markPrice;
      exposure += p.shares * mark;
      marks.push({ positionId: p.id, markPrice: mark });
    }
    await ctx.conn.reducers.markToMarket({ items: [{ sessionId: s.id, marks, resetDayStart: newDay }] });
    s = ctx.conn.db.session.id.find(s.id) ?? s;
    const equity = s.cashUsd + exposure;
    const peak = Math.max(s.peakEquityUsd, equity);
    const dayStart = newDay ? equity : s.dayStartEquityUsd;

    // 4. circuit breakers
    if (s.status === 'running') {
      const breaker = circuitBreaker(
        {
          equityUsd: equity,
          cashUsd: s.cashUsd,
          peakEquityUsd: peak,
          dayStartEquityUsd: dayStart,
          exposureUsd: exposure,
          openPositions: held.length,
          exposureInMarketUsd: 0,
        },
        s.risk as RiskLimits
      );
      if (breaker === 'drawdown') {
        await ctx.conn.reducers.setSessionStatus({ sessionId: s.id, status: 'killed', reason: `drawdown ${(100 * (1 - equity / peak)).toFixed(1)}% ≥ ${(100 * s.risk.maxDrawdownPct).toFixed(0)}%` });
        await ctx.alerts.send('risk', `KILL SWITCH: session "${s.name}" hit max drawdown; closing positions.`);
      } else if (breaker === 'daily_loss') {
        await ctx.conn.reducers.setSessionStatus({ sessionId: s.id, status: 'paused', reason: `daily loss limit ${(100 * s.risk.maxDailyLossPct).toFixed(0)}% reached` });
        await ctx.alerts.send('risk', `PAUSED: session "${s.name}" hit its daily loss limit.`);
      }
    }

    // 5. equity curve (every 5 minutes)
    const k = s.id.toString();
    if (Date.now() - (lastEquityPoint.get(k) ?? 0) >= 5 * 60_000) {
      lastEquityPoint.set(k, Date.now());
      await ctx.conn.reducers.recordEquity({ points: [{ sessionId: s.id, equityUsd: equity, cashUsd: s.cashUsd, exposureUsd: exposure }] });
    }
  }
}

