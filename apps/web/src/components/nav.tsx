'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { cx } from './ui';

const LINKS = [
  { href: '/', label: 'Command' },
  { href: '/intel', label: 'Intel' },
  { href: '/memory', label: 'Memory' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const pathname = usePathname() || '/';
  const isActive = (href: string) => (href === '/' ? pathname === '/' || pathname.startsWith('/session') : pathname.startsWith(href));
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        <Link href="/" className="flex items-center gap-2 font-mono text-sm font-semibold tracking-[0.2em] text-accent">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rotate-45 bg-accent" />
          MIDAS
        </Link>
        <nav className="flex flex-wrap items-center gap-0.5">
          {LINKS.map(l => (
            <Link
              key={l.href}
              href={l.href}
              className={cx(
                'rounded px-2 py-1 text-[13px] transition-colors',
                isActive(l.href) ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink-2'
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/onboarding"
            className={cx(
              'rounded-md border px-2.5 py-1 text-xs font-medium',
              pathname.startsWith('/onboarding')
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-accent/60 text-accent hover:bg-accent hover:text-accent-ink'
            )}
          >
            + New session
          </Link>
          <ThemeToggle />
          <ConnectionDot />
        </div>
      </div>
    </header>
  );
}

function ConnectionDot() {
  const { isActive, connectionError } = useSpacetimeDB();
  const state = isActive ? 'live' : connectionError ? 'offline' : 'connecting';
  const cls = isActive ? 'bg-good' : connectionError ? 'bg-crit' : 'bg-warn animate-pulse';
  return (
    <Link
      href="/settings"
      className="flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-ink-2"
      title={connectionError ? `SpacetimeDB: ${connectionError.message}` : `SpacetimeDB ${state}`}
    >
      <span aria-hidden className={cx('inline-block h-2 w-2 rounded-full', cls)} />
      {state}
    </Link>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('midas.theme', next);
    } catch {
      /* storage blocked: theme lasts for this page only */
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-ink-2"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title="Toggle theme"
    >
      {theme === 'dark' ? 'dark' : 'light'}
    </button>
  );
}
