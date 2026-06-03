import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // No real auth — this is a demo. The point is that you typed PII into form
    // fields and it got sent through the recorder pipeline. The anonymizer drops
    // every Input event before it ever reaches the replay.
    navigate('/catalog');
  }

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-3xl font-semibold mb-2">Sign in</h1>
      <p className="text-sm text-zinc-500 mb-8">
        This form does nothing. Type whatever — for example{' '}
        <code className="font-mono text-accent">alice@example.com</code> /{' '}
        <code className="font-mono text-accent">Hunter2!</code> — then check the
        replay. Both fields will be missing because the backend anonymizer dropped
        the rrweb Input events on the way through.
      </p>
      <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
        <label className="block">
          <span className="block text-sm text-zinc-400 mb-1.5">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alice@example.com"
            className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 focus:border-accent focus:outline-none"
            autoComplete="email"
          />
        </label>
        <label className="block">
          <span className="block text-sm text-zinc-400 mb-1.5">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 focus:border-accent focus:outline-none"
            autoComplete="current-password"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-md bg-accent text-zinc-950 font-medium py-2 hover:bg-accent-dim hover:text-zinc-100 transition-colors"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
