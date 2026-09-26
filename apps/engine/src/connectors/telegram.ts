// Telegram bot: alerts go out through Alerts; commands come in here via long
// polling (no public webhook needed). Only chat ids listed in
// TELEGRAM_ALLOWED_CHATS may command the engine.
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import type { Ingest } from '../intel/ingest';
import { logger } from '../log';
import { sleep } from '../util/async';
import { pushNews, setHalt, setStatus, status } from './control';

const log = logger('telegram');

const HELP = `MIDAS commands:
/status — engine + sessions summary
/sessions — list sessions
/pause <id> · /resume <id> · /stop <id> · /kill <id>
/halt · /unhalt — global kill switch for all orders
/news <text> — inject a headline into the pipeline`;

async function api<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${config.connectors.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(json.description ?? `telegram ${method} failed`);
  return json.result;
}

async function reply(chatId: number | string, text: string) {
  await api('sendMessage', { chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }).catch(err =>
    log.warn('reply failed', { err: String(err) })
  );
}

async function handle(ctx: EngineCtx, ingest: Ingest | undefined, chatId: number, text: string) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.replace(/@.*$/, '').toLowerCase();
  const arg = rest.join(' ');
  const statuses: Record<string, string> = { '/pause': 'paused', '/resume': 'running', '/stop': 'stopped', '/kill': 'killed' };
  try {
    if (cmd === '/start' || cmd === '/help') return reply(chatId, HELP);
    if (cmd === '/status') {
      const s = status(ctx);
      return reply(
        chatId,
        `halt: ${s.haltAll ? 'ON' : 'off'} · S1: ${s.systemOne} · LLM today $${s.llmSpendTodayUsd}\nmarkets watched: ${s.watchedMarkets} · tasks ${JSON.stringify(s.tasks)}\nlive ready: ${s.liveReadiness.ready ? 'yes' : `no (${s.liveReadiness.reasons[0] ?? ''})`}\n` +
          s.sessions.map(x => `#${x.id} ${x.name} [${x.status}/${x.mode}] $${x.equityUsd} (${x.pnlPct >= 0 ? '+' : ''}${x.pnlPct}%)`).join('\n')
      );
    }
    if (cmd === '/sessions') return reply(chatId, status(ctx).sessions.map(x => `#${x.id} ${x.name} — ${x.status}`).join('\n') || 'no sessions');
    if (statuses[cmd]) {
      if (!/^\d+$/.test(arg)) return reply(chatId, `usage: ${cmd} <session id>`);
      await setStatus(ctx, arg, statuses[cmd], `via Telegram`);
      return reply(chatId, `session #${arg} → ${statuses[cmd]}`);
    }
    if (cmd === '/halt' || cmd === '/unhalt') {
      await setHalt(ctx, cmd === '/halt', 'Telegram');
      return reply(chatId, `global halt ${cmd === '/halt' ? 'ON' : 'OFF'}`);
    }
    if (cmd === '/news') {
      if (!ingest) return reply(chatId, 'this worker does not ingest news');
      const n = await pushNews(ingest, [{ title: arg, source: 'telegram' }], 'telegram');
      return reply(chatId, n > 0 ? 'queued for triage' : 'duplicate or empty — ignored');
    }
    return reply(chatId, HELP);
  } catch (err) {
    return reply(chatId, `error: ${String((err as Error)?.message ?? err)}`);
  }
}

export function startTelegram(ctx: EngineCtx, ingest: Ingest | undefined): () => void {
  if (!config.connectors.telegramToken) return () => {};
  let stopped = false;
  let offset = 0;
  const allowed = new Set(config.connectors.telegramChats.map(String));
  (async () => {
    log.info('telegram bot polling', { allowedChats: allowed.size });
    while (!stopped) {
      try {
        const updates = await api<{ update_id: number; message?: { chat: { id: number }; text?: string } }[]>('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          const chatId = u.message?.chat.id;
          const text = u.message?.text;
          if (!chatId || !text?.startsWith('/')) continue;
          if (!allowed.has(String(chatId))) {
            await reply(chatId, `not authorized (chat id ${chatId}); add it to TELEGRAM_ALLOWED_CHATS`);
            continue;
          }
          await handle(ctx, ingest, chatId, text);
        }
      } catch (err) {
        log.warn('poll failed', { err: String(err) });
        await sleep(5000);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
