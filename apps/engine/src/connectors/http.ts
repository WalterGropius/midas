// Engine control API (served on Modal as the web endpoint of the engine).
//   GET  /health                         — liveness, no auth
//   GET  /api/status                     — sessions, queue, spend, readiness
//   POST /api/news      {title, summary?, url?, source?} | {items:[…]}
//   POST /api/alert     {text | message, source?}   (TradingView-style webhooks)
//   POST /api/sessions/:id/status  {status, reason?}
//   POST /api/halt      {on: boolean}
// Every /api route requires `Authorization: Bearer $MIDAS_CONTROL_TOKEN`.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import type { Ingest } from '../intel/ingest';
import { logger } from '../log';
import { jsonStringify } from '../util/async';
import { pushNews, setHalt, setStatus, status } from './control';

const log = logger('http');
const started = Date.now();

function authorized(req: http.IncomingMessage): boolean {
  const token = config.connectors.controlToken;
  if (!token) return false; // no token configured → write API disabled
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(jsonStringify(data));
}

export function startHttp(getCtx: () => EngineCtx | undefined, getIngest: () => Ingest | undefined) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx = getCtx();
    const ingest = getIngest();
    try {
      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (url.pathname === '/health' || url.pathname === '/') {
        return send(res, 200, { ok: true, service: 'midas-engine', role: config.role, worker: config.workerId, uptimeSec: Math.round((Date.now() - started) / 1000) });
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized (set MIDAS_CONTROL_TOKEN and send it as a Bearer token)' });
      if (!ctx) return send(res, 503, { error: 'engine not ready' });

      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, status(ctx));
      if (req.method === 'POST' && url.pathname === '/api/news') {
        if (!ingest) return send(res, 409, { error: 'this worker does not ingest (MIDAS_ROLE=worker)' });
        const b = await body(req);
        const n = await pushNews(ingest, Array.isArray(b.items) ? b.items : [b], 'api');
        return send(res, 202, { queued: n });
      }
      if (req.method === 'POST' && url.pathname === '/api/alert') {
        if (!ingest) return send(res, 409, { error: 'this worker does not ingest' });
        const b = await body(req);
        const text = String(b.text ?? b.message ?? '').trim();
        if (!text) return send(res, 400, { error: 'text required' });
        const n = await pushNews(ingest, [{ title: text.slice(0, 300), summary: text, source: String(b.source ?? 'alert') }], 'alert');
        return send(res, 202, { queued: n });
      }
      const m = url.pathname.match(/^\/api\/sessions\/(\d+)\/status$/);
      if (req.method === 'POST' && m) {
        const b = await body(req);
        await setStatus(ctx, m[1], String(b.status), String(b.reason ?? 'via control API'));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/halt') {
        const b = await body(req);
        await setHalt(ctx, Boolean(b.on), 'control API');
        return send(res, 200, { ok: true, haltAll: Boolean(b.on) });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log.warn('request failed', { path: url.pathname, err: String(err) });
      return send(res, 400, { error: String((err as Error)?.message ?? err) });
    }
  });
  server.listen(config.connectors.httpPort, () => log.info('control API listening', { port: config.connectors.httpPort, writes: Boolean(config.connectors.controlToken) }));
  return server;
}
