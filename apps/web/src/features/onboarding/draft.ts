// Onboarding draft: everything the wizard collects before it becomes a seed
// folder. Kept in localStorage as a per-browser convenience so a reload does
// not lose the form (never relied on: the source of truth is the session row).
import { DEFAULT_INTEL, DEFAULT_RISK, type IntelSettings, type RiskLimits, type SeedConfig } from '@midas/core';
import { DEFAULT_FEED_IDS } from '@/lib/feeds';

export interface PickedMarket {
  conditionId: string;
  question: string;
  slug: string;
  eventTitle: string;
  yesPrice: number | undefined;
  endDate: string;
  feeRate: number;
  note: string;
  /** optional prior probability of YES, 0–1 */
  prior: number | undefined;
}

export interface RawFile {
  name: string;
  content: string;
}

export interface Draft {
  bankrollUsd: number;
  mode: 'paper' | 'live';
  risk: RiskLimits;
  markets: PickedMarket[];
  name: string;
  thesis: string;
  keywords: string[];
  rawFiles: RawFile[];
  feeds: string[];
  intel: IntelSettings;
}

export const EMPTY_DRAFT: Draft = {
  bankrollUsd: 1000,
  mode: 'paper',
  risk: { ...DEFAULT_RISK },
  markets: [],
  name: '',
  thesis: '',
  keywords: [],
  rawFiles: [],
  feeds: [...DEFAULT_FEED_IDS],
  intel: { ...DEFAULT_INTEL },
};

const KEY = 'midas.onboarding.draft';

export function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_DRAFT;
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      ...EMPTY_DRAFT,
      ...d,
      risk: { ...EMPTY_DRAFT.risk, ...d.risk },
      intel: { ...EMPTY_DRAFT.intel, ...d.intel },
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(d: Draft | null) {
  try {
    if (d === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* quota exceeded (large raw files) or storage blocked: the draft just isn't kept */
  }
}

export function toSeedConfig(d: Draft): SeedConfig {
  return {
    name: d.name.trim() || 'untitled',
    mode: d.mode,
    bankrollUsd: d.bankrollUsd,
    markets: d.markets.map(m => ({
      conditionId: m.conditionId,
      question: m.question || undefined,
      slug: m.slug || undefined,
      note: m.note.trim() || undefined,
      prior: m.prior,
    })),
    risk: d.risk,
    intel: d.intel,
    feeds: d.feeds,
    keywords: d.keywords,
    thesis: d.thesis,
  };
}

/** Server limit per seed file (upsertSeedFileRow rejects > 200k chars). */
export const MAX_FILE_CHARS = 200_000;

export function safeFileName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w.\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'source.txt'
  );
}
