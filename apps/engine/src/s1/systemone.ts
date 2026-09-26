// "System One" decision-model clients.
//
// Jev (TypeSafe), Jev via OpenRouter, and self-hosted Laya (`laya-serve` or the
// MIDAS intel sidecar on Modal) all speak one wire protocol:
//   POST {base}/v1/systemone  { state, model, questions } → { model, answers, usage }
// A Gemini Flash emulation and a heuristic sit underneath as fallbacks, so the
// reflex layer always answers — just less sharply without a real S1 model.
import {
  heuristicAnswer,
  type ReflexDef,
  type ReflexState,
  type S1Answer,
} from '@midas/core';
import { config } from '../config';
import { generateJson, geminiAvailable } from '../llm/gemini';
import { S1_EMULATION_SCHEMA, S1_EMULATION_SYSTEM, type S1EmulationOut } from '../llm/prompts';
import { logger } from '../log';
import { HttpError, limiter, withTimeout } from '../util/async';

const log = logger('s1');

type WireQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

type WireAnswer =
  | { type: 'noul'; noul: number; confidence?: number; answer_confidence?: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number>; answer_confidence?: number }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number>; answer_confidence?: number };

interface WireResponse {
  model: string;
  answers: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function toWireQuestion(def: ReflexDef, instructions = def.instructions, criteriaText = def.criteriaText): WireQuestion {
  if (def.qtype === 'noul') return { type: 'noul', instructions };
  if (def.qtype === 'choice') {
    const criteria: Record<string, string | null> = {};
    def.criteriaKeys.forEach((k, i) => (criteria[k] = criteriaText[i] ?? null));
    return { type: 'choice', instructions, criteria };
  }
  return { type: 'score', instructions, criteria: criteriaText };
}

function fromWire(a: WireAnswer | undefined, provider: string): S1Answer {
  if (!a) return { confidence: 0, provider };
  if (a.type === 'noul') {
    const p = Number(a.noul);
    return { noul: p, confidence: a.answer_confidence ?? a.confidence ?? Math.max(p, 1 - p), provider };
  }
  if (a.type === 'choice') {
    return { choice: a.choice, probs: a.probabilities, confidence: a.answer_confidence ?? a.confidence ?? 0.5, provider };
  }
  return { score: Number(a.score), probs: a.probabilities, confidence: a.answer_confidence ?? a.confidence ?? 0.5, provider };
}

export interface S1Request {
  state: string | Record<string, unknown>;
  /** question id → reflex definition (possibly a coach candidate variant) */
  questions: Record<string, { def: ReflexDef; instructions?: string; criteriaText?: string[] }>;
  /** features for the heuristic fallback */
  features?: ReflexState['features'];
}

export interface S1Provider {
  name: string;
  available(): boolean;
  decide(req: S1Request): Promise<Record<string, S1Answer>>;
}

function systemOneProvider(name: string, baseUrl: () => string, apiKey: () => string, model: () => string): S1Provider {
  const gate = limiter(config.s1.maxConcurrent);
  return {
    name,
    available: () => Boolean(baseUrl() && apiKey()),
    async decide(req) {
      const questions: Record<string, WireQuestion> = {};
      for (const [id, q] of Object.entries(req.questions)) questions[id] = toWireQuestion(q.def, q.instructions, q.criteriaText);
      const url = `${baseUrl().replace(/\/+$/, '')}/v1/systemone`;
      const body = JSON.stringify({ state: req.state, model: model(), questions });
      const res = await gate(() =>
        withTimeout(
          fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
            body,
          }),
          config.s1.timeoutMs,
          name
        )
      );
      if (!res.ok) throw new HttpError(`${name} ${res.status}`, res.status, (await res.text()).slice(0, 300));
      const json = (await res.json()) as WireResponse;
      const out: Record<string, S1Answer> = {};
      for (const id of Object.keys(questions)) out[id] = fromWire(json.answers?.[id], name);
      return out;
    },
  };
}

const jev = systemOneProvider('jev', () => config.s1.jevBaseUrl, () => config.s1.jevApiKey, () => config.s1.jevModel);
const jevOpenRouter = systemOneProvider(
  'jev-openrouter',
  () => 'https://openrouter.ai/api',
  () => config.s1.openRouterKey,
  () => config.s1.openRouterJevModel
);
const laya = systemOneProvider('laya', () => config.s1.layaBaseUrl, () => config.s1.layaApiKey || 'none', () => 'auto');

const flash: S1Provider = {
  name: 'flash',
  available: geminiAvailable,
  async decide(req) {
    const qs = Object.entries(req.questions).map(([id, q]) => ({ id, ...toWireQuestion(q.def, q.instructions, q.criteriaText) }));
    const state = typeof req.state === 'string' ? req.state : JSON.stringify(req.state);
    const r = await generateJson<S1EmulationOut>({
      route: 's1-emulation',
      tier: 'flashLite',
      system: S1_EMULATION_SYSTEM,
      prefix: `QUESTIONS\n${JSON.stringify(qs)}`,
      suffix: `STATE\n${state.slice(0, 12_000)}`,
      schema: S1_EMULATION_SCHEMA,
      thinking: 'minimal',
      maxOutputTokens: 1024,
    });
    const out: Record<string, S1Answer> = {};
    for (const a of r.data.answers ?? []) {
      const probs = a.probs ? Object.fromEntries(a.probs.map(x => [x.option, x.p])) : undefined;
      const choice = probs ? Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0] : undefined;
      out[a.key] = { noul: a.noul, probs, choice, score: a.score, confidence: a.confidence, provider: 'flash' };
    }
    return out;
  },
};

const heuristic: S1Provider = {
  name: 'heuristic',
  available: () => true,
  async decide(req) {
    const text = typeof req.state === 'string' ? req.state : JSON.stringify(req.state);
    const out: Record<string, S1Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) out[id] = heuristicAnswer(q.def, { text, features: req.features });
    return out;
  },
};

const ALL: Record<string, S1Provider> = { jev, 'jev-openrouter': jevOpenRouter, laya, flash, heuristic };

// A provider that errors is benched for a minute so latency-critical loops
// fall through to the next one instead of waiting on timeouts.
const benchedUntil = new Map<string, number>();

export function providerChain(preferred = config.s1.provider): S1Provider[] {
  const order =
    preferred === 'auto' || !ALL[preferred]
      ? ['jev', 'jev-openrouter', 'laya', 'flash', 'heuristic']
      : [preferred, ...['jev', 'jev-openrouter', 'laya', 'flash', 'heuristic'].filter(p => p !== preferred)];
  return order.map(n => ALL[n]).filter(p => p.available());
}

export async function decide(req: S1Request, preferred?: string): Promise<{ answers: Record<string, S1Answer>; latencyMs: number }> {
  const t0 = Date.now();
  let lastErr: unknown;
  for (const p of providerChain(preferred)) {
    if ((benchedUntil.get(p.name) ?? 0) > Date.now()) continue;
    try {
      const answers = await p.decide(req);
      const latencyMs = Date.now() - t0;
      for (const a of Object.values(answers)) a.latencyMs = latencyMs;
      return { answers, latencyMs };
    } catch (err) {
      lastErr = err;
      benchedUntil.set(p.name, Date.now() + 60_000);
      log.warn('provider failed; falling back', { provider: p.name, err: String(err) });
    }
  }
  throw lastErr ?? new Error('no System-1 provider available');
}

export function activeProviderName(): string {
  return providerChain().find(p => (benchedUntil.get(p.name) ?? 0) <= Date.now())?.name ?? 'none';
}
