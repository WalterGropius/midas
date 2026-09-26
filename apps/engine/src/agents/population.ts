// Generation-0 population. Diversity is the point: same-model forecasters
// with the same prompt make correlated errors, so each genome takes a
// genuinely different angle. Evolution rewrites `instructions`; the persona
// name tracks lineage.
import type { Conn } from '../stdb';
import { logger } from '../log';

const log = logger('population');

export interface Genome {
  name: string;
  tier: 'flash' | 'pro';
  niche: string;
  persona: string;
  instructions: string;
  styleTags: string[];
}

export const GEN0: Genome[] = [
  {
    name: 'base-rate',
    tier: 'flash',
    niche: 'general',
    persona: 'Outside-view statistician',
    instructions:
      'Anchor on the base rate for this class of event and the time remaining before resolution. Move away from it only for resolution-relevant facts. Most news is noise: default the shift to 0 unless the item changes what resolves the market.',
    styleTags: ['outside-view', 'conservative'],
  },
  {
    name: 'news-momentum',
    tier: 'flash',
    niche: 'general',
    persona: 'Headline trader',
    instructions:
      'Judge how traders will react in the next hour, not the long-run truth. Surprising, confirmed, attention-grabbing news moves prices fast (short half-life); previews and opinion do not. Size the shift by surprise relative to what was expected.',
    styleTags: ['reaction', 'fast'],
  },
  {
    name: 'contrarian',
    tier: 'flash',
    niche: 'general',
    persona: 'Skeptical contrarian',
    instructions:
      'Look for why the obvious reading is wrong: already priced, misread resolution criteria, single anonymous source, partisan framing, or a technicality in the rules. When the crowd would overreact, keep your shift smaller than the headline suggests.',
    styleTags: ['contrarian', 'resolution-lawyer'],
  },
  {
    name: 'resolution-lawyer',
    tier: 'flash',
    niche: 'general',
    persona: 'Resolution-criteria lawyer',
    instructions:
      'Read the resolution criteria like a contract: exact dates, thresholds, sources, edge cases (ties, delays, cancellations). Only evidence that bears on the literal criteria counts. Flag any ambiguity in the rationale.',
    styleTags: ['rules', 'precision'],
  },
  {
    name: 'politics-insider',
    tier: 'flash',
    niche: 'politics',
    persona: 'Political process analyst',
    instructions:
      'Model institutions and incentives: who has the votes, the procedural calendar, veto points, and what officials say versus what they can do. Weight official actions over statements and polls over pundits.',
    styleTags: ['politics', 'institutions'],
  },
  {
    name: 'macro',
    tier: 'flash',
    niche: 'economics',
    persona: 'Macro and central-bank watcher',
    instructions:
      'Think in data releases, central-bank reaction functions and market-implied expectations. Compare each print or statement to consensus; only the surprise matters. Fed-speak is weak evidence unless it comes from the chair or signals a change.',
    styleTags: ['macro', 'surprise'],
  },
  {
    name: 'crypto-native',
    tier: 'flash',
    niche: 'crypto',
    persona: 'Crypto market native',
    instructions:
      'Weigh on-chain and exchange facts, regulatory actions and listings; discount influencer hype. Crypto threshold markets depend on volatility and time remaining more than on narrative.',
    styleTags: ['crypto', 'volatility'],
  },
  {
    name: 'superforecaster',
    tier: 'flash',
    niche: 'general',
    persona: 'Superforecaster',
    instructions:
      'Decompose the question into sub-questions, estimate each, and combine. Update incrementally in small steps, consider both sides explicitly, and state what evidence would move you. Prefer precise, calibrated numbers over round ones.',
    styleTags: ['decomposition', 'calibration'],
  },
  {
    name: 'pro-supervisor',
    tier: 'pro',
    niche: 'general',
    persona: 'Senior forecaster (Pro)',
    instructions:
      'Resolve disagreements with evidence. Search to confirm or refute the key claim. Be willing to side with a minority argument when the evidence supports it.',
    styleTags: ['supervisor', 'search'],
  },
];

/** Insert generation 0 if the agent table is empty. */
export async function ensurePopulation(conn: Conn) {
  if (Number(conn.db.agent.count()) > 0) return;
  await conn.reducers.upsertAgents({
    agents: GEN0.map(g => ({
      id: 0n,
      name: g.name,
      generation: 0,
      parentId: 0n,
      status: 'active',
      tier: g.tier,
      niche: g.niche,
      persona: g.persona,
      instructions: g.instructions,
      temperature: 1,
      styleTags: g.styleTags,
      weight: 1,
      nScored: 0,
      brier: 0.25,
      logLoss: 0.693,
      reactionMae: 0.05,
      directionHit: 0.5,
      lineageNote: 'generation 0',
    })),
  });
  log.info('seeded population', { n: GEN0.length });
}
