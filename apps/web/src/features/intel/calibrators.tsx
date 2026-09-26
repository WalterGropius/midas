'use client';

import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import { Card, Empty, TableWrap } from '@/components/ui';
import { fixed, int, relTime, tsMs } from '@/lib/format';
import { useNow } from '@/lib/stdb';

/** Platt calibrators per component: calibrated = sigmoid(a·logit(p) + b). */
export function Calibrators() {
  const [rows, ready] = useTable(tables.calibrator);
  const now = useNow(60_000);
  const shown = [...rows].sort((a, b) => a.component.localeCompare(b.component));
  return (
    <Card title={`Calibrators · ${rows.length}`}>
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No calibrators fitted yet">
          Every probabilistic component logs (probability, outcome) pairs; once enough resolve, the engine fits a Platt calibrator per
          component and reports expected calibration error before and after.
        </Empty>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[560px]">
            <thead>
              <tr>
                <th>Component</th>
                <th className="r">a</th>
                <th className="r">b</th>
                <th className="r">n</th>
                <th className="r">ECE before → after</th>
                <th className="r">Brier before → after</th>
                <th className="r">Fitted</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(c => (
                <tr key={c.component}>
                  <td className="font-mono text-[12px] text-ink">{c.component}</td>
                  <td className="num r">{fixed(c.a, 3)}</td>
                  <td className="num r">{fixed(c.b, 3)}</td>
                  <td className="num r">{int(c.n)}</td>
                  <td className="num r">
                    {fixed(c.eceBefore, 3)} → <span className="text-ink">{fixed(c.eceAfter, 3)}</span>
                  </td>
                  <td className="num r">
                    {fixed(c.brierBefore, 3)} → <span className="text-ink">{fixed(c.brierAfter, 3)}</span>
                  </td>
                  <td className="num r text-muted">{relTime(tsMs(c.updatedAt), now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}
