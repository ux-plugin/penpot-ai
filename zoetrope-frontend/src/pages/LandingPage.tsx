import { useAuth0 } from "@auth0/auth0-react";
import {
  ArrowRight,
  Eye,
  KeyRound,
  Loader2,
  Lock,
  PlayCircle,
  Rewind,
  Zap,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { isAuth0Configured } from "../auth/config";

export default function LandingPage() {
  const { loginWithRedirect, isLoading } = useAuth0();
  const configured = isAuth0Configured();

  const signIn = () =>
    loginWithRedirect({
      appState: { returnTo: window.location.pathname + window.location.search },
    });

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 font-sans antialiased">
      {/* Top bar */}
      <header className="h-14 border-b border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-950/70 backdrop-blur sticky top-0 z-20">
        <div className="h-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-white text-xs font-bold tracking-tight">
              Z
            </span>
            <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
              Zoetrope
            </span>
          </div>

          <nav className="hidden md:flex items-center gap-6 ml-8 text-sm text-neutral-600 dark:text-neutral-400">
            <a href="#features" className="hover:text-neutral-900 dark:hover:text-neutral-100 focus-ring rounded">
              Features
            </a>
            <a href="#how" className="hover:text-neutral-900 dark:hover:text-neutral-100 focus-ring rounded">
              How it works
            </a>
            <a href="#" className="hover:text-neutral-900 dark:hover:text-neutral-100 focus-ring rounded">
              Docs
            </a>
            <a href="#" className="hover:text-neutral-900 dark:hover:text-neutral-100 focus-ring rounded">
              Pricing
            </a>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={configured ? signIn : undefined}
              disabled={!configured || isLoading}
              className="hidden sm:inline-flex items-center justify-center h-8 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:pointer-events-none focus-ring transition-colors"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={configured ? signIn : undefined}
              disabled={!configured || isLoading}
              className="inline-flex items-center gap-1.5 h-8 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 disabled:opacity-60 disabled:pointer-events-none focus-ring shadow-sm transition-colors"
            >
              {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Get started
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-24 lg:pt-28 lg:pb-32">
          <div className="max-w-3xl">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 dark:bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300 ring-1 ring-inset ring-indigo-600/20 dark:ring-indigo-400/20">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              Session recording for product teams
            </span>

            <h1 className="mt-6 text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 leading-[1.05]">
              Watch how real users
              <br />
              <span className="text-neutral-400 dark:text-neutral-500">use your product.</span>
            </h1>

            <p className="mt-6 max-w-xl text-base sm:text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed">
              Zoetrope captures rrweb sessions from your app, anonymises sensitive data on
              ingest, and stitches the chunks into searchable replays — so engineers can debug
              real bugs instead of guessing from a stack trace.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={configured ? signIn : undefined}
                disabled={!configured || isLoading}
                className="inline-flex items-center gap-1.5 h-10 rounded-lg px-4 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 disabled:opacity-60 disabled:pointer-events-none focus-ring shadow-sm transition-colors"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Get started
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
              <a
                href="#how"
                className="inline-flex items-center gap-1.5 h-10 rounded-lg px-4 text-sm font-medium text-neutral-700 dark:text-neutral-200 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring transition-colors"
              >
                <PlayCircle className="h-4 w-4" />
                See how it works
              </a>
            </div>

            {!configured && (
              <p className="mt-6 text-xs text-amber-700 dark:text-amber-400">
                Auth0 isn't configured yet — set <code className="font-mono">VITE_AUTH0_CLIENT_ID</code> in <code className="font-mono">.env</code> to enable sign-in.
              </p>
            )}
          </div>

          {/* Mock product preview */}
          <ProductPreview />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950/40">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-20">
          <div className="max-w-2xl">
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Everything you need to ship with confidence.
            </h2>
            <p className="mt-3 text-sm sm:text-base text-neutral-600 dark:text-neutral-400">
              From the moment a session lands in our ingest pipeline to the moment you scrub
              through the replay, Zoetrope is built like the infra you'd build yourself.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-neutral-200 dark:bg-neutral-800 rounded-xl overflow-hidden ring-1 ring-neutral-200 dark:ring-neutral-800">
            <FeatureCard
              icon={Eye}
              title="Pixel-perfect replays"
              body="rrweb-based capture means you see exactly what the user saw — DOM, scroll, hover, the works."
            />
            <FeatureCard
              icon={Lock}
              title="Anonymised on ingest"
              body="PII is stripped server-side before chunks ever hit storage. No client trust required."
            />
            <FeatureCard
              icon={Zap}
              title="Streaming pipeline"
              body="Kafka Streams + Spring Cloud Stream — chunks flow through sanitise → anonymise → process in real time."
            />
            <FeatureCard
              icon={Rewind}
              title="Time-travel debugging"
              body="Jump to the exact moment of an error. Console + network events sync to the replay timeline."
            />
            <FeatureCard
              icon={KeyRound}
              title="API keys, not tokens"
              body="Rotate, revoke, audit — the SDK just needs a bearer key. Granular by environment."
            />
            <FeatureCard
              icon={PlayCircle}
              title="Built for engineers"
              body="No drag-and-drop dashboard editor. Clean CLI, OpenAPI, and a UI that gets out of your way."
            />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-neutral-200 dark:border-neutral-800">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-20">
          <div className="max-w-2xl">
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Three steps to your first replay.
            </h2>
          </div>

          <ol className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
            <Step
              n={1}
              title="Install the SDK"
              body="Drop the Zoetrope SDK into your app. It boots a rrweb recorder and pipes chunks to the ingest endpoint."
              code={`pnpm add @zoetrope/sdk`}
            />
            <Step
              n={2}
              title="Create an API key"
              body="In settings, mint a key per environment. Treat it like a password — Zoetrope only stores a hash."
              code={`pk_live_demo…`}
            />
            <Step
              n={3}
              title="Replay & debug"
              body="Open a session in the dashboard. Scrub the timeline, filter by user, share a permalink with your team."
              code={`zoetrope.replay(sessionId)`}
            />
          </ol>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-100/60 dark:bg-neutral-900/40">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Start recording sessions today.
          </h2>
          <p className="mt-3 text-sm sm:text-base text-neutral-600 dark:text-neutral-400 max-w-xl mx-auto">
            Sign in with your org account to create an API key and ship your first replay in
            under five minutes.
          </p>
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={configured ? signIn : undefined}
              disabled={!configured || isLoading}
              className="inline-flex items-center gap-1.5 h-10 rounded-lg px-4 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 disabled:opacity-60 disabled:pointer-events-none focus-ring shadow-sm transition-colors"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Continue with Auth0
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-200 dark:border-neutral-800">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-neutral-900 text-white text-[9px] font-bold">
              Z
            </span>
            <span>© {new Date().getFullYear()} Zoetrope. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-5 text-xs text-neutral-500 dark:text-neutral-400">
            <a href="#" className="hover:text-neutral-700 dark:hover:text-neutral-200">Terms</a>
            <a href="#" className="hover:text-neutral-700 dark:hover:text-neutral-200">Privacy</a>
            <a href="#" className="hover:text-neutral-700 dark:hover:text-neutral-200">Status</a>
            <a href="#" className="hover:text-neutral-700 dark:hover:text-neutral-200">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  body,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-white dark:bg-neutral-900 p-6">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 ring-1 ring-inset ring-indigo-600/10 dark:ring-indigo-400/20">
        <Icon className="h-4 w-4" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
        {title}
      </h3>
      <p className="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
        {body}
      </p>
    </div>
  );
}

function Step({ n, title, body, code }: { n: number; title: string; body: string; code: string }) {
  return (
    <li className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs font-semibold">
          {n}
        </span>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</h3>
      </div>
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">{body}</p>
      <code className="mt-4 block rounded-md bg-neutral-100 dark:bg-neutral-800 px-2.5 py-1.5 text-xs font-mono text-neutral-700 dark:text-neutral-300 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700 overflow-x-auto">
        {code}
      </code>
    </li>
  );
}

function ProductPreview() {
  return (
    <div className="mt-14 lg:mt-20 relative">
      <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-xl overflow-hidden">
        {/* Fake browser chrome */}
        <div className="h-9 flex items-center gap-1.5 px-4 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <span className="ml-3 text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate">
            zoetrope.com/sessions/0ca28b55-20be-480c-9fc8-812284afd093
          </span>
        </div>
        {/* Mock dashboard body */}
        <div className="grid grid-cols-[180px_1fr] min-h-[300px]">
          <div className="border-r border-neutral-200 dark:border-neutral-800 p-3 space-y-1 bg-neutral-50/40 dark:bg-neutral-900/40">
            {["Sessions", "Replays", "API keys", "Members", "Settings"].map((s, i) => (
              <div
                key={s}
                className={
                  "h-7 rounded-md px-2 flex items-center text-xs " +
                  (i === 1
                    ? "bg-neutral-200 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 font-medium"
                    : "text-neutral-500 dark:text-neutral-400")
                }
              >
                {s}
              </div>
            ))}
          </div>
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-mono text-neutral-500 dark:text-neutral-400">
                  session · 02:14
                </div>
                <div className="mt-0.5 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                  checkout — error on submit
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-600/20 dark:ring-emerald-400/20">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Recording
              </span>
            </div>
            <div className="mt-4 aspect-[16/8] rounded-lg bg-gradient-to-br from-neutral-100 to-neutral-200 dark:from-neutral-800 dark:to-neutral-900 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700 flex items-center justify-center">
              <PlayCircle className="h-10 w-10 text-neutral-400 dark:text-neutral-600" />
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
              <div className="h-full w-1/3 bg-indigo-500" />
            </div>
          </div>
        </div>
      </div>
      {/* Glow */}
      <div
        aria-hidden="true"
        className="absolute inset-x-12 -bottom-6 h-24 bg-indigo-500/20 blur-3xl rounded-full -z-10"
      />
    </div>
  );
}
