import { useAuth0 } from "@auth0/auth0-react";
import { AlertTriangle, ArrowRight, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { isAuth0Configured } from "../auth/config";

export default function LoginPage() {
  const { loginWithRedirect, isLoading, error } = useAuth0();
  const configured = isAuth0Configured();

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 font-sans antialiased">
      <header className="h-12 border-b border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-950/70 backdrop-blur">
        <div className="h-full max-w-[1280px] mx-auto px-4 sm:px-6 flex items-center gap-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-white text-[11px] font-bold tracking-tight">
            Z
          </span>
          <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
            Zoetrope
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-[420px]">
          <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm px-7 py-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 ring-1 ring-inset ring-indigo-600/10 dark:ring-indigo-400/20">
              <ShieldCheck className="h-5 w-5" />
            </div>

            <h1 className="mt-5 text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Sign in to Zoetrope
            </h1>
            <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">
              Use your organization account to access session recordings, API keys, and team
              settings.
            </p>

            {!configured ? (
              <div className="mt-6 flex gap-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 p-3 ring-1 ring-inset ring-amber-600/20 dark:ring-amber-400/20">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">
                  Auth0 isn't configured yet. Copy{" "}
                  <code className="font-mono">.env.example</code> to{" "}
                  <code className="font-mono">.env</code> and set{" "}
                  <code className="font-mono">VITE_AUTH0_CLIENT_ID</code> to a Single Page
                  Application client registered in your Auth0 tenant.
                </div>
              </div>
            ) : (
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() =>
                    loginWithRedirect({
                      appState: { returnTo: window.location.pathname + window.location.search },
                    })
                  }
                  disabled={isLoading}
                  aria-busy={isLoading}
                  className="inline-flex w-full items-center justify-center gap-2 h-10 rounded-lg px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 disabled:opacity-60 disabled:pointer-events-none focus-ring shadow-sm transition-colors"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading…
                    </>
                  ) : (
                    <>
                      Continue with Auth0
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            )}

            {error && (
              <div className="mt-4 flex gap-2.5 rounded-lg bg-rose-50 dark:bg-rose-500/10 p-3 ring-1 ring-inset ring-rose-600/20 dark:ring-rose-400/20">
                <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
                <p className="text-xs leading-relaxed text-rose-900 dark:text-rose-100">
                  {error.message}
                </p>
              </div>
            )}

            <div className="mt-7 pt-5 border-t border-neutral-200 dark:border-neutral-800">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                By signing in you agree to the{" "}
                <a
                  href="#"
                  className="text-indigo-600 dark:text-indigo-400 hover:underline focus-ring rounded"
                >
                  terms of service
                </a>{" "}
                and{" "}
                <a
                  href="#"
                  className="text-indigo-600 dark:text-indigo-400 hover:underline focus-ring rounded"
                >
                  privacy policy
                </a>
                .
              </p>
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-neutral-500 dark:text-neutral-500">
            Don't have an account?{" "}
            <a
              href="#"
              className="font-medium text-neutral-700 dark:text-neutral-300 hover:underline"
            >
              Contact your workspace admin
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
