// Hardcoded fake catalog. Six items so the grid wraps and there's enough to click.
export interface Product {
  id: string;
  name: string;
  blurb: string;
  priceCents: number;
  emoji: string;
}

export const PRODUCTS: Product[] = [
  { id: 'film-01', name: '8mm reel canister', blurb: 'Genuine archival aluminum', priceCents: 2400, emoji: '🎞️' },
  { id: 'lens-01', name: 'Brass loupe', blurb: 'Vintage darkroom optic', priceCents: 8900, emoji: '🔍' },
  { id: 'paper-01', name: 'Silver gelatin paper', blurb: '25 sheets, 8x10 fiber-base', priceCents: 4200, emoji: '📄' },
  { id: 'tank-01', name: 'Stainless dev tank', blurb: 'Two-reel, leak-tight lid', priceCents: 5600, emoji: '🧪' },
  { id: 'shutter-01', name: 'Mechanical cable release', blurb: 'No batteries, no firmware', priceCents: 1900, emoji: '📸' },
  { id: 'flash-01', name: 'Magicube flash', blurb: 'Pack of three, single-use', priceCents: 1200, emoji: '⚡' },
];

export function fmtPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
