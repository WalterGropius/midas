// Gemini client: Flash for breadth, Pro for depth. Reached directly with
// GEMINI_API_KEY, or through Vercel AI Gateway with AI_GATEWAY_API_KEY
// (MIDAS_GEMINI_VIA picks; see gateway.ts).
//
// Prompt-caching discipline (Gemini discounts a byte-stable prefix
// implicitly): the system instruction is a module constant, shared context
// comes first in the user turn, and anything agent-specific or volatile
// (persona, timestamps) goes LAST. Swarm members therefore share one cached
// prefix and only pay full price for their short tail.
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { config } from '../config';
import { logger } from '../log';
import { limiter, retry, withTimeout } from '../util/async';
import { gatewayAvailable, gatewayEmbed, gatewayJson, gatewayModel } from './gateway';
import { extractJson } from './json';
import { usage } from './usage';

const log = logger('gemini');

export type Tier = 'flash' | 'flashLite' | 'pro';
export type Thinking = 'minimal' | 'low' | 'medium' | 'high';

let client: GoogleGenAI | undefined;
function ai(): GoogleGenAI {
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY is not set');
  client ??= new GoogleGenAI({
    apiKey: config.gemini.apiKey,
    ...(config.gemini.baseUrl ? { httpOptions: { baseUrl: config.gemini.baseUrl } } : {}),
  });
  return client;
}

/** How Gemini is reached right now, or undefined when it is not. */
export function llmBackend(): 'direct' | 'gateway' | undefined {
  const via = config.gemini.via;
  if (via !== 'gateway' && config.gemini.apiKey) return 'direct';
  if (via !== 'direct' && gatewayAvailable()) return 'gateway';
  return undefined;
}

export function geminiAvailable(): boolean {
  return llmBackend() !== undefined;
}

const gate = limiter(config.gemini.maxConcurrent);

export function modelFor(tier: Tier): string {
  return tier === 'pro' ? config.gemini.pro : tier === 'flashLite' ? config.gemini.flashLite : config.gemini.flash;
}

export interface JsonCall {
  route: string;
  tier: Tier;
  system: string;
  /** stable, shareable context first … */
  prefix: string;
  /** … then the part that differs per call */
  suffix?: string;
  /** JSON schema for the response */
  schema: Record<string, unknown>;
  temperature?: number;
  /** reasoning effort (Gemini 3 thinking level; 3.8 Flash / 3.1 Pro accept low|medium|high) */
  thinking?: Thinking;
  maxOutputTokens?: number;
  timeoutMs?: number;
  sessionId?: bigint;
  /**
   * Ground the answer in live web results: Google Search when direct, the
   * gateway's search tool (run with `query`) when via AI Gateway.
   */
  search?: { query: string };
}

export interface JsonResult<T> {
  data: T;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
}

const THINKING: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export class BudgetExceeded extends Error {}

export async function generateJson<T>(call: JsonCall): Promise<JsonResult<T>> {
  if (usage.overGlobalBudget()) throw new BudgetExceeded(`global daily LLM budget $${config.gemini.globalDailyBudgetUsd} reached`);
  const model = modelFor(call.tier);
  const timeoutMs = call.timeoutMs ?? (call.tier === 'pro' ? 120_000 : 45_000);
  if (llmBackend() === 'gateway') return gatewayJson<T>({ ...call, model: gatewayModel(model), timeoutMs });
  const text = call.suffix ? `${call.prefix}\n\n${call.suffix}` : call.prefix;
  const t0 = Date.now();
  const res = await gate(() =>
    retry(
      () =>
        withTimeout(
          ai().models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text }] }],
            config: {
              systemInstruction: call.system,
              // Gemini 3 wants the default temperature (1.0); lower values can loop.
              ...(call.temperature !== undefined && !model.startsWith('gemini-3') ? { temperature: call.temperature } : {}),
              maxOutputTokens: call.maxOutputTokens ?? 4096,
              responseMimeType: 'application/json',
              responseJsonSchema: call.schema,
              // Search grounding composes with JSON output on Gemini 3.
              ...(call.search ? { tools: [{ googleSearch: {} }] } : {}),
              ...(call.thinking ? { thinkingConfig: { thinkingLevel: THINKING[call.thinking] } } : {}),
            },
          }),
          timeoutMs,
          `${call.route}/${model}`
        ),
      { attempts: 3, label: call.route }
    )
  );
  const u = res.usageMetadata ?? {};
  const tokensIn = u.promptTokenCount ?? 0;
  const tokensOut = u.candidatesTokenCount ?? 0;
  const cachedTokens = u.cachedContentTokenCount ?? 0;
  const thoughtTokens = u.thoughtsTokenCount ?? 0;
  const costUsd = usage.record(
    { route: call.route, model, tier: call.tier, tokensIn, tokensOut, cachedTokens, thoughtTokens },
    call.sessionId
  );
  const raw = res.text ?? '';
  let data: T;
  try {
    data = extractJson(raw) as T;
  } catch (err) {
    log.warn('bad JSON from model', { route: call.route, model, err: String(err) });
    throw err;
  }
  return { data, model, tokensIn, tokensOut: tokensOut + thoughtTokens, cachedTokens, costUsd, latencyMs: Date.now() - t0 };
}

/**
 * Embeddings in input order. gemini-embedding-2 has no taskType: the task goes
 * into the text. Each text must be its own Content, or the API merges them
 * into a single aggregated vector.
 */
export async function embed(texts: string[], task = 'sentence similarity'): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = config.gemini.embed;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const chunk = texts.slice(i, i + 64).map(t => `task: ${task} | query: ${t.slice(0, 6000)}`);
    if (llmBackend() === 'gateway') {
      for (const v of await gatewayEmbed(gatewayModel(model), chunk, config.gemini.embedDims)) out.push(normalize(v));
      continue;
    }
    const res = await gate(() =>
      retry(
        () =>
          ai().models.embedContent({
            model,
            contents: chunk.map(text => ({ parts: [{ text }] })),
            config: { outputDimensionality: config.gemini.embedDims },
          }),
        { attempts: 3, label: 'embed' }
      )
    );
    const approxTokens = chunk.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
    usage.record({ route: 'embed', model, tier: 'embed', tokensIn: approxTokens, tokensOut: 0, cachedTokens: 0, thoughtTokens: 0 });
    for (const e of res.embeddings ?? []) out.push(normalize(e.values ?? []));
  }
  return out;
}

function normalize(v: number[]): number[] {
  // outputDimensionality < 3072 is not pre-normalized; cosine wants unit vectors
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}
