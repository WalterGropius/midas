// A second model family for the swarm. Same-model forecasters make
// correlated errors (ρ≈0.7 — ten Gemini agents behave like ~1.4 forecasters),
// so mixing in another family is the cheapest way to add independent signal.
// Runs through Vercel AI Gateway when AI_GATEWAY_API_KEY is set, else
// OpenRouter; both speak the OpenAI-compatible chat API with a JSON schema.
import { config } from '../config';
import { compatJson, gatewayAvailable, gatewayTarget, type CompatTarget } from './gateway';
import type { JsonResult } from './gemini';

export function altModels(): string[] {
  return config.gemini.altModels.filter(Boolean);
}

export function altAvailable(): boolean {
  return (gatewayAvailable() || Boolean(config.s1.openRouterKey)) && altModels().length > 0;
}

function target(): CompatTarget {
  if (gatewayAvailable()) return gatewayTarget();
  return {
    name: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: config.s1.openRouterKey,
    extraBody: { usage: { include: true } },
  };
}

export function generateJsonAlt<T>(call: {
  route: string;
  model: string;
  system: string;
  prefix: string;
  suffix?: string;
  schema: Record<string, unknown>;
  sessionId?: bigint;
}): Promise<JsonResult<T>> {
  return compatJson<T>(target(), { ...call, timeoutMs: 60_000 });
}
