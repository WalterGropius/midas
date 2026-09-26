'use client';

import { Card } from '@/components/ui';
import { ConnectionCard, EnginePing } from '@/features/settings/connection';
import { LiveApprovals, RiskWarning } from '@/features/settings/live-approvals';
import { OperatorsCard } from '@/features/settings/operators';

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <ConnectionCard />
          <Card title="Engine control API">
            <EnginePing />
          </Card>
        </div>
        <div className="min-w-0 space-y-4">
          <OperatorsCard />
          <RiskWarning />
          <LiveApprovals />
        </div>
      </div>
    </div>
  );
}
