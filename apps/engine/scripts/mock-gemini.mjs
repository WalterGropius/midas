// Keyless end-to-end test: a tiny mock of the Gemini REST API and of the
// Vercel AI Gateway endpoints MIDAS uses (/v1/chat/completions,
// /v1/embeddings, /typesafe/v1/systemone). It returns schema-shaped JSON chosen
// by the system instruction. Its forecasters always read a Fed hike into the
// "25 bps increase" / "no change" markets, so any headline can drive the full
// path: triage → reflexes → swarm → Pro → decide → paper fill.
//
//   node apps/engine/scripts/mock-gemini.mjs            # :8799
//   # direct Gemini:
//   GEMINI_API_KEY=mock MIDAS_GEMINI_BASE_URL=http://127.0.0.1:8799 npm run engine
//   # or everything through the gateway:
//   AI_GATEWAY_API_KEY=mock MIDAS_GATEWAY_URL=http://127.0.0.1:8799 npm run engine
//   curl -X POST -H "Authorization: Bearer $MIDAS_CONTROL_TOKEN" -H 'Content-Type: application/json' \
//        localhost:8080/api/news -d '{"title":"…","summary":"…"}'
//   curl localhost:8799/__requests                       # what the engine sent
//
// Paper only — never point a live session at it.
import http from 'node:http';

let calls = 0;
const requests = [];

function reply(system, userText) {
  if (system.startsWith('You are the triage desk')) {
    const ids = [...userText.matchAll(/id=(0x[0-9a-f]+)/g)].map(m => m[1]);
    return { items: [{ index: 0, eventType: 'central_bank', entities: [{ name: 'Federal Reserve', kind: 'org' }, { name: 'Jerome Powell', kind: 'person' }], sentiment: -0.3, novelty: 0.9, summary: 'Fed signals an October hike.', links: ids.map(id => ({ marketId: id, relevance: 0.9, direction: 1 })) }] };
  }
  const mkt = ((userText.match(/MARKET: (.*)/) || [])[1] || '').toLowerCase();
  if (system.startsWith('You are one forecaster')) {
    const isHikeMarket = /increase interest rates by 25/.test(mkt);
    const isNoChange = /no change in fed interest rates/.test(mkt);
    const style = (userText.match(/STYLE — ([^:]+)/) || [])[1] || '';
    const jitter = (style.length % 5) * 0.01;
    if (isHikeMarket) return { probYes: 0.9 + jitter / 2, shift: 0.9 + jitter, shiftLow: 0.5, shiftHigh: 1.3, halfLifeMin: 4, confidence: 0.8, rationale: `${style}: emergency hike announcement strongly raises P(25bp hike).` };
    if (isNoChange) return { probYes: 0.08, shift: -1.0 - jitter, shiftLow: -1.4, shiftHigh: -0.6, halfLifeMin: 4, confidence: 0.8, rationale: `${style}: a hike means rates change.` };
    return { probYes: 0.2, shift: 0, shiftLow: -0.1, shiftHigh: 0.1, halfLifeMin: 30, confidence: 0.4, rationale: `${style}: unrelated.` };
  }
  if (system.startsWith('You are the adversarial reviewer')) return { flaws: ['Check whether the hike was already expected.'], probAdjustment: -0.02, severity: 0.2 };
  if (system.startsWith('You are the senior forecaster')) {
    const isHikeMarket = /increase interest rates by 25/.test(mkt);
    if (!isHikeMarket && !/no change in fed interest rates/.test(mkt)) return { probYes: 0.2, shift: 0, shiftLow: -0.1, shiftHigh: 0.1, halfLifeMin: 30, confidence: 0.3, rationale: 'Unrelated.', tradeable: false, citations: [] };
    return isHikeMarket
      ? { probYes: 0.9, shift: 1.0, shiftLow: 0.6, shiftHigh: 1.4, halfLifeMin: 3, confidence: 0.8, rationale: 'Official emergency decision [m1]; market should reprice hike odds sharply.', tradeable: true, citations: ['m1'] }
      : { probYes: 0.08, shift: -1.1, shiftLow: -1.5, shiftHigh: -0.7, halfLifeMin: 3, confidence: 0.8, rationale: 'A hike resolves no-change NO.', tradeable: true, citations: [] };
  }
  if (system.startsWith('You write post-mortems')) return { lesson: { pattern: 'Emergency Fed actions', rule: 'Expect near-immediate repricing', appliesTo: ['Federal Reserve'] }, errorKind: 'magnitude' };
  if (system.startsWith('You maintain one page')) return { content: '# Market page\n\nCompiled by mock.\n', changeSummary: 'mock compile' };
  if (system.startsWith('You improve the STYLE')) return { instructions: 'Be sharper.', persona: 'Sharper', rationale: 'mock' };
  if (system.startsWith('You coach a fast reflex')) return { instructions: 'Is it relevant?', criteriaText: [], rationale: 'mock' };
  if (system.startsWith('You are a fast decision function')) {
    const qs = JSON.parse((userText.match(/QUESTIONS\n(.*)/) || [])[1] || '[]');
    const state = userText.split('STATE\n')[1] || '';
    return {
      answers: qs.map(x => {
        const a = s1Answer(x.id, state);
        return { key: x.id, noul: a.noul, score: a.score, probs: a.probs && Object.entries(a.probs).map(([option, p]) => ({ option, p })), confidence: a.confidence };
      }),
    };
  }
  return {};
}

