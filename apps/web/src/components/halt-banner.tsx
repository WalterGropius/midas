'use client';

import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';

/** Site-wide banner while the global kill switch is on. */
export function HaltBanner() {
  const [flags] = useTable(tables.globalFlag);
  const halted = flags.find(f => f.key === 'halt_all')?.value === 'true';
  if (!halted) return null;
  return (
    <div role="status" className="border-b border-crit/50 bg-crit/15 px-4 py-1.5 text-center font-mono text-xs text-crit">
      ✕ GLOBAL HALT — the engine places no orders in any session until an operator lifts it on the Command page.
    </div>
  );
}
