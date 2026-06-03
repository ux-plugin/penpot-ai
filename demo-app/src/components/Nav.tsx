import { NavLink } from 'react-router-dom';
import { getSessionId } from '../lib/session-id';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 rounded-md text-sm transition-colors ${
    isActive ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'
  }`;

export function Nav() {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <NavLink to="/" className="text-zinc-50 font-semibold tracking-tight">
            <span className="text-accent">●</span> zoertrope shop
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={linkClass}>
              Home
            </NavLink>
            <NavLink to="/login" className={linkClass}>
              Login
            </NavLink>
            <NavLink to="/catalog" className={linkClass}>
              Catalog
            </NavLink>
            <NavLink to="/cart" className={linkClass}>
              Cart
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <NavLink to="/_/sessions" className={linkClass}>
            ◉ sessions
          </NavLink>
          <span className="font-mono text-xs text-zinc-500" title="Current recording session id">
            {getSessionId().slice(0, 8)}
          </span>
        </div>
      </div>
    </header>
  );
}
