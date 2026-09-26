// Vercel AI Gateway: one key reaches Gemini (when there is no GEMINI_API_KEY),
// other model families for the swarm, embeddings, and Jev (s1/systemone.ts).
// It speaks the OpenAI-compatible chat API, which OpenRouter shares, so both
// go through `compatJson`.
//
// Gateway behavior this relies on (docs, 2026-09):
// - Gemini 3 thinking: the shared `reasoning.effort` maps low→low and anything
//   else→high, so the exact level also rides in providerOptions.{google,vertex}.
// - Google Search grounding is AI SDK-only; over REST the gateway runs its own
//   search tool (`vercel:perplexity_search` …) server-side before answering.
// - The billed cost, search included, comes back in provider_metadata.gateway.
import { config } from '../config';
import { logger } from '../log';
import { HttpError, limiter, retry, withTimeout } from '../util/async';
import type { JsonResult, Thinking, Tier } from './gemini';
import { extractJson } from './json';
import { costOf, usage } from './usage';

const log = logger('gateway');

export function gatewayAvailable(): boolean {
  return Boolean(config.gateway.apiKey);
}

/** Gateway model ids are provider-prefixed; bare Gemini ids get `google/`. */
export function gatewayModel(id: string): string {
  return id.includes('/') ? id : `google/${id}`;
}

export function gatewayUrl(path: string): string {
  return `${config.gateway.baseUrl.replace(/\/+$/, '')}${path}`;
}

export interface CompatTarget {
  name: string;
  url: string;
  apiKey: string;
  extraBody?: Record<string, unknown>;
}

export function gatewayTarget(): CompatTarget {
  return { name: 'gateway', url: gatewayUrl('/v1/chat/completions'), apiKey: config.gateway.apiKey };
}

export interface CompatCall {
  route: string;
  model: string;
  /** Gemini tier for the local price table when the provider reports no cost */
  tier?: Tier;
  system: string;
  prefix: string;
  suffix?: string;
  schema: Record<string, unknown>;
  thinking?: Thinking;
  maxOutputTokens?: number;
  timeoutMs?: number;
  sessionId?: bigint;
  search?: { query: string };
}

type Meta = { gateway?: { cost?: string | number } };

interface Billed {
  usage?: { cost?: number; [field: string]: unknown };
  provider_metadata?: Meta;
  providerMetadata?: Meta;
  choices?: { message?: { provider_metadata?: Meta } }[];
}

interface ChatResponse extends Billed {
  choices?: { message?: { content?: string | null; provider_metadata?: Meta } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** The cost the gateway (or OpenRouter) billed for a response, if it said. */
export function reportedCost(res: Billed): number | undefined {
  const raw =
    res.choices?.[0]?.message?.provider_metadata?.gateway?.cost ??
    res.provider_metadata?.gateway?.cost ??
    res.providerMetadata?.gateway?.cost ??
    res.usage?.cost;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

const gate = limiter(config.gemini.maxConcurrent);

// Flipped off once if the gateway refuses a search tool together with
// response_format; grounded calls then ask for JSON in the prompt instead.
let searchWithSchema = true;

function searchTool(query: string): Record<string, unknown> | undefined {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 300);
  switch (config.gateway.search) {
    case 'perplexity':
      return { type: 'vercel:perplexity_search', config: { query: q, max_results: 5, search_recency_filter: 'week' } };
    case 'exa':
      return { type: 'vercel:exa_search', config: { query: q, num_results: 5, category: 'news' } };
    case 'parallel':
      return { type: 'vercel:parallel_search', config: { objective: q, max_results: 5 } };
    case 'tako':
      return { type: 'vercel:tako_search', config: { query: q } };
    default:
      return undefined;
  }
}

export function compatBody(target: CompatTarget, call: CompatCall, strictJson: boolean): Record<string, unknown> {
  // shared prefix first, per-call text last: keeps Gemini's implicit cache warm
  let user = call.suffix ? `${call.prefix}\n\n${call.suffix}` : call.prefix;
  if (!strictJson) user += `\n\nReply with only a JSON object matching this JSON schema:\n${JSON.stringify(call.schema)}`;
  const body: Record<string, unknown> = {
    model: call.model,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: user },
    ],
    max_tokens: call.maxOutputTokens ?? 4096,
    ...target.extraBody,
  };
  if (strictJson) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: call.schema } };
  if (call.thinking) {
    body.reasoning = { effort: call.thinking === 'minimal' || call.thinking === 'low' ? 'low' : 'high' };
    if (call.model.startsWith('google/')) {
      const thinkingConfig = { thinkingLevel: call.thinking };
      body.providerOptions = { google: { thinkingConfig }, vertex: { thinkingConfig } };
    }
  }
  const tool = call.search && target.name === 'gateway' ? searchTool(call.search.query) : undefined;
  if (tool) {
    body.tools = [tool];
    body.tool_choice = 'required';
  }
  return body;
}

