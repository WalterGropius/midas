import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { ClientOnly, Providers } from './providers';
import { Nav } from '@/components/nav';
import { HaltBanner } from '@/components/halt-banner';

export const metadata: Metadata = {
  title: 'MIDAS',
  description: 'Multi-agent prediction-market trading harness',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d0d0d',
};

// Applied before paint so the stored theme never flashes.
const themeScript = `try{var t=localStorage.getItem('midas.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen overflow-x-hidden">
        <Providers>
          <Nav />
          <ClientOnly>
            <HaltBanner />
          </ClientOnly>
          <main className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-4">
            <ClientOnly fallback={<div className="py-20 text-center font-mono text-xs text-muted">loading…</div>}>
              {children}
            </ClientOnly>
          </main>
        </Providers>
      </body>
    </html>
  );
}
