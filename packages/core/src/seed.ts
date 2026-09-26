// Seed folders.
//
// A session starts from a folder the user fills in onboarding (or by hand).
// Its layout follows the "LLM wiki" pattern: raw/ holds immutable sources the
// user supplies, wiki/ is compiled and maintained by the agents (and keeps
// compounding), SCHEMA.md tells every agent the conventions, seed.yaml holds
// money, markets, risk and feeds.
//
//   seeds/<slug>/
//     seed.yaml          ← config (bankroll, markets, risk, intel, feeds, keywords)
//     SCHEMA.md          ← conventions for agents maintaining the wiki
//     thesis.md          ← the user's view, priors and red lines
//     raw/…              ← user sources: notes, articles, data (never rewritten)
//     wiki/index.md      ← catalog of pages, one line each
//     wiki/log.md        ← append-only timeline of ingests, trades, lessons
//     wiki/markets/*.md  ← one page per market (compiled)
//     wiki/entities/*.md ← one page per entity (compiled)
//     wiki/lessons.md    ← distilled lessons from resolved predictions
import YAML from 'yaml';
import { DEFAULT_RISK, type RiskLimits } from './risk';

export interface IntelSettings {
  swarmSize: number;
  proCallsPerHour: number;
  escalateEdge: number;
  escalateDisagreement: number;
  dailyLlmBudgetUsd: number;
}

export const DEFAULT_INTEL: IntelSettings = {
  swarmSize: 6,
  proCallsPerHour: 12,
  escalateEdge: 0.06,
  escalateDisagreement: 0.5,
  dailyLlmBudgetUsd: 10,
};

export interface SeedMarket {
  conditionId: string;
  question?: string;
  slug?: string;
  note?: string;
  prior?: number;
}

export interface SeedConfig {
  name: string;
  mode: 'paper' | 'live';
  bankrollUsd: number;
  markets: SeedMarket[];
  risk: RiskLimits;
  intel: IntelSettings;
  feeds: string[];
  keywords: string[];
  thesis: string;
}

export interface SeedFile {
  path: string;
  kind: 'config' | 'schema' | 'raw' | 'wiki';
  content: string;
}

export const DEFAULT_FEEDS = [
  'bloomberg:markets',
  'bloomberg:politics',
  'bloomberg:economics',
  'bloomberg:technology',
];

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'session'
  );
}

const SCHEMA_MD = `# SCHEMA — how agents maintain this folder

This folder is a living knowledge base for one trading session. Humans write
\`raw/\` and \`thesis.md\`; agents compile and maintain \`wiki/\`.

## Layers
- \`raw/\` — immutable sources (notes, articles, data). Agents read, never edit.
- \`wiki/\` — compiled knowledge. Agents create and update pages; every claim
  cites its source as \`[news:<id>]\`, \`[raw:<path>]\`, or \`[trade:<ref>]\`.
- \`seed.yaml\` — configuration. Only the human changes money and risk.

## Pages
- \`wiki/index.md\` — one line per page: \`- [[path]] — summary\`. Update on every write.
- \`wiki/log.md\` — append-only. \`## [YYYY-MM-DD HH:MM] <kind> | <title>\` then 1–3 lines.
- \`wiki/markets/<slug>.md\` — question, resolution criteria, current fair value
  with reasoning, key drivers, what would change our mind, recent signals.
- \`wiki/entities/<slug>.md\` — who/what it is, relations, recent developments.
- \`wiki/lessons.md\` — lessons from resolved predictions: pattern → evidence → rule.

## Operations
- **ingest**: a new source or headline → touch every page it affects (often 5–15),
  append to log.md, refresh index.md.
- **query**: answer from the wiki first; file durable answers back as pages.
- **lint**: find contradictions, stale claims, orphans, missing cross-links; fix them.

## Rules
- Prefer updating an existing page over creating a near-duplicate.
- Mark uncertainty explicitly; never state a probability without its basis.
- When newer facts contradict a page, rewrite the claim and log the change.
`;