/** One JSON-schema chat call against an OpenAI-compatible endpoint. */
export async function compatJson<T>(target: CompatTarget, call: CompatCall): Promise<JsonResult<T>> {
  const t0 = Date.now();
  const post = async (strictJson: boolean): Promise<ChatResponse> => {
    const r = await withTimeout(
      fetch(target.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(compatBody(target, call, strictJson)),
      }),
      call.timeoutMs ?? 60_000,
      `${call.route}/${call.model}`
    );
    if (!r.ok) throw new HttpError(`${target.name} ${r.status}`, r.status, (await r.text()).slice(0, 500));
    return (await r.json()) as ChatResponse;
  };
  const res = await gate(() =>
    retry(
      async () => {
        const strict = !call.search || searchWithSchema;
        try {
          return await post(strict);
        } catch (err) {
          if (!(strict && call.search && err instanceof HttpError && err.status === 400)) throw err;
          searchWithSchema = false;
          log.warn('search tool + response_format refused; grounded calls ask for JSON in the prompt', { body: err.body.slice(0, 200) });
          return await post(false);
        }
      },
      { attempts: 3, label: call.route }
    )
  );

  const u = res.usage ?? {};
  const tokensIn = u.prompt_tokens ?? 0;
  const thoughtTokens = u.completion_tokens_details?.reasoning_tokens ?? 0;
  const tokensOut = Math.max(0, (u.completion_tokens ?? 0) - thoughtTokens);
  const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  const billed = reportedCost(res) ?? (call.tier ? costOf(call.tier, { tokensIn, tokensOut, cachedTokens, thoughtTokens }) : 0);
  const costUsd = usage.recordCost(
    { route: call.route, model: call.model, tokensIn, tokensOut, cachedTokens, thoughtTokens, costUsd: billed },
    call.sessionId
  );
  const raw = res.choices?.[0]?.message?.content ?? '';
  let data: T;
  try {
    data = extractJson(raw) as T;
  } catch (err) {
    log.warn('bad JSON from model', { route: call.route, model: call.model, err: String(err) });
    throw err;
  }
  return { data, model: call.model, tokensIn, tokensOut: tokensOut + thoughtTokens, cachedTokens, costUsd, latencyMs: Date.now() - t0 };
}

export function gatewayJson<T>(call: CompatCall): Promise<JsonResult<T>> {
  return compatJson<T>(gatewayTarget(), call);
}

/** Embeddings in input order; `dimensions` maps to Gemini's outputDimensionality. */
export async function gatewayEmbed(model: string, texts: string[], dimensions: number): Promise<number[][]> {
  const res = await gate(() =>
    retry(
      async () => {
        const r = await withTimeout(
          fetch(gatewayUrl('/v1/embeddings'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.gateway.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: texts, dimensions }),
          }),
          30_000,
          `embed/${model}`
        );
        if (!r.ok) throw new HttpError(`gateway ${r.status}`, r.status, (await r.text()).slice(0, 500));
        return (await r.json()) as Billed & { data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
      },
      { attempts: 3, label: 'embed' }
    )
  );
  const rows = [...(res.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== texts.length) throw new Error(`gateway returned ${rows.length} embeddings for ${texts.length} inputs`);
  const tokensIn = res.usage?.prompt_tokens ?? 0;
  const zero = { tokensOut: 0, cachedTokens: 0, thoughtTokens: 0 };
  usage.recordCost({ route: 'embed', model, tokensIn, ...zero, costUsd: reportedCost(res) ?? costOf('embed', { tokensIn, ...zero }) });
  return rows.map(r => r.embedding ?? []);
}
