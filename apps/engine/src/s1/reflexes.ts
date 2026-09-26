// The reflex engine: fires calibrated System-1 reflexes at any level of the
// loop, in parallel, and logs every firing (with a replayable state snapshot)
// so the slow coach can tune the reflex from experience.
import {
  DEFAULT_REFLEXES,
  evaluateReflex,
  type QType,
  type ReflexDef,
  type ReflexState,
  type ReflexVerdict,
  type S1Answer,
} from '@midas/core';
import type { Reflex } from '@midas/stdb-bindings/types';
import type { Conn } from '../stdb';
import { logger } from '../log';
import { decide } from './systemone';

const log = logger('reflex');

export interface ReflexFiring extends ReflexVerdict {
  key: string;
  answer: S1Answer;
  refId: string;
}

interface PendingSample {
  component: string;
  version: number;
  refId: string;
  prob: number;
  answer: string;
  state: string;
  outcome: number | undefined;
}

const DEFAULT_BY_KEY = new Map(DEFAULT_REFLEXES.map(r => [r.key, r]));

export function rowToDef(r: Reflex): ReflexDef {
  return {
    key: r.key,
    qtype: r.qtype as QType,
    instructions: r.instructions,
    criteriaKeys: r.criteriaKeys,
    criteriaText: r.criteriaText,
    threshold: r.threshold,
    provider: r.provider,
    version: r.version,
    enabled: r.enabled,
    positiveKey: DEFAULT_BY_KEY.get(r.key)?.positiveKey,
  };
}

function answerLabel(a: S1Answer): string {
  if (a.choice !== undefined) return a.choice;
  if (a.score !== undefined) return a.score.toFixed(2);
  if (a.noul !== undefined) return a.noul.toFixed(3);
  return '';
}

export class ReflexEngine {
  private samples: PendingSample[] = [];
  private fired = new Map<string, number>();
  private latency = new Map<string, number>();

  constructor(private conn: Conn) {}

  /** Seed any reflex the database does not know yet (never overwrites coached versions). */
  async ensureDefaults() {
    const missing = DEFAULT_REFLEXES.filter(d => !this.conn.db.reflex.key.find(d.key));
    if (missing.length === 0) return;
    await this.conn.reducers.upsertReflexes({
      reflexes: missing.map(d => ({
        key: d.key,
        qtype: d.qtype,
        instructions: d.instructions,
        criteriaKeys: d.criteriaKeys,
        criteriaText: d.criteriaText,
        threshold: d.threshold,
        provider: d.provider,
        version: d.version,
        candidateInstructions: '',
        candidateThreshold: 0,
        enabled: true,
        coachNote: 'default',
      })),
    });
    log.info('seeded reflexes', { n: missing.length });
  }

  def(key: string): ReflexDef | undefined {
    const row = this.conn.db.reflex.key.find(key);
    return row ? rowToDef(row) : DEFAULT_BY_KEY.get(key);
  }

  calibratorFor(key: string) {
    const c = this.conn.db.calibrator.component.find(`reflex:${key}`);
    return c && c.n >= 30 ? { a: c.a, b: c.b } : undefined;
  }

  /**
   * Fire several reflexes on one state in a single S1 call (the model answers
   * all questions in one parallel pass). refId ties the firing to the thing it
   * judged so the outcome can be credited later.
   */
  async fire(
    keys: string[],
    state: ReflexState & { payload?: Record<string, unknown> },
    refId: string
  ): Promise<Record<string, ReflexFiring>> {
    const defs = keys.map(k => this.def(k)).filter((d): d is ReflexDef => Boolean(d?.enabled));
    if (defs.length === 0) return {};
    const questions = Object.fromEntries(defs.map(d => [d.key.replace(/\./g, '_'), { def: d }]));
    const { answers, latencyMs } = await decide({
      state: state.payload ?? state.text,
      questions,
      features: state.features,
    });
    const out: Record<string, ReflexFiring> = {};
    const snapshot = (state.payload ? JSON.stringify(state.payload) : state.text).slice(0, 6000);
    for (const d of defs) {
      const ans = answers[d.key.replace(/\./g, '_')] ?? { confidence: 0, provider: 'none' };
      const verdict = evaluateReflex(d, ans, this.calibratorFor(d.key));
      out[d.key] = { ...verdict, key: d.key, answer: ans, refId };
      this.fired.set(d.key, (this.fired.get(d.key) ?? 0) + 1);
      const prevLat = this.latency.get(d.key);
      this.latency.set(d.key, prevLat === undefined ? latencyMs : prevLat * 0.9 + latencyMs * 0.1);
      this.samples.push({
        component: `reflex:${d.key}`,
        version: d.version,
        refId,
        prob: verdict.rawProb,
        answer: answerLabel(ans),
        state: snapshot,
        outcome: undefined,
      });
    }
    return out;
  }

  /** Fan a reflex set out over many states (for-each loops), bounded by the S1 limiter. */
  async fireMany(
    keys: string[],
    items: { state: ReflexState & { payload?: Record<string, unknown> }; refId: string }[]
  ): Promise<(Record<string, ReflexFiring> | undefined)[]> {
    return Promise.all(
      items.map(it =>
        this.fire(keys, it.state, it.refId).catch(err => {
          log.warn('reflex failed', { keys: keys.join(','), refId: it.refId, err: String(err) });
          return undefined;
        })
      )
    );
  }

  async flush() {
    if (this.samples.length > 0) {
      const batch = this.samples.splice(0, 500);
      await this.conn.reducers.addCalibrationSamples({ samples: batch });
    }
    if (this.fired.size > 0) {
      const stats = [...this.fired.entries()].map(([key, n]) => {
        const row = this.conn.db.reflex.key.find(key);
        return {
          key,
          firedDelta: n,
          nResolved: row?.nResolved ?? 0,
          brier: row?.brier ?? 0,
          hitRate: row?.hitRate ?? 0,
          avgLatencyMs: this.latency.get(key) ?? 0,
        };
      });
      this.fired.clear();
      await this.conn.reducers.recordReflexStats({ stats });
    }
  }
}
