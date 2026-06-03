import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useAuth0 } from "@auth0/auth0-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useApi, type ApiKeyRecord } from "../lib/api";

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: { id: string; name: string };
};

const NOW = new Date("2026-05-14T15:42:00Z").getTime();

export const MOCK_KEYS: ApiKey[] = [
  {
    id: "key_01",
    name: "Production ingest",
    prefix: "pk_live_demo",
    createdAt: new Date(NOW - 86400e3 * 92).toISOString(),
    lastUsedAt: new Date(NOW - 1000 * 47).toISOString(),
    revokedAt: null,
    createdBy: { id: "u_1", name: "Maya Okafor" },
  },
  {
    id: "key_02",
    name: "Staging ingest",
    prefix: "pk_test_5x9w",
    createdAt: new Date(NOW - 86400e3 * 30).toISOString(),
    lastUsedAt: new Date(NOW - 1000 * 60 * 12).toISOString(),
    revokedAt: null,
    createdBy: { id: "u_2", name: "Daniel Reyes" },
  },
  {
    id: "key_03",
    name: "CI replay worker",
    prefix: "pk_live_ci82",
    createdAt: new Date(NOW - 86400e3 * 14).toISOString(),
    lastUsedAt: new Date(NOW - 86400e3 * 3).toISOString(),
    revokedAt: null,
    createdBy: { id: "u_2", name: "Daniel Reyes" },
  },
  {
    id: "key_04",
    name: "Mobile SDK — iOS",
    prefix: "pk_live_ios0",
    createdAt: new Date(NOW - 86400e3 * 7).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    createdBy: { id: "u_3", name: "Priya Shah" },
  },
  {
    id: "key_05",
    name: "Old laptop demo",
    prefix: "pk_test_4kab",
    createdAt: new Date(NOW - 86400e3 * 180).toISOString(),
    lastUsedAt: new Date(NOW - 86400e3 * 41).toISOString(),
    revokedAt: new Date(NOW - 86400e3 * 38).toISOString(),
    createdBy: { id: "u_1", name: "Maya Okafor" },
  },
  {
    id: "key_06",
    name: "rotated-2025-q4",
    prefix: "pk_live_q4rt",
    createdAt: new Date(NOW - 86400e3 * 260).toISOString(),
    lastUsedAt: new Date(NOW - 86400e3 * 95).toISOString(),
    revokedAt: new Date(NOW - 86400e3 * 92).toISOString(),
    createdBy: { id: "u_4", name: "Jordan Lin" },
  },
];

function relativeTime(iso: string | null, ref = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  const diff = ref - t;
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.round(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-600/20 dark:ring-emerald-400/20">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 ring-1 ring-inset ring-neutral-300/60 dark:ring-neutral-700">
      <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500" />
      Revoked
    </span>
  );
}

type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  destructive?: boolean;
  children: ReactNode;
};

