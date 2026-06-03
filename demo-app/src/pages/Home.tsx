import { Link } from 'react-router-dom';

export function Home() {
  return (
    <div className="space-y-12">
      <section>
        <p className="text-xs uppercase tracking-widest text-accent-dim mb-4">a working pipeline demo</p>
        <h1 className="text-5xl font-semibold tracking-tight mb-6">
          Click around. <span className="text-accent">We're recording.</span>
        </h1>
        <p className="text-zinc-400 text-lg max-w-2xl leading-relaxed">
          Every interaction in this fake shop streams through the zoertrope pipeline:
          rrweb captures DOM mutations, the api ingests gzipped chunks, the sanitizer
          classifies the session, the anonymizer scrubs PII, and the processor derives
          metadata. Open the <Link to="/_/sessions">sessions panel</Link> in another tab
          and watch the worker chain do its job.
        </p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          to="/login"
          className="group block rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 hover:border-accent/40 transition-colors"
        >
          <div className="text-2xl mb-2">🔐</div>
          <h2 className="text-lg font-medium text-zinc-100 mb-1 group-hover:text-accent">Sign in</h2>
          <p className="text-sm text-zinc-500">
            Type a fake email + password. They'll be visible in your browser, not in the replay.
          </p>
        </Link>
        <Link
          to="/catalog"
          className="group block rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 hover:border-accent/40 transition-colors"
        >
          <div className="text-2xl mb-2">🛒</div>
          <h2 className="text-lg font-medium text-zinc-100 mb-1 group-hover:text-accent">Browse the catalog</h2>
          <p className="text-sm text-zinc-500">
            Six products. Add a few to the cart. Each click is a recorded event.
          </p>
        </Link>
      </section>
    </div>
  );
}
