import { Check, ChevronDown, ExternalLink, RefreshCw, X } from "lucide-react";
import { useId, useState, type SVGProps } from "react";
import { Modal, Toaster, useToasts } from "./SettingsApiKeys";

type ProviderId = "github" | "figma";

type Provider = {
  id: ProviderId;
  name: string;
  blurb: string;
  docHref: string;
  scopes: string[];
  Logo: (props: SVGProps<SVGSVGElement>) => JSX.Element;
};

type ConnectionStatus = "connected" | "connecting" | "disconnected";

type Connection = {
  status: ConnectionStatus;
  accountLabel: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  workspaces: { id: string; name: string; count: number }[];
  syncIssues: boolean;
};

const GithubLogo = ({ className = "h-5 w-5", ...rest }: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" {...rest}>
    <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12 24 5.373 18.627 0 12 0z" />
  </svg>
);

const FigmaLogo = ({ className = "h-5 w-5", ...rest }: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true" {...rest}>
    <path d="M8 24C10.2091 24 12 22.2091 12 20V16H8C5.79086 16 4 17.7909 4 20C4 22.2091 5.79086 24 8 24Z" fill="#0ACF83" />
    <path d="M4 12C4 9.79086 5.79086 8 8 8H12V16H8C5.79086 16 4 14.2091 4 12Z" fill="#A259FF" />
    <path d="M4 4C4 1.79086 5.79086 0 8 0H12V8H8C5.79086 8 4 6.20914 4 4Z" fill="#F24E1E" />
    <path d="M12 0H16C18.2091 0 20 1.79086 20 4C20 6.20914 18.2091 8 16 8H12V0Z" fill="#FF7262" />
    <path d="M20 12C20 14.2091 18.2091 16 16 16C13.7909 16 12 14.2091 12 12C12 9.79086 13.7909 8 16 8C18.2091 8 20 9.79086 20 12Z" fill="#1ABCFE" />
  </svg>
);

const PROVIDERS: Record<ProviderId, Provider> = {
  github: {
    id: "github",
    name: "GitHub",
    blurb: "Link issues, PRs, and commits to specific session replays.",
    docHref: "#",
    scopes: ["read:user", "repo:status", "read:org"],
    Logo: GithubLogo,
  },
  figma: {
    id: "figma",
    name: "Figma",
    blurb: "Jump from a recorded session to the exact frame in your design.",
    docHref: "#",
    scopes: ["files:read", "file_comments:write"],
    Logo: FigmaLogo,
  },
};

const NOW_C = new Date("2026-05-16T15:42:00Z").getTime();

const initialConnections: Record<ProviderId, Connection> = {
  github: {
    status: "connected",
    accountLabel: "@maya-okafor",
    connectedAt: new Date(NOW_C - 86400e3 * 41).toISOString(),
    lastSyncedAt: new Date(NOW_C - 60e3 * 8).toISOString(),
    workspaces: [
      { id: "wo_1", name: "zoetrope/web", count: 142 },
      { id: "wo_2", name: "zoetrope/sdk-js", count: 38 },
      { id: "wo_3", name: "zoetrope/docs", count: 6 },
    ],
    syncIssues: false,
  },
  figma: {
    status: "disconnected",
    accountLabel: null,
    connectedAt: null,
    lastSyncedAt: null,
    workspaces: [],
    syncIssues: false,
  },
};

function relTime(iso: string | null, ref = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  const diff = ref - t;
  if (diff < 5000) return "just now";
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

function ConnStatus({ status }: { status: ConnectionStatus }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-600/20 dark:ring-emerald-400/20">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        Connected
      </span>
    );
  }
  if (status === "connecting") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 dark:bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-600/20 dark:ring-amber-400/20">
        <span className="h-3 w-3 rounded-full border-2 border-amber-500/30 border-t-amber-500 animate-spin" />
        Connecting…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 ring-1 ring-inset ring-neutral-300/60 dark:ring-neutral-700">
      <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500" />
      Not connected
    </span>
  );
}

function FeatureRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="h-3.5 w-3.5 mt-0.5 text-emerald-500 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

function ConnectedDetails({ provider, conn }: { provider: Provider; conn: Connection }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-neutral-500 dark:text-neutral-400">Account</dt>
          <dd className="text-neutral-800 dark:text-neutral-100 font-mono">{conn.accountLabel}</dd>
          <dt className="text-neutral-500 dark:text-neutral-400">Connected</dt>
          <dd className="text-neutral-700 dark:text-neutral-200">{relTime(conn.connectedAt)}</dd>
          <dt className="text-neutral-500 dark:text-neutral-400">Last sync</dt>
          <dd className="text-neutral-700 dark:text-neutral-200">{relTime(conn.lastSyncedAt)}</dd>
          <dt className="text-neutral-500 dark:text-neutral-400">Scopes</dt>
          <dd className="flex flex-wrap gap-1">
            {provider.scopes.map((s) => (
              <code
                key={s}
                className="font-mono text-[10px] text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded px-1.5 py-0.5 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700"
              >
                {s}
              </code>
            ))}
          </dd>
        </dl>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {provider.id === "github" ? "Repositories" : "Teams"}
          </h4>
          <a href="#" className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline">
            Manage
          </a>
        </div>
        <ul className="rounded-lg bg-white dark:bg-neutral-900 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-800">
          {conn.workspaces.length === 0 ? (
            <li className="px-3 py-2.5 text-xs text-neutral-400 dark:text-neutral-500">
              No {provider.id === "github" ? "repositories" : "teams"} selected yet.
            </li>
          ) : (
            conn.workspaces.map((w) => (
              <li key={w.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                <span className="font-mono text-neutral-800 dark:text-neutral-100 truncate">
                  {w.name}
                </span>
                <span className="text-neutral-500 dark:text-neutral-400 ml-3 shrink-0">
                  {w.count} linked
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

function DisconnectedDetails({ provider }: { provider: Provider }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
          What you’ll get
        </h4>
        <ul className="space-y-1.5 text-xs text-neutral-700 dark:text-neutral-300">
          {provider.id === "github" ? (
            <>
              <FeatureRow>Backlink sessions to the issues and PRs they belong to.</FeatureRow>
              <FeatureRow>Surface the deployed commit SHA on every replay.</FeatureRow>
              <FeatureRow>Open a new issue from a session with one click.</FeatureRow>
            </>
          ) : (
            <>
              <FeatureRow>Click any element in a replay to open its source frame.</FeatureRow>
              <FeatureRow>Annotate rage-clicks back to specific components.</FeatureRow>
              <FeatureRow>Sync component names with selectors for cleaner filters.</FeatureRow>
            </>
          )}
        </ul>
      </div>
      <div>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
          Scopes requested
        </h4>
        <div className="flex flex-wrap gap-1">
          {provider.scopes.map((s) => (
            <code
              key={s}
              className="font-mono text-[10px] text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded px-1.5 py-0.5 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700"
            >
              {s}
            </code>
          ))}
        </div>
        <a
          href={provider.docHref}
          className="mt-3 inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          Setup guide
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function ConnectorCard({
  provider,
  conn,
  onConnect,
  onDisconnect,
  onResync,
  defaultOpen,
}: {
  provider: Provider;
  conn: Connection;
  onConnect: () => void;
  onDisconnect: () => void;
  onResync: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const isConnected = conn.status === "connected";
  const isConnecting = conn.status === "connecting";

  return (
    <section className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm overflow-hidden">
      <div className="flex items-start gap-4 px-5 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700 shrink-0">
          <provider.Logo className="h-5 w-5 text-neutral-900 dark:text-neutral-100" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
              {provider.name}
            </h3>
            <ConnStatus status={conn.status} />
          </div>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400 max-w-prose">
            {provider.blurb}
          </p>
          {isConnected && conn.accountLabel && (
            <div className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              Linked to{" "}
              <span className="font-mono text-neutral-700 dark:text-neutral-200">
                {conn.accountLabel}
              </span>
              {conn.lastSyncedAt && <> · Synced {relTime(conn.lastSyncedAt)}</>}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isConnected ? (
            <>
              <button
                type="button"
                onClick={onResync}
                aria-label="Re-sync now"
                title="Re-sync now"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 focus-ring"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onDisconnect}
                className="inline-flex items-center justify-center h-8 rounded-md px-3 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 focus-ring ring-1 ring-inset ring-rose-200/70 dark:ring-rose-500/30"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              disabled={isConnecting}
              className="inline-flex items-center gap-1.5 h-8 rounded-md px-3 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 focus-ring disabled:opacity-50 shadow-sm"
            >
              {isConnecting ? (
                <>
                  <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                  Connecting…
                </>
              ) : (
                <>Connect</>
              )}
            </button>
          )}
          <button
            type="button"
            aria-label={open ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-200 focus-ring"
          >
            <ChevronDown
              className={"h-4 w-4 transition-transform " + (open ? "rotate-180" : "")}
            />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-950/40 px-5 py-4">
          {isConnected ? (
            <ConnectedDetails provider={provider} conn={conn} />
          ) : (
            <DisconnectedDetails provider={provider} />
          )}
        </div>
      )}
    </section>
  );
}

function OAuthAuthorizeModal({
  open,
  provider,
  onCancel,
  onAuthorize,
}: {
  open: boolean;
  provider: Provider | null;
  onCancel: () => void;
  onAuthorize: () => void;
}) {
  const titleId = useId();
  if (!provider) return null;
  return (
    <Modal open={open} onClose={onCancel} labelledBy={titleId} width="max-w-[440px]">
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="px-6 pt-6 pb-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700">
            <provider.Logo className="h-5 w-5 text-neutral-900 dark:text-neutral-100" />
          </div>
          <div className="text-neutral-400 dark:text-neutral-600">→</div>
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 font-semibold text-sm">
            Z
          </div>
        </div>

        <h2
          id={titleId}
          className="mt-4 text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
        >
          Authorize Zoetrope to access {provider.name}?
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          You’ll be redirected to {provider.name} to sign in. After approving, the connection
          appears here.
        </p>

        <div className="mt-4 rounded-lg bg-neutral-50 dark:bg-neutral-950 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800 px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1.5">
            Zoetrope will be able to
          </div>
          <ul className="space-y-1 text-xs text-neutral-700 dark:text-neutral-200">
            {provider.scopes.map((s) => (
              <li key={s} className="flex items-center gap-2">
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                <code className="font-mono">{s}</code>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 -mx-6 px-6 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            data-autofocus="true"
            onClick={onAuthorize}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 focus-ring shadow-sm"
          >
            Authorize on {provider.name}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DisconnectModal({
  open,
  provider,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  provider: Provider | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  if (!provider) return null;
  return (
    <Modal open={open} onClose={onCancel} labelledBy={titleId} width="max-w-[420px]">
      <div className="px-6 pt-6 pb-5">
        <h2
          id={titleId}
          className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
        >
          Disconnect {provider.name}?
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Existing backlinks to {provider.name} resources will stop resolving. You can reconnect at
          any time — selected resources will need to be re-picked.
        </p>
        <div className="mt-6 flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 -mx-6 px-6 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            data-autofocus="true"
            onClick={onConfirm}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-white bg-rose-600 hover:bg-rose-500 focus-ring shadow-sm"
          >
            Disconnect
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ComingSoonStrip() {
  const items = [
    { name: "Linear", initial: "L", tint: "bg-violet-500" },
    { name: "Slack", initial: "S", tint: "bg-rose-500" },
    { name: "Sentry", initial: "Se", tint: "bg-amber-500" },
    { name: "Jira", initial: "J", tint: "bg-sky-500" },
  ];
  return (
    <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
          Coming soon
        </h3>
        <a href="#" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
          Request a connector
        </a>
      </div>
      <ul className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {items.map((it) => (
          <li
            key={it.name}
            className="flex items-center gap-2.5 rounded-lg ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800 px-3 py-2"
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-md text-white text-[11px] font-bold ${it.tint}`}
            >
              {it.initial}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-neutral-900 dark:text-neutral-100 truncate">
                {it.name}
              </div>
              <div className="text-[10px] text-neutral-500 dark:text-neutral-400">Coming soon</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SettingsConnectors() {
  const [connections, setConnections] = useState<Record<ProviderId, Connection>>(initialConnections);
  const [authTarget, setAuthTarget] = useState<ProviderId | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ProviderId | null>(null);
  const { toasts, push } = useToasts();

  const beginConnect = (providerId: ProviderId) => setAuthTarget(providerId);

  const completeAuthorize = () => {
    const id = authTarget;
    if (!id) return;
    setAuthTarget(null);
    setConnections((c) => ({
      ...c,
      [id]: { ...c[id], status: "connecting" },
    }));
    setTimeout(() => {
      setConnections((c) => ({
        ...c,
        [id]: {
          ...c[id],
          status: "connected",
          accountLabel: id === "github" ? "@maya-okafor" : "maya@zoetrope.dev",
          connectedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          workspaces:
            id === "github"
              ? [
                  { id: "wo_1", name: "zoetrope/web", count: 0 },
                  { id: "wo_2", name: "zoetrope/sdk-js", count: 0 },
                ]
              : [
                  { id: "t_1", name: "Zoetrope · Design System", count: 0 },
                  { id: "t_2", name: "Zoetrope · Marketing", count: 0 },
                ],
        },
      }));
      push(`Connected ${PROVIDERS[id].name}`);
    }, 900);
  };

  const confirmDisconnect = () => {
    const id = disconnectTarget;
    if (!id) return;
    setDisconnectTarget(null);
    setConnections((c) => ({
      ...c,
      [id]: {
        status: "disconnected",
        accountLabel: null,
        connectedAt: null,
        lastSyncedAt: null,
        workspaces: [],
        syncIssues: false,
      },
    }));
    push(`Disconnected ${PROVIDERS[id].name}`);
  };

  const resync = (id: ProviderId) => {
    setConnections((c) => ({
      ...c,
      [id]: { ...c[id], lastSyncedAt: new Date().toISOString() },
    }));
    push(`Re-synced ${PROVIDERS[id].name}`);
  };

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Connectors
          </h1>
          <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400 max-w-2xl">
            Link your developer and design tools so Zoetrope can connect session replays back to
            the code, designs, and issues behind them.
          </p>
        </div>
        <a
          href="#"
          className="inline-flex items-center gap-1.5 h-9 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
        >
          Browse all connectors
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </header>

      <div className="space-y-4">
        {(["github", "figma"] as ProviderId[]).map((id, i) => (
          <ConnectorCard
            key={id}
            provider={PROVIDERS[id]}
            conn={connections[id]}
            defaultOpen={i === 0}
            onConnect={() => beginConnect(id)}
            onDisconnect={() => setDisconnectTarget(id)}
            onResync={() => resync(id)}
          />
        ))}
      </div>

      <ComingSoonStrip />

      <OAuthAuthorizeModal
        open={!!authTarget}
        provider={authTarget ? PROVIDERS[authTarget] : null}
        onCancel={() => setAuthTarget(null)}
        onAuthorize={completeAuthorize}
      />
      <DisconnectModal
        open={!!disconnectTarget}
        provider={disconnectTarget ? PROVIDERS[disconnectTarget] : null}
        onCancel={() => setDisconnectTarget(null)}
        onConfirm={confirmDisconnect}
      />
      <Toaster toasts={toasts} />
    </div>
  );
}
