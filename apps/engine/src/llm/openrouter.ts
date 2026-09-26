// A second model family for the swarm. Same-model forecasters make
// correlated errors (ρ≈0.7 — ten Gemini agents behave like ~1.4 forecasters),
// so mixing in another family is the cheapest way to add independent signal.
// Uses OpenRouter's OpenAI-compatible chat API with a JSON-schema response.
import { config } from '../config';
import { limiter, retry, withTimeout, HttpError } from '../util/async';
import { usage } from './usage';
import type { JsonResult } from './gemini';

const gate = limiter(8);

export function altModels(): string[] {
  return config.gemini.altModels.filter(Boolean);
}

export function altAvailable(): boolean {
  return Boolean(config.s1.openRouterKey) && altModels().length > 0;
}

export async function generateJsonAlt<T>(call: {
  route: string;
  model: string;
  system: string;
  prefix: string;
  suffix?: string;
  schema: Record<string, unknown>;
  sessionId?: bigint;
}): Promise<JsonResult<T>> {
  const t0 = Date.now();
  const res = await gate(() =>
    retry(
      async () => {
        const r = await withTimeout(
          fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.s1.openRouterKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: call.model,
              messages: [
                { role: 'system', content: call.system },
                { role: 'user', content: call.suffix ? `${call.prefix}\n\n${call.suffix}` : call.prefix },
              ],
              response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: false, schema: call.schema } },
              usage: { include: true },
            }),
          }),
          60_000,
          `${call.route}/${call.model}`
        );
        if (!r.ok) throw new HttpError(`openrouter ${r.status}`, r.status, (await r.text()).slice(0, 300));
        return (await r.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
      },
      { attempts: 3, label: call.route }
    )
  );
  const text = res.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`alt model returned no JSON: ${text.slice(0, 160)}`);
  const tokensIn = res.usage?.prompt_tokens ?? 0;
  const tokensOut = res.usage?.completion_tokens ?? 0;
  const cachedTokens = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const costUsd = usage.recordCost({ route: call.route, model: call.model, tokensIn, tokensOut, cachedTokens, costUsd: res.usage?.cost ?? 0 }, call.sessionId);
  return { data: JSON.parse(m[0]) as T, model: call.model, tokensIn, tokensOut, cachedTokens, costUsd, latencyMs: Date.now() - t0 };
}