export function buildSeedFiles(cfg: SeedConfig, raw: { path: string; content: string }[] = []): SeedFile[] {
  const yamlDoc = {
    name: cfg.name,
    mode: cfg.mode,
    bankrollUsd: cfg.bankrollUsd,
    markets: cfg.markets.map(m => ({
      conditionId: m.conditionId,
      ...(m.question ? { question: m.question } : {}),
      ...(m.slug ? { slug: m.slug } : {}),
      ...(m.note ? { note: m.note } : {}),
      ...(m.prior !== undefined ? { prior: m.prior } : {}),
    })),
    risk: cfg.risk,
    intel: cfg.intel,
    feeds: cfg.feeds,
    keywords: cfg.keywords,
  };
  const marketLines = cfg.markets.map(m => `- [[markets/${slugify(m.slug || m.question || m.conditionId)}]] — ${m.question ?? m.conditionId}`);
  const files: SeedFile[] = [
    { path: 'seed.yaml', kind: 'config', content: YAML.stringify(yamlDoc) },
    { path: 'SCHEMA.md', kind: 'schema', content: SCHEMA_MD },
    { path: 'thesis.md', kind: 'raw', content: `# Thesis\n\n${cfg.thesis.trim() || '_No thesis yet._'}\n` },
    {
      path: 'wiki/index.md',
      kind: 'wiki',
      content: `# Index\n\n## Markets\n${marketLines.join('\n') || '_none yet_'}\n\n## Entities\n_compiled as news arrives_\n\n## Lessons\n- [[lessons]] — distilled lessons from resolved predictions\n`,
    },
    {
      path: 'wiki/log.md',
      kind: 'wiki',
      content: `# Log\n\n## [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] seed | session created\nBankroll $${cfg.bankrollUsd}, ${cfg.markets.length} market(s), mode ${cfg.mode}.\n`,
    },
    { path: 'wiki/lessons.md', kind: 'wiki', content: '# Lessons\n\n_None yet. Lessons are distilled from resolved predictions._\n' },
  ];
  for (const r of raw) {
    const path = r.path.startsWith('raw/') ? r.path : `raw/${r.path}`;
    files.push({ path, kind: 'raw', content: r.content });
  }
  return files;
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt;
}

export function parseSeedYaml(text: string): SeedConfig {
  const doc = (YAML.parse(text) ?? {}) as Record<string, unknown>;
  const risk = { ...DEFAULT_RISK, ...((doc.risk as object) ?? {}) } as RiskLimits;
  const intel = { ...DEFAULT_INTEL, ...((doc.intel as object) ?? {}) } as IntelSettings;
  const markets = Array.isArray(doc.markets)
    ? (doc.markets as Record<string, unknown>[])
        .map(m => ({
          conditionId: String(m.conditionId ?? m.condition_id ?? ''),
          question: m.question ? String(m.question) : undefined,
          slug: m.slug ? String(m.slug) : undefined,
          note: m.note ? String(m.note) : undefined,
          prior: m.prior === undefined ? undefined : num(m.prior, 0.5),
        }))
        .filter(m => m.conditionId || m.slug)
    : [];
  return {
    name: String(doc.name ?? 'untitled'),
    mode: doc.mode === 'live' ? 'live' : 'paper',
    bankrollUsd: num(doc.bankrollUsd, 1000),
    markets,
    risk,
    intel,
    feeds: Array.isArray(doc.feeds) ? doc.feeds.map(String) : DEFAULT_FEEDS,
    keywords: Array.isArray(doc.keywords) ? doc.keywords.map(String) : [],
    thesis: '',
  };
}

export function parseSeedFiles(files: { path: string; content: string }[]): SeedConfig {
  const yamlFile = files.find(f => f.path === 'seed.yaml');
  if (!yamlFile) throw new Error('seed folder has no seed.yaml');
  const cfg = parseSeedYaml(yamlFile.content);
  const thesis = files.find(f => f.path === 'thesis.md');
  return { ...cfg, thesis: thesis ? thesis.content.replace(/^# Thesis\s*/, '').trim() : '' };
}
