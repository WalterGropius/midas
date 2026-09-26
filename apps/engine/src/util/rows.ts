/**
 * Look up a row by a UNIQUE (non-primary-key) column in the client cache.
 *
 * SpacetimeDB 2.10's generated client types declare these indexes as ranged
 * (`filter`), but the runtime builds them as unique (`find` only). This helper
 * works with either, so the code stays correct if the SDK types are fixed.
 */
export function byUnique<R>(index: { filter(value: never): Iterable<R> }, value: unknown): R | undefined {
  const idx = index as unknown as { find?: (v: unknown) => R | null; filter?: (v: unknown) => Iterable<R> };
  if (typeof idx.find === 'function') return idx.find(value) ?? undefined;
  if (typeof idx.filter === 'function') for (const r of idx.filter(value)) return r;
  return undefined;
}
