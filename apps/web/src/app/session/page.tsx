'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SessionView, TAB_IDS, type TabId } from '@/features/session/session-view';
import { Empty } from '@/components/ui';

// Static export has no dynamic segments: the session id travels as ?id=N.
function SessionRoute() {
  const params = useSearchParams();
  const raw = params.get('id') ?? '';
  const tab = (TAB_IDS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabId) : 'overview';
  if (!/^\d+$/.test(raw)) {
    return (
      <Empty title="No session selected">
        Open a session from the <Link className="text-accent hover:underline" href="/">command center</Link>.
      </Empty>
    );
  }
  return <SessionView key={raw} id={BigInt(raw)} tab={tab} />;
}

export default function SessionPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center font-mono text-xs text-muted">loading…</div>}>
      <SessionRoute />
    </Suspense>
  );
}
