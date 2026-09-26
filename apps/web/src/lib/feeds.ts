// Feed ids understood by the engine's RSS registry (apps/engine/src/feeds/rss.ts,
// FEED_REGISTRY / DEFAULT_FEED_IDS). Copied, not imported: the UI never ships
// engine code. Custom http(s) URLs are passed through to the engine as is.

export const FEED_GROUPS: { label: string; ids: string[] }[] = [
  {
    label: 'Bloomberg',
    ids: [
      'bloomberg:markets',
      'bloomberg:politics',
      'bloomberg:economics',
      'bloomberg:technology',
      'bloomberg:industries',
      'bloomberg:opinion',
      'bloomberg:businessweek',
    ],
  },
  { label: 'CNBC', ids: ['cnbc:top', 'cnbc:finance', 'cnbc:markets'] },
  { label: 'WSJ / MarketWatch', ids: ['wsj:markets', 'marketwatch:top'] },
  {
    label: 'Central banks & regulators',
    ids: ['fed:press', 'fed:monetary', 'fed:speeches', 'ecb:press', 'boe:news', 'sec:press'],
  },
  { label: 'Crypto', ids: ['coindesk', 'cointelegraph', 'theblock'] },
  {
    label: 'General',
    ids: [
      'yahoo:finance',
      'bbc:business',
      'bbc:world',
      'ft:home',
      'ft:markets',
      'nyt:business',
      'guardian:business',
      'economist:finance',
      'nasdaq:markets',
    ],
  },
];

export const DEFAULT_FEED_IDS = [
  'bloomberg:markets',
  'bloomberg:politics',
  'bloomberg:economics',
  'bloomberg:technology',
  'cnbc:top',
  'wsj:markets',
  'fed:press',
  'bbc:world',
];