const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { children, destructive, disabled, className, ...rest },
  ref,
) {
  const base = "flex w-full items-center gap-2 px-3 py-1.5 text-sm focus-ring";
  const tone = destructive
    ? "text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10"
    : "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800";
  const dis = disabled ? "opacity-40 pointer-events-none" : "";
  return (
    <button
      ref={ref}
      role="menuitem"
      type="button"
      className={`${base} ${tone} ${dis} ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
});

function ActionsMenu({
  apiKey,
  onCopyPrefix,
  onRename,
  onRevoke,
}: {
  apiKey: ApiKey;
  onCopyPrefix: () => void;
  onRename: () => void;
  onRevoke: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current || !btnRef.current) return;
      if (!menuRef.current.contains(target) && !btnRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => {
      const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
      first?.focus();
    });
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isActive = apiKey.revokedAt === null;

  const handle = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="relative inline-block text-left">
      <button
        ref={btnRef}
        type="button"
        aria-label={`Actions for ${apiKey.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 focus-ring"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${apiKey.name}`}
          className="absolute right-0 z-30 mt-1 w-44 origin-top-right rounded-lg bg-white dark:bg-neutral-900 py-1 shadow-lg ring-1 ring-neutral-200 dark:ring-neutral-800 focus:outline-none dlg-anim"
        >
          <MenuItem onClick={handle(onCopyPrefix)}>
            <Copy className="h-4 w-4" />
            Copy prefix
          </MenuItem>
          <MenuItem onClick={handle(onRename)} disabled={!isActive}>
            <Pencil className="h-4 w-4" />
            Rename…
          </MenuItem>
          {isActive && (
            <>
              <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
              <MenuItem onClick={handle(onRevoke)} destructive>
                <Trash2 className="h-4 w-4" />
                Revoke
              </MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({
  value,
  label = "Copy",
  className = "",
  variant = "primary",
}: {
  value: string;
  label?: string;
  className?: string;
  variant?: "primary" | "secondary";
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const palette =
    variant === "primary"
      ? "bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      : "bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800";

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-medium transition-colors focus-ring ${palette} ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  labelledBy,
  describedBy,
  children,
  width = "max-w-[480px]",
}: {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  describedBy?: string;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    lastFocusRef.current = document.activeElement;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const root = panelRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);

    requestAnimationFrame(() => {
      const root = panelRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(
        '[data-autofocus="true"], a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    });

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      const last = lastFocusRef.current;
      if (last instanceof HTMLElement) last.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-anim"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      <div
        className="absolute inset-0 bg-neutral-950/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`relative ${width} w-full rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-xl dlg-anim`}
      >
        {children}
      </div>
    </div>
  );
}

function CreateKeyDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<{ plaintext: string }>;
}) {
  const [stage, setStage] = useState<"form" | "reveal">("form");
  const [name, setName] = useState("");
  const [plaintext, setPlaintext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (open) {
      setStage("form");
      setName("");
      setPlaintext("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 64;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onCreate(trimmed);
      setPlaintext(result.plaintext);
      setStage("reveal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setBusy(false);
    }
  };

  const done = () => {
    onClose();
    setTimeout(() => {
      setName("");
      setPlaintext("");
      setStage("form");
    }, 200);
  };

  return (
    <Modal
      open={open}
      onClose={stage === "form" ? onClose : done}
      labelledBy={titleId}
      describedBy={descId}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={stage === "form" ? onClose : done}
        className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
      >
        <X className="h-4 w-4" />
      </button>

      {stage === "form" ? (
        <form onSubmit={submit} className="px-6 pt-6 pb-5">
          <h2
            id={titleId}
            className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
          >
            Create API key
          </h2>
          <p id={descId} className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Name your key so you can identify it later. The key itself is only shown once.
          </p>

          <div className="mt-5">
            <label
              htmlFor="key-name"
              className="block text-xs font-medium text-neutral-700 dark:text-neutral-300"
            >
              Name
            </label>
            <input
              id="key-name"
              data-autofocus="true"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 64))}
              placeholder="Production ingest"
              maxLength={64}
              disabled={busy}
              className="mt-1.5 block w-full rounded-lg bg-white dark:bg-neutral-950 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              Use something descriptive — e.g. the service or environment. {trimmed.length}/64
            </p>
          </div>

          {error && (
            <div className="mt-3 flex gap-2 rounded-md bg-rose-50 dark:bg-rose-500/10 p-2.5 ring-1 ring-inset ring-rose-600/20 dark:ring-rose-400/20 text-xs text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}

          <div className="mt-6 flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 -mx-6 px-6 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || busy}
              className="inline-flex items-center justify-center gap-1.5 h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 disabled:opacity-50 disabled:pointer-events-none focus-ring shadow-sm"
            >
              {busy && (
                <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              )}
              {busy ? "Creating…" : "Create key"}
            </button>
          </div>
        </form>
      ) : (
        <div className="px-6 pt-6 pb-5">
          <h2
            id={titleId}
            className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
          >
            Save your API key
          </h2>
          <p id={descId} className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Key “{trimmed || "Untitled"}” was created.
          </p>

          <div className="mt-4 flex gap-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 p-3 ring-1 ring-inset ring-amber-600/20 dark:ring-amber-400/20">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">
              This is the only time you’ll see this key. Copy it now and store it somewhere safe —
              Zoetrope only stores a hash.
            </p>
          </div>

          <div className="mt-4">
            <label
              htmlFor="reveal-key"
              className="block text-xs font-medium text-neutral-700 dark:text-neutral-300"
            >
              API key
            </label>
            <div className="mt-1.5 flex items-stretch gap-2">
              <input
                id="reveal-key"
                type="text"
                readOnly
                value={plaintext}
                onFocus={(e) => e.currentTarget.select()}
                className="block w-full rounded-lg bg-neutral-50 dark:bg-neutral-950 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 px-3 py-2 text-xs font-mono text-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <CopyButton value={plaintext} variant="secondary" />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 -mx-6 px-6 pt-4">
            <button
              type="button"
              data-autofocus="true"
              onClick={done}
              className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 focus-ring shadow-sm"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RevokeDialog({
  open,
  apiKey,
  onClose,
  onConfirm,
}: {
  open: boolean;
  apiKey: ApiKey | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={descId}
      width="max-w-[420px]"
    >
      <div className="px-6 pt-6 pb-5">
        <h2
          id={titleId}
          className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
        >
          Revoke this API key?
        </h2>
        <p id={descId} className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Any service still using this key will immediately get a 401. This cannot be undone.
        </p>
        {apiKey && (
          <div className="mt-4 rounded-lg bg-neutral-50 dark:bg-neutral-950 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800 px-3 py-2.5">
            <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {apiKey.name}
            </div>
            <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 font-mono">
              {apiKey.prefix}…
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 -mx-6 px-6 pt-4">
          <button
            type="button"
            onClick={onClose}
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
            Revoke key
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RenameDialog({
  open,
  apiKey,
  onClose,
  onSubmit,
}: {
  open: boolean;
  apiKey: ApiKey | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const titleId = useId();
  useEffect(() => {
    if (open && apiKey) setName(apiKey.name);
  }, [open, apiKey]);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 64;

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} width="max-w-[420px]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(trimmed);
        }}
        className="px-6 pt-6 pb-5"
      >
        <h2
          id={titleId}
          className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
        >
          Rename API key
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Display name only — the key value itself doesn’t change.
        </p>
        <div className="mt-4">
          <label
            htmlFor="rename-input"
            className="block text-xs font-medium text-neutral-700 dark:text-neutral-300"
          >
            Name
          </label>
          <input
            id="rename-input"
            data-autofocus="true"
            type="text"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value.slice(0, 64))}
            className="mt-1.5 block w-full rounded-lg bg-white dark:bg-neutral-950 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div className="mt-6 flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 -mx-6 px-6 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 disabled:opacity-50 focus-ring shadow-sm"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm">
      <div className="flex flex-col items-center text-center px-6 py-16">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
          <KeyRound className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
          No API keys yet
        </h3>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 max-w-sm">
          Create your first key to start sending session data.
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="mt-5 inline-flex items-center gap-1.5 h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 focus-ring shadow-sm"
        >
          <Plus className="h-4 w-4" />
          Create API key
        </button>
      </div>
    </div>
  );
}

function KeyRow({
  apiKey,
  onCopyPrefix,
  onRename,
  onRevoke,
}: {
  apiKey: ApiKey;
  onCopyPrefix: () => void;
  onRename: () => void;
  onRevoke: () => void;
}) {
  const active = apiKey.revokedAt === null;
  const dim = active ? "" : "opacity-60";
  return (
    <tr className="group border-b border-neutral-200 dark:border-neutral-800 last:border-b-0 hover:bg-neutral-50/60 dark:hover:bg-neutral-800/40 transition-colors">
      <td className={`py-4 pl-6 pr-3 align-top ${dim}`}>
        <div className="font-medium text-sm text-neutral-900 dark:text-neutral-50 truncate max-w-[240px]">
          {apiKey.name}
        </div>
        <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 truncate max-w-[240px]">
          Created by {apiKey.createdBy.name} · {relativeTime(apiKey.createdAt, NOW)}
        </div>
      </td>
      <td className={`px-3 py-4 align-top ${dim}`}>
        <code className="font-mono text-xs text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded px-1.5 py-0.5 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700">
          {apiKey.prefix}…
        </code>
      </td>
      <td className={`px-3 py-4 align-top text-sm text-neutral-600 dark:text-neutral-300 ${dim}`}>
        {shortDate(apiKey.createdAt)}
      </td>
      <td className={`px-3 py-4 align-top text-sm ${dim}`}>
        {apiKey.lastUsedAt ? (
          <span className="text-neutral-700 dark:text-neutral-200">
            {relativeTime(apiKey.lastUsedAt, NOW)}
          </span>
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">Never</span>
        )}
      </td>
      <td className={`px-3 py-4 align-top ${dim}`}>
        <StatusPill active={active} />
      </td>
      <td className="pl-3 pr-4 py-4 align-top text-right">
        <ActionsMenu
          apiKey={apiKey}
          onCopyPrefix={onCopyPrefix}
          onRename={onRename}
          onRevoke={onRevoke}
        />
      </td>
    </tr>
  );
}

function KeyCard({
  apiKey,
  onCopyPrefix,
  onRename,
  onRevoke,
}: {
  apiKey: ApiKey;
  onCopyPrefix: () => void;
  onRename: () => void;
  onRevoke: () => void;
}) {
  const active = apiKey.revokedAt === null;
  return (
    <div
      className={`p-4 border-b border-neutral-200 dark:border-neutral-800 last:border-b-0 ${
        active ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-sm text-neutral-900 dark:text-neutral-50 truncate">
            {apiKey.name}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            Created by {apiKey.createdBy.name} · {relativeTime(apiKey.createdAt, NOW)}
          </div>
        </div>
        <ActionsMenu
          apiKey={apiKey}
          onCopyPrefix={onCopyPrefix}
          onRename={onRename}
          onRevoke={onRevoke}
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="font-mono text-xs text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded px-1.5 py-0.5 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700">
          {apiKey.prefix}…
        </code>
        <StatusPill active={active} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-neutral-500 dark:text-neutral-400">Created</dt>
        <dd className="text-neutral-700 dark:text-neutral-200 text-right">
          {shortDate(apiKey.createdAt)}
        </dd>
        <dt className="text-neutral-500 dark:text-neutral-400">Last used</dt>
        <dd className="text-right">
          {apiKey.lastUsedAt ? (
            <span className="text-neutral-700 dark:text-neutral-200">
              {relativeTime(apiKey.lastUsedAt, NOW)}
            </span>
          ) : (
            <span className="text-neutral-400 dark:text-neutral-500">Never</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

type Toast = { id: string; message: string };

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string) => {
    const id = Math.random().toString(36).slice(2, 8);
    setToasts((ts) => [...ts, { id, message }]);
    setTimeout(() => {
      setToasts((ts) => ts.filter((t) => t.id !== id));
    }, 2400);
  }, []);
  return { toasts, push };
}

export function Toaster({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="dlg-anim pointer-events-auto rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs px-3 py-2 shadow-lg flex items-center gap-2"
        >
          <Check className="h-3.5 w-3.5" />
          {t.message}
        </div>
      ))}
    </div>
  );
}

function toApiKey(record: ApiKeyRecord, createdByName: string): ApiKey {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    createdBy: { id: "u_me", name: createdByName },
  };
}

export default function SettingsApiKeys() {
  const api = useApi();
  const { user } = useAuth0();
  const createdByName = user?.name ?? user?.email ?? "You";

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [renameTarget, setRenameTarget] = useState<ApiKey | null>(null);
  const { toasts, push } = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const orgs = await api.listOrganizations();
        if (cancelled) return;
        if (orgs.length === 0) {
          setOrgId(null);
          setKeys([]);
          setLoadError(
            "No organization found for this account. Create one before managing API keys.",
          );
          return;
        }
        const id = orgs[0].id;
        setOrgId(id);
        const records = await api.listApiKeys(id);
        if (cancelled) return;
        setKeys(records.map((r) => toApiKey(r, createdByName)));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load API keys");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // api/createdByName are stable per session; reload would re-mount component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (name: string): Promise<{ plaintext: string }> => {
    if (!orgId) throw new Error("No organization selected.");
    const created = await api.createApiKey(orgId, name);
    setKeys((ks) => [toApiKey(created, createdByName), ...ks]);
    push(`Created “${name}”`);
    return { plaintext: created.plaintext };
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    try {
      await api.revokeApiKey(target.id);
      setKeys((ks) =>
        ks.map((k) =>
          k.id === target.id ? { ...k, revokedAt: new Date().toISOString() } : k,
        ),
      );
      push(`Revoked “${target.name}”`);
    } catch (err) {
      push(err instanceof Error ? err.message : "Failed to revoke key");
    }
  };

  const handleCopyPrefix = (k: ApiKey) => {
    const value = `${k.prefix}…`;
    navigator.clipboard?.writeText(value);
    push("Copied prefix");
  };

  // Rename has no backend endpoint yet — this updates display state only and is
  // lost on reload. Wire to a server call once a PATCH endpoint exists.
  const handleRenameSubmit = (newName: string) => {
    if (!renameTarget) return;
    setKeys((ks) => ks.map((k) => (k.id === renameTarget.id ? { ...k, name: newName } : k)));
    push("Renamed key");
    setRenameTarget(null);
  };

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            API keys
          </h1>
          <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400 max-w-2xl">
            API keys authenticate SDK calls to the Zoetrope ingest endpoints. Treat them like
            passwords.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={!orgId || loading}
          className="inline-flex items-center gap-1.5 h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 focus-ring shadow-sm disabled:opacity-50 disabled:pointer-events-none"
        >
          <Plus className="h-4 w-4" />
          Create API key
        </button>
      </header>

      {loading ? (
        <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
          Loading API keys…
        </div>
      ) : loadError ? (
        <div className="rounded-xl bg-rose-50 dark:bg-rose-500/10 ring-1 ring-inset ring-rose-600/20 dark:ring-rose-400/20 p-4 flex gap-3 text-sm text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="break-words">{loadError}</span>
        </div>
      ) : keys.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm overflow-hidden">
          <div className="hidden sm:block">
            <table className="min-w-full text-left">
              <thead>
                <tr className="bg-neutral-50/70 dark:bg-neutral-900/60 border-b border-neutral-200 dark:border-neutral-800">
                  <th className="py-2.5 pl-6 pr-3 text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Name
                  </th>
                  <th className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Prefix
                  </th>
                  <th className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Created
                  </th>
                  <th className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Last used
                  </th>
                  <th className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Status
                  </th>
                  <th className="pl-3 pr-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <KeyRow
                    key={k.id}
                    apiKey={k}
                    onCopyPrefix={() => handleCopyPrefix(k)}
                    onRename={() => setRenameTarget(k)}
                    onRevoke={() => setRevokeTarget(k)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="sm:hidden">
            {keys.map((k) => (
              <KeyCard
                key={k.id}
                apiKey={k}
                onCopyPrefix={() => handleCopyPrefix(k)}
                onRename={() => setRenameTarget(k)}
                onRevoke={() => setRevokeTarget(k)}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && !loadError && keys.length > 0 && (
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          Need to rotate keys regularly? Read the{" "}
          <a href="#" className="text-indigo-600 dark:text-indigo-400 hover:underline">
            key rotation guide
          </a>
          .
        </div>
      )}

      <CreateKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />
      <RevokeDialog
        open={!!revokeTarget}
        apiKey={revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
      />
      <RenameDialog
        open={!!renameTarget}
        apiKey={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSubmit={handleRenameSubmit}
      />

      <Toaster toasts={toasts} />
    </div>
  );
}
