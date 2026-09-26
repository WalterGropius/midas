// Keyless end-to-end test: a tiny mock of the Gemini REST API that returns
// schema-shaped JSON chosen by the system instruction. Its forecasters always
// read a Fed hike into the "25 bps increase" / "no change" markets, so any
// headline can drive the full path: triage → reflexes → swarm → Pro → decide →
// paper fill.
//
//   node apps/engine/scripts/mock-gemini.mjs            # :8799
//   GEMINI_API_KEY=mock MIDAS_GEMINI_BASE_URL=http://127.0.0.1:8799 npm run engine
//   curl -X POST -H "Authorization: Bearer $MIDAS_CONTROL_TOKEN" -H 'Content-Type: application/json' \
//        localhost:8080/api/news -d '{"title":"…","summary":"…"}'
//
// Paper only — never point a live session at it.
import http from 'node:http';

let calls = 0;
const log = [];

function reply(system, userText) {
  const u = userText.toLowerCase();
  const hike = /hike|raise/.test(u);
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
    const fed = /fed|interest rates/.test(u.split('state')[1] || '');
    const q = ((userText.match(/"market_question":"([^"]*)"/) || [])[1] || '').toLowerCase();
    const dir = /increase interest rates by 25/.test(q) ? 'up' : /no change/.test(q) ? 'down' : 'none';
    const rel = /interest rates/.test(q);
    return {
      answers: qs.map(x => {
        switch (x.id) {
          case 'news_relevance': return { key: x.id, noul: rel ? 0.92 : 0.04, confidence: 0.9 };
          case 'news_direction': return { key: x.id, probs: [{ option: 'up', p: dir === 'up' ? 0.85 : 0.05 }, { option: 'down', p: dir === 'down' ? 0.85 : 0.05 }, { option: 'none', p: dir === 'none' ? 0.9 : 0.1 }], confidence: 0.85 };
          case 'news_urgency': return { key: x.id, score: 2.4, confidence: 0.7 };
          case 'news_novelty': return { key: x.id, noul: 0.9, confidence: 0.8 };
          case 'claim_grounded': return { key: x.id, noul: 0.85, confidence: 0.8 };
          case 'route_escalate': return { key: x.id, noul: 0.8, confidence: 0.7 };
          case 'position_exit': return { key: x.id, noul: 0.1, confidence: 0.7 };
          default: return { key: x.id, noul: fed ? 0.6 : 0.2, confidence: 0.5 };
        }
      }),
    };
  }
  return {};
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    calls++;
    const url = req.url || '';
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch {}
    if (url.includes(':embedContent') || url.includes(':batchEmbedContents')) {
      const n = (json.requests?.length) || (Array.isArray(json.content) ? json.content.length : 1) || 1;
      const vec = () => Array.from({ length: 768 }, (_, i) => Math.sin(i + calls));
      const out = json.requests ? { embeddings: json.requests.map(() => ({ values: vec() })) } : { embedding: { values: vec() }, embeddings: [{ values: vec() }] };
      log.push({ url, kind: 'embed', n });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    const system = json.systemInstruction?.parts?.map(p => p.text).join('') || json.system_instruction?.parts?.map(p => p.text).join('') || '';
    const userText = (json.contents || []).flatMap(c => c.parts || []).map(p => p.text || '').join('\n');
    const data = reply(system, userText);
    log.push({ url, kind: system.slice(0, 30) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(data) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4200, candidatesTokenCount: 120, cachedContentTokenCount: calls > 1 ? 3800 : 0, totalTokenCount: 4320 },
        modelVersion: 'mock',
      })
    );
  });
});
const port = Number(process.env.PORT ?? 8799);
server.listen(port, '127.0.0.1', () => console.log(`mock gemini on :${port}`));
setInterval(() => console.log(JSON.stringify({ calls, recent: log.slice(-5) })), 60_000).unref();
