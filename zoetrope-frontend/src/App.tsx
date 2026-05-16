import {
  ChevronDown,
  CreditCard,
  KeyRound,
  LogOut,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
  Webhook,
} from "lucide-react";
import { useAuth0 } from "@auth0/auth0-react";
import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import SettingsApiKeys, { MOCK_KEYS } from "./components/SettingsApiKeys";
import LoginPage from "./pages/LoginPage";

type SectionId = "general" | "members" | "api-keys" | "billing" | "webhooks";

const SECTIONS: Array<{
  id: SectionId;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { id: "general", label: "General", icon: Settings },
  { id: "members", label: "Members", icon: Users },
  { id: "api-keys", label: "API keys", icon: KeyRound },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
];

type ThemePref = "light" | "dark" | "system";

function useTheme(pref: ThemePref) {
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const dark = pref === "dark" || (pref === "system" && sysDark);
      root.classList.toggle("dark", dark);
      setResolved(dark ? "dark" : "light");
    };
    apply();
    if (pref === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [pref]);
  return resolved;
}

function Rail({
  activeId,
  onSelect,
  apiKeyCount,
}: {
  activeId: SectionId;
  onSelect: (id: SectionId) => void;
  apiKeyCount: number;
}) {
  return (
    <nav aria-label="Settings sections" className="w-full">
      <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-500">
        Workspace
      </div>
      <ul className="space-y-0.5">
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const active = id === activeId;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onSelect(id)}
                aria-current={active ? "page" : undefined}
                className={
                  "group flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-ring " +
                  (active
                    ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-50"
                    : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100")
                }
              >
                <Icon
                  className={
                    "h-4 w-4 " +
                    (active
                      ? "text-neutral-700 dark:text-neutral-200"
                      : "text-neutral-500 dark:text-neutral-500")
                  }
                />
                <span className="flex-1 text-left">{label}</span>
                {id === "api-keys" && (
                  <span className="rounded bg-neutral-200/70 dark:bg-neutral-700/70 px-1.5 text-[10px] font-mono text-neutral-600 dark:text-neutral-300">
                    {apiKeyCount}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function OrgSwitcher() {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-white text-xs font-semibold">
        Z
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">
          Zoetrope
        </span>
        <span className="block text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
          Pro · 12 members
        </span>
      </span>
      <ChevronDown className="h-4 w-4 text-neutral-400" />
    </button>
  );
}

function PlaceholderSection({ label }: { label: string }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          {label}
        </h1>
        <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400 max-w-2xl">
          The {label.toLowerCase()} section lives here. Switch to{" "}
          <span className="font-medium text-neutral-700 dark:text-neutral-200">API keys</span> in
          the sidebar to see the live design.
        </p>
      </header>
      <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm p-10 text-center text-sm text-neutral-400 dark:text-neutral-500">
        Stub
      </div>
    </div>
  );
}

export default function App() {
  const [themePref, setThemePref] = useState<ThemePref>(
    () => (localStorage.getItem("theme") as ThemePref | null) ?? "system",
  );
  const resolved = useTheme(themePref);

  useEffect(() => {
    localStorage.setItem("theme", themePref);
  }, [themePref]);

  const { isAuthenticated, isLoading } = useAuth0();

  if (isLoading) return <FullPageLoader />;
  if (!isAuthenticated) return <LoginPage />;
  return <AuthedShell resolved={resolved} setThemePref={setThemePref} />;
}

function FullPageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 text-neutral-500 dark:text-neutral-400">
      <div className="flex items-center gap-2 text-sm">
        <span
          className="inline-block h-3 w-3 rounded-full bg-indigo-500 animate-pulse"
          aria-hidden="true"
        />
        Loading…
      </div>
    </div>
  );
}

function AuthedShell({
  resolved,
  setThemePref,
}: {
  resolved: "light" | "dark";
  setThemePref: (p: ThemePref) => void;
}) {
  const [section, setSection] = useState<SectionId>("api-keys");
  const { logout, user } = useAuth0();

  const toggleTheme = () => {
    setThemePref(resolved === "dark" ? "light" : "dark");
  };

  const signOut = () =>
    logout({ logoutParams: { returnTo: window.location.origin } });

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 font-sans antialiased">
      <header className="h-12 border-b border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-950/70 backdrop-blur sticky top-0 z-20">
        <div className="h-full max-w-[1280px] mx-auto px-4 sm:px-6 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-white text-[11px] font-bold tracking-tight">
              Z
            </span>
            <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
              Zoetrope
            </span>
            <span className="text-neutral-300 dark:text-neutral-700">/</span>
            <span className="text-sm text-neutral-600 dark:text-neutral-300">Settings</span>
          </div>

          <div className="ml-auto hidden md:flex items-center gap-2">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                type="search"
                placeholder="Search settings…"
                className="h-8 w-64 rounded-md bg-neutral-100 dark:bg-neutral-900 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800 pl-7 pr-2 text-xs text-neutral-700 dark:text-neutral-200 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <button
              type="button"
              aria-label="Toggle theme"
              onClick={toggleTheme}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
            >
              {resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              type="button"
              aria-label="Sign out"
              onClick={signOut}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
            >
              <LogOut className="h-4 w-4" />
            </button>
            {user?.picture ? (
              <img
                src={user.picture}
                alt={user.name ?? "User avatar"}
                className="h-7 w-7 rounded-full ring-1 ring-white dark:ring-neutral-900 object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-7 w-7 rounded-full bg-gradient-to-br from-indigo-400 to-rose-400 ring-1 ring-white dark:ring-neutral-900" />
            )}
          </div>
        </div>
      </header>

      <div className="flex-1">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-10 grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8 lg:gap-12">
          <aside className="lg:sticky lg:top-16 lg:self-start">
            <div className="mb-4">
              <OrgSwitcher />
            </div>
            <Rail activeId={section} onSelect={setSection} apiKeyCount={MOCK_KEYS.length} />
          </aside>

          <main className="min-w-0">
            <div className="max-w-3xl xl:max-w-4xl">
              {section === "api-keys" ? (
                <SettingsApiKeys />
              ) : (
                <PlaceholderSection
                  label={SECTIONS.find((s) => s.id === section)?.label ?? section}
                />
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
