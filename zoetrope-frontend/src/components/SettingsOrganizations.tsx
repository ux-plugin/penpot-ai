import {
  AlertTriangle,
  Building2,
  LogOut,
  MoreHorizontal,
  Plus,
  Settings,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Modal, Toaster, useToasts } from "./SettingsApiKeys";
import { useApi, type Organization } from "../lib/api";

type Tone = "Owner" | "Admin" | "Member";

type OrgView = Organization & {
  initial: string;
  tint: string;
  roleLabel: Tone;
};

const TINTS = [
  "from-neutral-800 to-neutral-900",
  "from-violet-500 to-fuchsia-500",
  "from-sky-500 to-indigo-500",
  "from-rose-400 to-amber-400",
  "from-emerald-500 to-teal-500",
];

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

function decorate(org: Organization): OrgView {
  return {
    ...org,
    initial: (org.name.trim()[0] ?? "?").toUpperCase(),
    tint: TINTS[hashIndex(org.id, TINTS.length)],
    roleLabel:
      org.role === "OWNER" ? "Owner" : org.role === "ADMIN" ? "Admin" : "Member",
  };
}

function relTime(iso: string, ref = Date.now()): string {
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
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function slugify(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function OrgAvatar({
  initial,
  tint,
  size = "h-11 w-11",
  round = "rounded-lg",
}: {
  initial: string;
  tint: string;
  size?: string;
  round?: string;
}) {
  return (
    <span
      className={`flex items-center justify-center bg-gradient-to-br text-white text-sm font-semibold ring-1 ring-inset ring-white/10 shadow-sm ${tint} ${size} ${round}`}
    >
      {initial}
    </span>
  );
}

function OrgRow({
  org,
  onLeave,
  onDelete,
}: {
  org: OrgView;
  onLeave: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const isOwner = org.role === "OWNER";

  return (
    <section className="group rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm hover:ring-neutral-300 dark:hover:ring-neutral-700 transition-colors">
      <div className="flex items-center gap-4 px-5 py-4">
        <OrgAvatar initial={org.initial} tint={org.tint} />

        <div className="min-w-0 flex-1">
          <a
            href="#"
            className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 hover:underline underline-offset-2 decoration-neutral-300 dark:decoration-neutral-700 truncate"
          >
            {org.name}
          </a>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 truncate">
            <span
              className={
                isOwner ? "font-medium text-neutral-700 dark:text-neutral-200" : ""
              }
            >
              {org.roleLabel}
            </span>
            <span className="mx-1.5 text-neutral-300 dark:text-neutral-700">·</span>
            <span className="font-mono">{org.slug}</span>
            <span className="mx-1.5 text-neutral-300 dark:text-neutral-700">·</span>
            Joined {relTime(org.createdAt)}
          </p>
        </div>

        <div className="relative shrink-0">
          <button
            ref={btnRef}
            type="button"
            aria-label={`More actions for ${org.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 focus-ring"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              role="menu"
              className="absolute right-0 z-20 mt-1 w-52 origin-top-right rounded-lg bg-white dark:bg-neutral-900 py-1 shadow-lg ring-1 ring-neutral-200 dark:ring-neutral-800 dlg-anim"
            >
              <button
                role="menuitem"
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
                onClick={() => setMenuOpen(false)}
              >
                <Settings className="h-4 w-4" />
                Org settings
              </button>
              <button
                role="menuitem"
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring"
                onClick={() => setMenuOpen(false)}
              >
                <Users className="h-4 w-4" />
                Manage members
              </button>
              <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
              {isOwner ? (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(org.id);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 focus-ring"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete organization
                </button>
              ) : (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onLeave(org.id);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 focus-ring"
                >
                  <LogOut className="h-4 w-4" />
                  Leave organization
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CreateOrgModal({
  open,
  onCancel,
  onCreate,
}: {
  open: boolean;
  onCancel: () => void;
  onCreate: (req: { name: string; slug: string }) => Promise<void>;
}) {
  const titleId = useId();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setSlug("");
      setSlugTouched(false);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  const valid = name.trim().length >= 2 && slug.length >= 2 && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), slug });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={busy ? () => {} : onCancel} labelledBy={titleId} width="max-w-[460px]">
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        disabled={busy}
        className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring disabled:opacity-50"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="px-6 pt-6 pb-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700">
            <Building2 className="h-5 w-5 text-neutral-700 dark:text-neutral-200" />
          </div>
          <div>
            <h2
              id={titleId}
              className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
            >
              Create a new organization
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              You'll be the Owner. Invite teammates after.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              Organization name
            </span>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Replay"
              disabled={busy}
              className="block w-full h-9 rounded-md bg-white dark:bg-neutral-950 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 px-2.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              URL slug
            </span>
            <div className="flex items-center h-9 rounded-md bg-white dark:bg-neutral-950 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 focus-within:ring-2 focus-within:ring-indigo-500">
              <span className="pl-2.5 pr-1 text-xs text-neutral-400 dark:text-neutral-500 font-mono">
                zoetrope.dev/
              </span>
              <input
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlug(slugify(e.target.value));
                  setSlugTouched(true);
                }}
                placeholder="acme-replay"
                disabled={busy}
                className="flex-1 h-full bg-transparent border-0 outline-none pr-2.5 text-sm font-mono text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 disabled:opacity-60"
              />
            </div>
            <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              Lowercase letters, numbers and hyphens. Can't be changed easily after.
            </p>
          </label>
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
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid}
            data-autofocus="true"
            onClick={submit}
            className="inline-flex items-center justify-center gap-1.5 h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 focus-ring shadow-sm disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy && (
              <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            )}
            {busy ? "Creating…" : "Create organization"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function LeaveOrgModal({
  open,
  org,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  org: OrgView | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  if (!org) return null;
  return (
    <Modal open={open} onClose={onCancel} labelledBy={titleId} width="max-w-[420px]">
      <div className="px-6 pt-6 pb-5">
        <h2
          id={titleId}
          className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
        >
          Leave {org.name}?
        </h2>
        <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">
          You'll lose access to this organization's projects. To rejoin you'll need a new
          invitation from an Owner or Admin.
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
            Leave organization
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteOrgModal({
  open,
  org,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  org: OrgView | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const titleId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  if (!org) return null;
  const matches = typed.trim() === org.name && !busy;

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete organization");
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={busy ? () => {} : onCancel} labelledBy={titleId} width="max-w-[440px]">
      <div className="px-6 pt-6 pb-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-50 dark:bg-rose-500/10 ring-1 ring-inset ring-rose-600/20 dark:ring-rose-400/20 shrink-0">
            <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          </div>
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-base font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight"
            >
              Delete {org.name}?
            </h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              This permanently deletes the organization, removes every member, and revokes every
              API key. This action
              <span className="font-medium text-rose-600 dark:text-rose-400"> cannot be undone</span>
              .
            </p>
          </div>
        </div>

        <label className="mt-5 block">
          <span className="block text-xs text-neutral-600 dark:text-neutral-300 mb-1">
            Type{" "}
            <span className="font-mono font-medium text-neutral-900 dark:text-neutral-100">
              {org.name}
            </span>{" "}
            to confirm
          </span>
          <input
            type="text"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            className="block w-full h-9 rounded-md bg-white dark:bg-neutral-950 ring-1 ring-inset ring-neutral-300 dark:ring-neutral-700 px-2.5 text-sm font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:opacity-60"
          />
        </label>

        {error && (
          <div className="mt-3 flex gap-2 rounded-md bg-rose-50 dark:bg-rose-500/10 p-2.5 ring-1 ring-inset ring-rose-600/20 dark:ring-rose-400/20 text-xs text-rose-700 dark:text-rose-300">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 -mx-6 px-6 pt-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center justify-center h-9 rounded-md px-3 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-ring disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!matches}
            onClick={submit}
            className="inline-flex items-center justify-center gap-1.5 h-9 rounded-md px-3 text-sm font-medium text-white bg-rose-600 hover:bg-rose-500 focus-ring shadow-sm disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy && (
              <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            )}
            {busy ? "Deleting…" : "Delete organization"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function SettingsOrganizations() {
  const api = useApi();
  const [orgs, setOrgs] = useState<OrgView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<OrgView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OrgView | null>(null);
  const { toasts, push } = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const list = await api.listOrganizations();
        if (cancelled) return;
        setOrgs(list.map(decorate));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load organizations");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (req: { name: string; slug: string }) => {
    const created = await api.createOrganization(req);
    setOrgs((arr) => [...arr, decorate(created)]);
    setCreateOpen(false);
    push(`Created ${created.name}`);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    await api.deleteOrganization(target.id);
    setOrgs((arr) => arr.filter((o) => o.id !== target.id));
    setDeleteTarget(null);
    push(`${target.name} was deleted`);
  };

  // No backend endpoint for leave yet — surface as an error so the user knows
  // why the action did nothing. Wire to a real call once it exists.
  const confirmLeave = () => {
    setLeaveTarget(null);
    push("Leaving an organization isn't supported yet");
  };

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Organizations
          </h1>
          <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400 max-w-2xl">
            All the organizations you belong to. Create a new one for a separate team, or leave
            the ones you no longer need.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 h-9 rounded-md px-3 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 focus-ring shadow-sm disabled:opacity-50 disabled:pointer-events-none"
        >
          <Plus className="h-4 w-4" />
          Create organization
        </button>
      </header>

      {loading ? (
        <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
          Loading organizations…
        </div>
      ) : loadError ? (
        <div className="rounded-xl bg-rose-50 dark:bg-rose-500/10 ring-1 ring-inset ring-rose-600/20 dark:ring-rose-400/20 p-4 flex gap-3 text-sm text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="break-words">{loadError}</span>
        </div>
      ) : orgs.length === 0 ? (
        <div className="rounded-xl bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800 shadow-sm p-10 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-700">
            <Building2 className="h-5 w-5 text-neutral-500 dark:text-neutral-400" />
          </div>
          <h3 className="mt-3 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
            You're not in any organizations yet
          </h3>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto">
            Create one to start collaborating with your team.
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="mt-4 inline-flex items-center gap-1.5 h-8 rounded-md px-3 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 focus-ring shadow-sm"
          >
            <Plus className="h-3.5 w-3.5" />
            Create your first organization
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {orgs.map((org) => (
            <OrgRow
              key={org.id}
              org={org}
              onLeave={(id) => setLeaveTarget(orgs.find((o) => o.id === id) ?? null)}
              onDelete={(id) => setDeleteTarget(orgs.find((o) => o.id === id) ?? null)}
            />
          ))}
        </div>
      )}

      <CreateOrgModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />
      <LeaveOrgModal
        open={!!leaveTarget}
        org={leaveTarget}
        onCancel={() => setLeaveTarget(null)}
        onConfirm={confirmLeave}
      />
      <DeleteOrgModal
        open={!!deleteTarget}
        org={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
      <Toaster toasts={toasts} />
    </div>
  );
}
