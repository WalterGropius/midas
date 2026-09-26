'use client';

import { ActivityFeed } from '@/features/command/activity-feed';
import { EngineCard } from '@/features/command/engine-card';
import { GlobalStats } from '@/features/command/global-stats';
import { HaltCard } from '@/features/command/halt-card';
import { SessionsGrid } from '@/features/command/sessions-grid';

export default function CommandCenter() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
        <EngineCard />
        <HaltCard />
      </div>
      <GlobalStats />
      <SessionsGrid />
      <ActivityFeed />
    </div>
  );
}