/** One System-1 answer: relevance/direction follow the market in the state. */
function s1Answer(id, stateText) {
  const q = ((stateText.match(/"market_question":"([^"]*)"/) || [])[1] || '').toLowerCase();
  const dir = /increase interest rates by 25/.test(q) ? 'up' : /no change/.test(q) ? 'down' : 'none';
  switch (id) {
    case 'news_relevance': return { noul: /interest rates/.test(q) ? 0.92 : 0.04, confidence: 0.9 };
    case 'news_direction': return { probs: { up: dir === 'up' ? 0.85 : 0.05, down: dir === 'down' ? 0.85 : 0.05, none: dir === 'none' ? 0.9 : 0.1 }, confidence: 0.85 };
    case 'news_urgency': return { score: 2.4, confidence: 0.7 };
    case 'news_novelty': return { noul: 0.9, confidence: 0.8 };
    case 'claim_grounded': return { noul: 0.85, confidence: 0.8 };
    case 'route_escalate': return { noul: 0.8, confidence: 0.7 };
    case 'position_exit': return { noul: 0.1, confidence: 0.7 };
    default: return { noul: /fed|interest rates/i.test(stateText) ? 0.6 : 0.2, confidence: 0.5 };
  }
}

const vec = n => Array.from({ length: n }, (_, i) => Math.sin(i + calls));

function send(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const url = req.url || '';
    if (url === '/__requests') return send(res, { calls, requests });
    calls++;
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch {}
    const authed = /^Bearer \S+/.test(req.headers.authorization || '') || Boolean(req.headers['x-goog-api-key']);

    // ── AI Gateway: TypeSafe-compatible System One (Jev)
    if (url.endsWith('/typesafe/v1/systemone')) {
      const state = typeof json.state === 'string' ? json.state : JSON.stringify(json.state ?? '');
      const answers = {};
      for (const [id, q] of Object.entries(json.questions ?? {})) {
        const a = s1Answer(id, state);
        if (q.type === 'noul') answers[id] = { type: 'noul', noul: a.noul ?? 0.5 };
        else if (q.type === 'choice') {
          const probs = a.probs ?? { [Object.keys(q.criteria ?? { none: '' })[0]]: 1 };
          answers[id] = { type: 'choice', choice: Object.entries(probs).sort((x, y) => y[1] - x[1])[0][0], probabilities: probs };
        } else answers[id] = { type: 'score', score: a.score ?? 1, probabilities: {} };
      }
      requests.push({ path: 'systemone', model: json.model, authed, questions: Object.keys(json.questions ?? {}).length });
      return send(res, { model: json.model, answers, usage: { input_tokens: 275, output_tokens: 0 }, provider_metadata: { gateway: { cost: '0.00001155' } } });
    }

    // ── AI Gateway: embeddings
    if (url.endsWith('/v1/embeddings')) {
      const input = Array.isArray(json.input) ? json.input : [json.input];
      requests.push({ path: 'embeddings', model: json.model, authed, n: input.length, dimensions: json.dimensions });
      return send(res, {
        object: 'list',
        data: input.map((_, index) => ({ object: 'embedding', index, embedding: vec(json.dimensions ?? 768) })),
        usage: { prompt_tokens: 12 * input.length, total_tokens: 12 * input.length },
        providerMetadata: { gateway: { cost: '0.0000024' } },
      });
    }

    // ── AI Gateway: OpenAI-compatible chat completions
    if (url.endsWith('/v1/chat/completions')) {
      const msgs = json.messages ?? [];
      const system = msgs.find(m => m.role === 'system')?.content ?? '';
      const userText = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
      requests.push({
        path: 'chat',
        model: json.model,
        authed,
        route: system.slice(0, 28),
        jsonSchema: json.response_format?.type === 'json_schema',
        effort: json.reasoning?.effort,
        thinkingLevel: json.providerOptions?.google?.thinkingConfig?.thinkingLevel,
        tools: (json.tools ?? []).map(t => t.type),
        toolChoice: json.tool_choice,
      });
      return send(res, {
        id: `chatcmpl-${calls}`,
        object: 'chat.completion',
        model: json.model,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply(system, userText)), provider_metadata: { gateway: { cost: '0.00031' } } }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 4200,
          completion_tokens: 150,
          total_tokens: 4350,
          prompt_tokens_details: { cached_tokens: calls > 1 ? 3800 : 0 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      });
    }

    // ── Gemini REST (direct)
    if (url.includes(':embedContent') || url.includes(':batchEmbedContents')) {
      const n = json.requests?.length || (Array.isArray(json.content) ? json.content.length : 1) || 1;
      const out = json.requests ? { embeddings: json.requests.map(() => ({ values: vec(768) })) } : { embedding: { values: vec(768) }, embeddings: [{ values: vec(768) }] };
      requests.push({ path: 'gemini-embed', authed, n });
      return send(res, out);
    }
    const system = json.systemInstruction?.parts?.map(p => p.text).join('') || json.system_instruction?.parts?.map(p => p.text).join('') || '';
    const userText = (json.contents || []).flatMap(c => c.parts || []).map(p => p.text || '').join('\n');
    requests.push({ path: 'gemini', authed, route: system.slice(0, 28) });
    send(res, {
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(reply(system, userText)) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4200, candidatesTokenCount: 120, cachedContentTokenCount: calls > 1 ? 3800 : 0, totalTokenCount: 4320 },
      modelVersion: 'mock',
    });
  });
});
const port = Number(process.env.PORT ?? 8799);
server.listen(port, '127.0.0.1', () => console.log(`mock gemini + gateway on :${port}`));
