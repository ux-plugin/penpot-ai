import { Outlet } from 'react-router-dom';
import { Nav } from './Nav';

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-10">
        <Outlet />
      </main>
      <footer className="border-t border-zinc-900 py-4 text-center text-xs text-zinc-600">
        zoertrope demo · everything you do here is being recorded for replay
      </footer>
    </div>
  );
}
