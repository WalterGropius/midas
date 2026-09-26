import { kalshi } from './kalshi';
import { manifold } from './manifold';
import { polymarket } from './polymarket';
import type { Venue } from './types';

export const VENUES: Venue[] = [polymarket, manifold, kalshi];

export function venueFor(conditionId: string): Venue {
  return VENUES.find(v => v.owns(conditionId)) ?? polymarket;
}

export * from './types';
export { polymarket, manifold, kalshi };
