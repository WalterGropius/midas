import type { NextConfig } from 'next';

// A pure static site: no API routes, no server runtime. The browser talks to
// SpacetimeDB directly over WebSocket, so `next build` never needs a database.
const nextConfig: NextConfig = {
  output: 'export',
  // emit /session/index.html etc. so any static host resolves /session?id=N
  trailingSlash: true,
  transpilePackages: ['@midas/core', '@midas/stdb-bindings'],
  images: { unoptimized: true },
  reactStrictMode: true,
  // don't write AGENTS.md / CLAUDE.md into the workspace on `next dev`
  agentRules: false,
};

export default nextConfig;
