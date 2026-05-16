# Design brief — Zoetrope settings: API keys page

Generate a polished React component for the **API keys** section of the
Zoetrope settings page. This is a developer-facing admin tool, not a
consumer product — visual reference is the dashboards from Vercel,
Stripe, Linear, Resend. Clean, dense, slightly serious. Not playful.

## Product context (so you set the right tone)

Zoetrope is a session-recording pipeline for product teams. Developers
embed the Zoetrope SDK in their app; the SDK uploads rrweb session
chunks to the Zoetrope ingest API using an **API key** as a bearer
token. This page is where an admin in an organization manages those
keys: creates new ones, revokes compromised ones, sees when each was
last used.

The settings page itself has multiple sections in a left rail:
*General · Members · API keys · Billing · Webhooks*. **This brief is
only for the API keys section** — the rail can be a simple stub
showing all five with API keys selected.

## Stack constraints

- React 19, TypeScript, Tailwind v4 (using `@import "tailwindcss";`).
  v4 inference works on class strings in JSX, so write Tailwind classes
  directly inline; **do not** generate a `tailwind.config.js` —
  v4 doesn't need one.
- No new heavy deps. If a dialog/menu primitive is needed, use
  `@headlessui/react` or hand-roll with `<dialog>` + Tailwind. No
  shadcn/ui, no MUI, no Chakra.
- Use only built-in `lucide-react` icons (assume it's available).
- Mock data inline at the top of the file in a `const MOCK_KEYS = [...]`.
  No API calls — just realistic data so the UI can be reviewed
  standalone.
- Accessibility: full keyboard nav, focus trap inside the create-key
  dialog, focus restored to the trigger on close, ESC closes, ARIA
  labels on icon-only buttons.
- Dark-mode-aware via Tailwind's `dark:` variant. Default to system.

## Data shape

An API key looks like this (matches the backend):

```ts
type ApiKey = {
  id: string;
  name: string;          // human label, e.g. "Production ingest"
  prefix: string;        // first 12 chars of the plaintext key, shown
                         // truncated as e.g. "pk_live_demo…" — only
                         // the prefix is ever shown after creation
  createdAt: string;     // ISO 8601
  lastUsedAt: string | null;  // null = never used
  revokedAt: string | null;   // null = active; non-null = revoked
  createdBy: { id: string; name: string };
};
```

Generate ~6 mock entries: a mix of active + revoked, with varied
`lastUsedAt` (some "just now", some "3 days ago", some `null`).

## Required states

### 1. Default — list of API keys

A page header:
- Title: **API keys**
- One-line description: *"API keys authenticate SDK calls to the
  Zoetrope ingest endpoints. Treat them like passwords."*
- Primary button on the right: **Create API key** (with `+` icon)

A table below, columns:
| Name | Prefix | Created | Last used | Status | (actions) |

Notes:
- *Name* is bold; underneath it small muted text "*Created by {name} ·
  {relative time}*".
- *Prefix* renders in monospace, e.g. `pk_live_demo…` — uses a
  `<code>` element styled with `font-mono`.
- *Last used* shows a relative time ("2 hours ago"), or "Never" in
  muted gray if null.
- *Status* is a pill: green dot + "Active" or gray dot + "Revoked".
  Revoked rows have slightly dimmed text.
- *Actions* is an ellipsis icon button opening a menu: *Copy prefix*,
  *Rename…*, *Revoke* (red text, only shown if active). Use
  `@headlessui/react` `Menu` or `<details>` + `<summary>`.

### 2. Empty state (variant when `MOCK_KEYS` is empty)

Centered card-on-page: small key icon, headline "No API keys yet",
sub-copy "Create your first key to start sending session data.", and
the same **Create API key** button.

You can ship both states in the same file by adding a toggle at the
top of the component (`const showEmpty = false`) so a reviewer can
flip between them in one render.

### 3. Create-key dialog

Triggered by **Create API key**. Modal, centered, ~480px wide,
backdrop is `bg-neutral-950/50 backdrop-blur-sm`.

Dialog body has two sub-states managed by component state:

**3a. Form (initial)**
- Heading: "Create API key"
- Sub-copy: "Name your key so you can identify it later. The key
  itself is only shown once."
- Single `<input>` field: label "Name", placeholder "Production
  ingest". Validation: required, max 64 chars, trimmed. Show a small
  helper line under the field.
- Footer with **Cancel** (secondary, left) + **Create key** (primary,
  right). The primary is disabled until the name field is non-empty.

**3b. Reveal (after submit)**
- Heading: "Save your API key"
- Warning callout (amber/yellow, with `AlertTriangle` icon): "This
  is the only time you'll see this key. Copy it now and store it
  somewhere safe — Zoetrope only stores a hash."
- The plaintext key shown in a wide monospaced read-only input with
  a **Copy** button on the right that swaps to a check icon for ~2s
  after click. Use a realistic-looking placeholder like
  `pk_live_demo` + 36 random hex chars.
- Footer with one button: **Done** (primary, right-aligned).

The dialog uses the same primitive as elsewhere on the page; show
both 3a and 3b in the same file via another reviewer toggle
(`const dialogStage: 'form' | 'reveal' = 'form'`).

### 4. Revoke confirmation

Smaller modal triggered from the row's actions menu. Heading "Revoke
this API key?", sub-copy "Any service still using this key will
immediately get a 401. This cannot be undone.", footer with
**Cancel** + **Revoke key** (red/destructive primary).

## Visual direction

- Font: system sans (`font-sans` default), monospace `font-mono` for
  prefixes and the revealed key.
- Color palette: lean on Tailwind's `neutral` ramp. Accent for primary
  actions is `indigo-600 / hover:indigo-500` (light) / `indigo-500 /
  hover:indigo-400` (dark). Status colors: `emerald-500` for active,
  `neutral-400` for revoked, `amber-500` for the warning callout,
  `rose-600` for destructive actions.
- Border radius: `rounded-lg` for cards and inputs, `rounded-md` for
  pills, `rounded-xl` for the modal.
- Shadow: `shadow-sm` on the table card, `shadow-xl` on the modal.
- Spacing: page max-width `max-w-5xl mx-auto px-8 py-10`. Section
  gaps `space-y-8`. Generous row padding in the table (`py-4`).
- The page must look right at 1280px, 1024px, and 640px (table
  collapses to stacked cards below 640px).

## What to output

A single file `SettingsApiKeys.tsx` containing:
1. All TypeScript types
2. The mock data constants
3. Any small subcomponents (`KeyRow`, `StatusPill`, `CreateKeyDialog`,
   `RevokeDialog`, `EmptyState`) defined in the same file for easy
   review
4. The default export `SettingsApiKeys` rendering the full page

No README, no extra files, no comments explaining the brief back to
me — just the component, written like production code.
