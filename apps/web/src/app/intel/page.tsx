'use client';

import { AgentsBoard } from '@/features/intel/agents-board';
import { Calibrators } from '@/features/intel/calibrators';
import { EvolutionTimeline } from '@/features/intel/evolution';
import { ReflexPanel } from '@/features/intel/reflexes';

export default function IntelPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Intelligence</h1>
        <p className="text-xs text-muted">
          Who forecasts, how well, and how the system rewrites itself — scored only against realized prices and resolutions.
        </p>
      </div>
      <AgentsBoard />
      <ReflexPanel />
      <div className="grid gap-4 xl:grid-cols-2">
        <EvolutionTimeline />
        <Calibrators />
      </div>
    </div>
  );
}
