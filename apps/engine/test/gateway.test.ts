import { describe, expect, it } from 'vitest';
import { compatBody, gatewayModel, reportedCost, type CompatTarget } from '../src/llm/gateway';

const gateway: CompatTarget = { name: 'gateway', url: 'https://ai-gateway.vercel.sh/v1/chat/completions', apiKey: 'k' };
const openrouter: CompatTarget = { ...gateway, name: 'openrouter', extraBody: { usage: { include: true } } };
const schema = { type: 'object', properties: { p: { type: 'number' } }, required: ['p'] };
const base = { route: 'swarm', model: 'google/gemini-3.8-flash', system: 'SYS', prefix: 'SHARED', suffix: 'MINE', schema };

describe('AI Gateway request shaping', () => {
  it('prefixes bare Gemini ids and keeps provider ids', () => {
    expect(gatewayModel('gemini-3.8-flash')).toBe('google/gemini-3.8-flash');
    expect(gatewayModel('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });

  it('keeps the shared prefix first and asks for a JSON schema', () => {
    const b = compatBody(gateway, base, true) as { messages: { role: string; content: string }[]; response_format: unknown };
    expect(b.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(b.messages[1].content).toBe('SHARED\n\nMINE');
    expect(b.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema } });
  });

  it('sends the exact Gemini thinking level, since shared effort collapses minimal/medium to high', () => {
    for (const [thinking, effort] of [
      ['minimal', 'low'],
      ['low', 'low'],
      ['medium', 'high'],
      ['high', 'high'],
    ] as const) {
      const b = compatBody(gateway, { ...base, thinking }, true) as Record<string, any>;
      expect(b.reasoning).toEqual({ effort });
      expect(b.providerOptions.google.thinkingConfig.thinkingLevel).toBe(thinking);
      expect(b.providerOptions.vertex.thinkingConfig.thinkingLevel).toBe(thinking);
    }
    const alt = compatBody(gateway, { ...base, model: 'anthropic/claude-sonnet-5', thinking: 'low' }, true) as Record<string, any>;
    expect(alt.providerOptions).toBeUndefined();
  });

  it('adds a required server-side search tool only on the gateway', () => {
    const b = compatBody(gateway, { ...base, search: { query: '  Fed   hikes \n rates ' } }, true) as Record<string, any>;
    expect(b.tools).toEqual([{ type: 'vercel:perplexity_search', config: { query: 'Fed hikes rates', max_results: 5, search_recency_filter: 'week' } }]);
    expect(b.tool_choice).toBe('required');
    const o = compatBody(openrouter, { ...base, search: { query: 'x' } }, true) as Record<string, any>;
    expect(o.tools).toBeUndefined();
    expect(o.usage).toEqual({ include: true });
  });

  it('falls back to a prompt-level schema when strict JSON is off', () => {
    const b = compatBody(gateway, base, false) as { messages: { content: string }[]; response_format?: unknown };
    expect(b.response_format).toBeUndefined();
    expect(b.messages[1].content.startsWith('SHARED\n\nMINE\n\nReply with only a JSON object')).toBe(true);
  });

  it('reads the billed cost wherever the API reports it', () => {
    expect(reportedCost({ choices: [{ message: { provider_metadata: { gateway: { cost: '0.00012' } } } }] })).toBeCloseTo(0.00012);
    expect(reportedCost({ provider_metadata: { gateway: { cost: '0.00001155' } } })).toBeCloseTo(0.00001155);
    expect(reportedCost({ providerMetadata: { gateway: { cost: 0.5 } } })).toBe(0.5);
    expect(reportedCost({ usage: { cost: 0.02 } })).toBe(0.02);
    expect(reportedCost({})).toBeUndefined();
  });
});
