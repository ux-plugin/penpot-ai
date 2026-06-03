// Tiny localStorage-backed cart so navigation is meaningful for the recording.
// Not concurrent-safe, doesn't matter for a single-tab demo.
const KEY = 'demo-cart';

export interface CartLine {
  productId: string;
  name: string;
  priceCents: number;
  qty: number;
}

export function getCart(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as CartLine[];
  } catch {
    return [];
  }
}

export function saveCart(lines: CartLine[]): void {
  localStorage.setItem(KEY, JSON.stringify(lines));
  window.dispatchEvent(new CustomEvent('cart:change'));
}

export function addToCart(p: { id: string; name: string; priceCents: number }): void {
  const cart = getCart();
  const existing = cart.find((l) => l.productId === p.id);
  if (existing) existing.qty += 1;
  else cart.push({ productId: p.id, name: p.name, priceCents: p.priceCents, qty: 1 });
  saveCart(cart);
}

export function removeFromCart(productId: string): void {
  saveCart(getCart().filter((l) => l.productId !== productId));
}

export function clearCart(): void {
  saveCart([]);
}
