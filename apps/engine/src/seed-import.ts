// CLI: turn a local seed folder into a running session.
//   npm run seed:import -- ./seeds/example-fed-december
// The session is owned by the engine identity; the web onboarding flow is the
// usual path (it creates the same folder and owns the session as the user).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_INTEL, DEFAULT_RISK, parseSeedFiles, type SeedFile } from '@midas/core';
import { connectStdb, ensureEngineRole } from './stdb';
import { logger } from './log';

const log = logger('seed-import');

function walk(dir: string, root = dir): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, root));
    else if (/\.(md|txt|ya?ml|json|csv)$/i.test(entry.name) && fs.statSync(full).size < 190_000) {
      out.push({ path: path.relative(root, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

function kindOf(p: string): SeedFile['kind'] {
  if (p === 'seed.yaml') return 'config';
  if (p === 'SCHEMA.md') return 'schema';
  if (p.startsWith('wiki/')) return 'wiki';
  return 'raw';
}

async function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(path.join(dir, 'seed.yaml'))) {
    console.error('usage: npm run seed:import -- <folder containing seed.yaml>');
    process.exit(1);
  }
  const files = walk(dir);
  const cfg = parseSeedFiles(files);
  const markets = cfg.markets.filter(m => m.conditionId);
  if (markets.length === 0) throw new Error('seed.yaml lists no markets with a conditionId');
  const stdb = await connectStdb();
  await ensureEngineRole(stdb);
  await stdb.conn.reducers.createSession({
    name: cfg.name,
    mode: cfg.mode,
    bankrollUsd: cfg.bankrollUsd,
    risk: { ...DEFAULT_RISK, ...cfg.risk },
    intel: { ...DEFAULT_INTEL, ...cfg.intel },
    thesis: cfg.thesis,
    markets: markets.map(m => ({ conditionId: m.conditionId, note: m.note ?? '', prior: m.prior })),
    files: files.map(f => ({ path: f.path, kind: kindOf(f.path), content: f.content })),
  });
  log.info('session created', { name: cfg.name, markets: markets.length, files: files.length, mode: cfg.mode });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
