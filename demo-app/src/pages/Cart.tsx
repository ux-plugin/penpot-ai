import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CartLine, clearCart, getCart, removeFromCart } from '../lib/cart';
import { fmtPrice } from '../lib/products';

export function Cart() {
  const [lines, setLines] = useState<CartLine[]>(getCart());
  const navigate = useNavigate();

  useEffect(() => {
    const refresh = () => setLines(getCart());
    window.addEventListener('cart:change', refresh);
    return () => window.removeEventListener('cart:change', refresh);
  }, []);

  const total = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);

  function checkout() {
    clearCart();
    navigate('/');
  }

  if (lines.length === 0) {
    return (
      <div className="text-center py-20">
        <div className="text-6xl mb-4">🛒</div>
        <h1 className="text-2xl font-semibold mb-2">Your cart is empty</h1>
        <p className="text-zinc-500">Visit the catalog and add a few things.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold mb-8">Cart</h1>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800">
        {lines.map((l) => (
          <div key={l.productId} className="px-5 py-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-zinc-100">{l.name}</div>
              <div className="text-sm text-zinc-500">
                {fmtPrice(l.priceCents)} × <span className="font-mono">{l.qty}</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="font-mono text-accent">{fmtPrice(l.priceCents * l.qty)}</span>
              <button
                onClick={() => removeFromCart(l.productId)}
                className="text-xs text-zinc-500 hover:text-zinc-200"
              >
                remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-zinc-400">Total</span>
        <span className="text-2xl font-semibold font-mono text-accent">{fmtPrice(total)}</span>
      </div>
      <button
        onClick={checkout}
        className="mt-6 w-full rounded-md bg-accent text-zinc-950 font-medium py-3 hover:bg-accent-dim hover:text-zinc-100 transition-colors"
      >
        Check out
      </button>
    </div>
  );
}
