import { useEffect, useState } from 'react';
import { addToCart, getCart } from '../lib/cart';
import { fmtPrice, PRODUCTS } from '../lib/products';

export function Catalog() {
  const [cartCount, setCartCount] = useState(() => getCart().reduce((n, l) => n + l.qty, 0));

  useEffect(() => {
    const refresh = () => setCartCount(getCart().reduce((n, l) => n + l.qty, 0));
    window.addEventListener('cart:change', refresh);
    return () => window.removeEventListener('cart:change', refresh);
  }, []);

  return (
    <div>
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="text-3xl font-semibold mb-1">Catalog</h1>
          <p className="text-sm text-zinc-500">Six items. Add a few to the cart.</p>
        </div>
        <span className="text-sm text-zinc-400">
          🛒 <span className="text-accent font-mono">{cartCount}</span> in cart
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {PRODUCTS.map((p) => (
          <div
            key={p.id}
            className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 flex flex-col"
          >
            <div className="text-4xl mb-3">{p.emoji}</div>
            <h3 className="text-zinc-100 font-medium">{p.name}</h3>
            <p className="text-sm text-zinc-500 mb-4 flex-1">{p.blurb}</p>
            <div className="flex items-center justify-between">
              <span className="font-mono text-accent">{fmtPrice(p.priceCents)}</span>
              <button
                onClick={() => addToCart(p)}
                className="rounded-md bg-zinc-800 hover:bg-accent hover:text-zinc-950 text-zinc-200 px-3 py-1.5 text-sm transition-colors"
              >
                Add to cart
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
