'use client';

import { EngineHeartbeats } from '@/features/ledger/heartbeats';
import { LlmUsagePanel } from '@/features/ledger/llm-usage';
import { TaskMatrix, TaskTable } from '@/features/ledger/tasks';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';

export default function LedgerPage() {
  // One subscription for the whole task ledger (terminal tasks are pruned after 7 days).
  const [tasks, ready] = useTable(tables.agentTask);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Ledger</h1>
        <p className="text-xs text-muted">
          The synaptic ledger: every unit of agent work is a leased task in SpacetimeDB, so any worker can die and another resumes.
        </p>
      </div>
      <TaskMatrix tasks={tasks} ready={ready} />
      <LlmUsagePanel />
      <TaskTable tasks={tasks} ready={ready} />
      <EngineHeartbeats />
    </div>
  );
}
