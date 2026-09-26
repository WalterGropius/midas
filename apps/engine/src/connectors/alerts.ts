// Outbound alerts: Telegram, Discord, Slack and generic JSON webhooks.
import { config } from '../config';
import { logger } from '../log';

const log = logger('alerts');

export type AlertKind = 'trade' | 'risk' | 'lesson' | 'evolution' | 'error' | 'info';

async function post(url: string, body: unknown) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) log.warn('alert delivery failed', { host: new URL(url).host, status: res.status });
  } finally {
    clearTimeout(timer);
  }
}

export class Alerts {
  private sentAt: number[] = [];

  async send(kind: AlertKind, text: string) {
    const c = config.connectors;
    if (!c.alertKinds.includes(kind) && kind !== 'error') return;
    const now = Date.now();
    this.sentAt = this.sentAt.filter(t => now - t < 60_000);
    if (this.sentAt.length >= 20) return; // flood guard
    this.sentAt.push(now);
    const line = `[MIDAS ${kind}] ${text}`.slice(0, 3500);
    const jobs: Promise<unknown>[] = [];
    if (c.telegramToken) {
      for (const chat of c.telegramChats) {
        jobs.push(post(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, { chat_id: chat, text: line, disable_web_page_preview: true }));
      }
    }
    if (c.discordWebhook) jobs.push(post(c.discordWebhook, { content: line }));
    if (c.slackWebhook) jobs.push(post(c.slackWebhook, { text: line }));
    for (const url of c.webhooks) jobs.push(post(url, { source: 'midas', kind, text, ts: new Date(now).toISOString() }));
    await Promise.allSettled(jobs).catch(() => undefined);
  }
}
