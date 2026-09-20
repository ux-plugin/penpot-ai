# Input model — every device, three shapes

> Status: **DESIGN** (2026-09-20). Builds on the cells IR
> ([IR_SPEC.md](IR_SPEC.md)). Nothing here adds a fourth kind of thing to the
> IR; it says how every input a user can make — on web, desktop, mobile,
> console, TV, pen, XR, watch, voice, sensors, accessibility tooling, or a
> device they define themselves — lands in cells, refs and interactions, and
> what the runtime and catalog have to grow to get there.

## 1. The rule

Every user input is one of three shapes, and the model has exactly one tool
for each:

```
  what the user does                    where it lands
  ─────────────────────────────         ──────────────────────────────────────
  DISCRETE   click, key, swipe,   ───►  TRIGGER on a node (or AppRule)
             button, phrase,            → interaction writes cells
             note-on, shake, scan

  CONTINUOUS drag offset, pinch   ───►  PLATFORM STORE CELL (runtime-owned,
             scale, pressure,           read-only) → read by a ref
             stick axis, crown,
             tilt, window size

  NAVIGATION d-pad, remote,       ───►  one runtime cell  device.focusedNode
             switch control,            "activate" = `press` on the focused node
             rotary knob
```

- A discrete input is an **event**: it happens once, an interaction runs,
  writes cells, and is done.
- A continuous input is a **value**: it changes every frame, nobody is
  notified, a property simply references it. It is a cell in a store the
  runtime owns (`gesture`, `gamepad`, `pen`, `xr`, `device`, `route`) — the
  same `Cell.store` mechanism app data uses, marked built-in.
- Navigation is neither: it moves a cursor. The cursor is one cell,
  `device.focusedNode`, and spatial navigation is the runtime's job. The
  designer never authors it; they style the focused variant
  (`btn.state ← …`) and everything that "activates" — A button, OK, Enter,
  look-and-pinch — is `press` on the focused node through the per-platform
  fallback table (`resolveTriggerForPlatform`).

Hover, focus and pressed *looks* are never trigger effects. They are a variant
cell on the node (`btn.state`) written by the trigger pair
(`mouse-enter`/`mouse-leave`, `press-in`/`press-out`, `focus`/`blur`) and read
by refs.

## 2. Inventory

Status column: **wired** = in the catalog and executed by runtime + emitter,
**planned** = declared, not executed, **—** = not in the catalog yet.

### 2.1 Pointer & touch (node triggers)

| Input | Web | Desktop | Mobile | Model | Status |
|---|---|---|---|---|---|
| Click / tap | ✓ | ✓ | ✓ | `press` | wired |
| Double click / tap | ✓ | ✓ | ✓ | `double-press` | — |
| Long press / right-click | ✓ | ✓ | ✓ | `long-press`, `context-menu` | — |
| Press in / out | ✓ | ✓ | ✓ | `press-in` / `press-out` → variant cell | — |
| Hover in / out | ✓ | ✓ | — | `mouse-enter` / `mouse-leave` | wired (web) |
| Drag start / end / cancel | ✓ | ✓ | ✓ | `drag-start` / `drag-end` / `drag-cancel`, payload `dx dy velocity` | — |
| Drag offset while dragging | ✓ | ✓ | ✓ | continuous `gesture.dragX/Y` | — |
| Drop onto a node | ✓ | ✓ | ✓ | `drop`, payload `from` | — |
| Swipe | touch | — | ✓ | `swipe`, param `direction` (edge-only: the platform classifies the drag) | — |
| Pan / fling | — | — | ✓ | `pan-start/end` + `gesture.dx/dy`, `gesture.velocity` | — |
| Pinch / rotate | trackpad | trackpad | ✓ | `pinch-start/end/cancel` + `gesture.scale`, `gesture.rotation`, `gesture.centerX/Y` | — |
| Scroll / wheel | ✓ | ✓ | ✓ | continuous `node.scrollX/Y` + `scroll-end` | — |
| Pull to refresh | — | — | ✓ | `pull-refresh` | — |
| Pointer position | ✓ | ✓ | — | continuous `device.pointerX/Y` | — |

### 2.2 Keyboard & text

| Input | Model | Status |
|---|---|---|
| Typing into a field, any control change | the `value` ref (two-way) — not a trigger | wired (string/number/boolean; enum/select control not emitted yet) |
| Submit (Enter in field, form submit, keyboard "go") | `submit` on the field/form | — |
| Key down / up on a focused node | `key-press`, param `key` | — |
| Global shortcut | AppRule `shortcut`, param `keys` | — |
| Focus / blur | `focus` / `blur` → variant cell | — |
| Software keyboard shown / hidden | `device.keyboardHeight` + `keyboard-show/hide` AppRules | — |

### 2.3 System, lifecycle, environment

| Input | Model | Status |
|---|---|---|
| Page / screen load | AppRule `page-load` | planned |
| After delay / timer | `after-delay` (node), `timer` (AppRule) | planned |
| Node appears / disappears in viewport | `appear` / `disappear` | — |
| Back (browser, hardware, swipe-back) | AppRule `back` | — |
| Foreground / background | AppRules `resume` / `pause` | — |
| Resize / orientation | `device.width/height/orientation` cells | — |
| Online / offline | `device.online` cell (+ AppRules) | — |
| Deep link / route params | `route` store, filled by the router | — |
| Dark mode, reduced motion, text scale, contrast | `device.colorScheme`, `device.reducedMotion`, `device.textScale`, `device.contrast` cells | — |
| Media / animation ended | `media-end`, `animation-end` | — |

### 2.4 Console, TV, pen, XR, watch, car

| Input | Model |
|---|---|
| Gamepad face buttons, bumpers | A = `press` on the focused node (fallback table); others `button-press`, param `button` |
| D-pad / stick as navigation, TV remote arrows, iDrive knob | focus navigation (§1) — nothing authored per node |
| Sticks, analog triggers, DualSense touchpad/gyro | continuous `gamepad.leftX/Y`, `rightX/Y`, `l2/r2`, `touchX/Y`, `gyro` |
| Rumble | action `haptic`, params `intensity duration` |
| Controller connect / disconnect, multiple players | AppRules; `gamepad` is a collection cell, `gamepad[1].leftX` |
| TV: back / home / menu / media keys / voice button | AppRules `back home menu media-key voice` |
| Pen down / up / tap, barrel button, eraser | `press-in/out/press` with `event.pointerType`, `button-press`, `pen.eraser` cell |
| Pen pressure, tilt, azimuth, twist, hover height | continuous `pen.pressure`, `pen.tiltX/Y`, `pen.twist`, `pen.hoverHeight` |
| XR controller buttons, trigger, grip | `press`, `button-press`; grip force `xr.gripL/R` |
| XR thumbsticks, controller and head pose | continuous `xr.stickL/R`, `xr.handL.position` (`object` cell), `xr.head.rotation` |
| Hand tracking pinch / grab, gaze | `pinch-start/end`, `grab-start/end`; gaze = the hover pair; look-and-pinch = `press` |
| AR plane found, tracking lost, enter/exit immersive | AppRules; anchors as a store collection |
| Watch crown / rotary knob | continuous `device.crown` + `crown-turn`, payload `delta` |
| Raise to wake, side button, steering-wheel buttons | AppRules |

### 2.5 Voice, accessibility, sensors, peripherals

| Input | Model |
|---|---|
| Voice command | AppRule `voice`, param `phrase`, payload `transcript slots` |
| Dictation | the `value` ref — it is text input |
| Switch control, Voice Control ("tap Save") | focus navigation + `press`; free once `label` is a ref |
| Screen reader | not an interaction: refs on `label`, `role`, `hint`; action `announce` |
| Accelerometer / gyro / compass / GPS / light / proximity / barometer / battery | `device.*` cells |
| Shake, geofence enter/exit | AppRules the runtime derives from the continuous cells |
| NFC / QR scan | AppRule `scan`, payload `payload` |
| Camera / mic | streams are not cells; results are: `capture` (payload `photo`), `record-stop` (payload `audio`) |
| MIDI | `note-on/off`, payload `note velocity`; continuous `midi.cc[n]` |
| Bluetooth peripheral | a user-defined device (§5) |

### 2.6 Output actions this implies

`haptic`, `announce`, `focus <node>`, `scroll-to <node>`, `play/pause <media>`,
`copy-to-clipboard`, `share` — all `lowers: 'effect'`, catalog entries only.

## 3. Gestures — edges vs. the live value

A gesture has two kinds of moment, and they must not be modelled the same way.

```
   drag-start                                          drag-end
   trigger, once                                       trigger, once
   ┃                                                   ┃
   ┃         gesture.dragY  (store cell, every frame)  ┃
   ┃        ╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾ ┃
   ┃      ╱      read by   sheet.y ← Math.max(0, gesture.dragY)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━► time
   set sheet.state = "dragging"          if event.dy > 120: set sheet.state = "dismissed"
                                         (else nothing — the value resets, the ref snaps back)
```

- **Edges are triggers** (`drag-start`, `drag-end`, `drag-cancel`). They run
  once, carry a payload (`event.dx`, `event.dy`, `event.velocity`,
  `event.scale`, …), and are where decisions live. The end edge *commits*
  the outcome into a cell the design owns.
- **The middle is a value, not a series of events.** `gesture.dragY` changes
  ~60×/s. Making it a trigger would author an interaction firing per frame,
  writing a cell per frame, flooding the activity log and re-running every
  guard. Instead a ref reads it. When the gesture ends the runtime resets the
  live cells (offset → 0, scale → 1) and the ref re-evaluates.
- **Commit without a jump.** During a pinch the image shows
  `zoom * gesture.scale`. On `pinch-end` the interaction runs
  `set zoom = zoom * event.scale`; the runtime resets `gesture.scale` to 1;
  the ref evaluates to the same number. The pattern is always
  *look = committed ∘ live; the end edge bakes live into committed.*
- **Cancel** (`drag-cancel`: finger left the screen, system took over) fires
  like an end edge with no commit. When everything "while dragging" is a
  ref, cancel needs nothing authored: the live values reset and the variant
  ref goes back to idle by itself. Only a start edge that *wrote* a cell
  needs a cancel interaction.

| Piece of a pinch | Kind | Model |
|---|---|---|
| Two fingers land | edge | `pinch-start`, payload `centerX centerY` |
| Distance ratio while pinching | live | `gesture.scale` (1 at start) |
| Angle while pinching | live | `gesture.rotation` (0 at start) |
| Midpoint drift | live | `gesture.centerX/Y`, `gesture.dx/dy` |
| Fingers lift | edge | `pinch-end`, payload `scale rotation velocity` |
| Interrupted | edge | `pinch-cancel` |

Swipe is the degenerate case: a drag whose end edge the platform classifies,
so it is edge-only (`swipe`, payload `direction`) with no live value. A stick
axis is the opposite: live-only, no edges — an event comes out of it through a
condition trigger (§4).

### 3.1 `gesture` is scoped per node, like `item`

Three cards can each be dragged; a repeated list has one template node and N
instances. Where does "the drag offset" live?

- *A cell per node* (`card1.dragY`, …) explodes, and a repeated row has no
  node to attach it to.
- *One global gesture store with an equality check*
  (`card.y ← gesture.node == card ? gesture.dragY : 0`) works for distinct
  nodes and breaks for repeats, where every row **is** the template.
- **Scope the symbol.** Inside a ref on node X, `gesture` means "the gesture
  on this X (this instance of X)", resolved per instance the way `item` is
  inside a repeat. When there is none, `gesture.active` is false and the live
  values are at rest.

```
row.y     ← gesture.dragY                      per row, no check
row.state ← gesture.active ? "dragging" : "idle"
```

The store is still one runtime-owned thing; only the *symbol* is scoped.
`gesture.node` / `gesture.over` exist for a **different** node reacting to a
gesture — a drop zone: `zone.state ← gesture.over == zone ? "hot" : "idle"`.

## 4. "Something every tick" — three tiers

| Need | Tool | Example |
|---|---|---|
| A property follows the input | **ref** | `y ← gesture.dragY` — most cases; zero authoring of ticks |
| Something happens **when a threshold is crossed**, once | **condition trigger** `when <expr>`: fires on the false→true edge of a formula | `when gesture.dragY > 120 → haptic("light")`, `when gamepad.leftX > 0.5 → …` |
| Actions must run on **every** move | `drag-move` / `pinch-move` / `scroll`, payload `dx dy` — the escape hatch, throttled to the frame, labelled as such in the UI | recording a path, accumulating distance |

The condition trigger is the missing piece and the important one: most
"every tick" wishes are "the first tick where X becomes true". It is a trigger
whose source is a formula instead of an input event; `normalize` already has
`derive` nodes, so it lowers to an effect watching one. It is also how a
user makes a trigger out of *any* cell without code.

## 5. Devices — the user-definable unit

A **device** is the bundle of what §1 needs from any input source: a store
schema (continuous cells), catalog triggers (events with payloads), catalog
actions (outputs), and a way for the preview to get real values. The built-in
sources (`web` pointer/keyboard, `gesture`, `gamepad`, `pen`, `xr`, `device`,
`route`) are devices shipped with the editor; a user can add their own — a
foot pedal, an Arduino knob, a MIDI controller, a hardware prototype.

```
        preview source ──►  Device definition (user-authored)
        HID · MIDI ·         id · platforms · cells · triggers · actions · gestures · source
        socket · sim                │
             ┌──────────────────────┼──────────────────────┐
             ▼                      ▼                      ▼
        store cells            catalog triggers        catalog actions
        pedal.position (live,  pedal.press (payload)   pedal.led (effect)
        read-only, builtin)
             └──────────────────────┴──────────────────────┘
                                    ▼
             UNCHANGED: refs · interactions · runtime · emitter · handover
```

```ts
interface Device {
  id: string                         // 'pedal' → cells read as pedal.position
  label: string
  platforms: Platform[]              // where it can exist
  cells: Record<string, { type: ValueType; initial: Json }>              // live, read-only
  triggers: Record<string, { scope: 'node' | 'app'; payload?: Record<string, ValueType> }>
  actions?: Record<string, { params?: Record<string, ValueType> }>       // outputs, lowers 'effect'
  gestures?: Record<string, { start: string; end: string; cancel?: string; live: string[] }>
  navigate?: { next: string; prev: string; up?: string; down?: string; left?: string; right?: string; activate: string }
  source: { kind: 'pointer' | 'keyboard' | 'gamepad-api' | 'webhid' | 'midi' | 'websocket' | 'script' | 'simulator'; config?: Json }
}
```

Registering a device is three things and nothing else:

| Declared | Becomes | Mechanism that already exists |
|---|---|---|
| `cells` | a built-in read-only store named `<id>` | `Cell.store` + a `builtin` flag |
| `triggers` | `registerTriggers([{ key: '<id>.<name>', … }])`; payload schema feeds the `event.*` scope | catalog registry |
| `actions` | `registerActions([{ key: '<id>.<name>', lowers: 'effect' }])` | catalog registry |
| `gestures` | one gesture card in the inspector grouping start / while / end / cancel | UI only |
| `navigate` | the device participates in focus navigation | runtime |

Nothing after registration knows a device exists. A ref reads
`pedal.position` like any store cell; an interaction on `pedal.press` is an
ordinary interaction; the emitter lowers the store to props
(`pedal: { position: number }`) and the triggers to callback props
(`onPedalPress`) — the derivation store cells already get. **Handover for a
custom device is "the real app supplies this store and calls these
callbacks"**, the seam that already exists.

### 5.1 Preview sources

| Source | What the user does | Code? |
|---|---|---|
| Simulator | nothing — generated from the schema: sliders for cells, buttons for triggers | no |
| Pointer / keyboard / Gamepad API | built in | no |
| WebHID / Web MIDI | pick the hardware in the browser prompt; map report bytes / CC numbers to cells and events (a table) | no |
| WebSocket / SSE | a URL; messages `{ cell, value }` or `{ event, payload }` | no |
| Script | a sandboxed adapter `(emit) => …` | yes |

Every device gets the simulator for free. It is how a gyro is tested on a
desktop, a foot pedal without owning one, a 10-foot remote without a TV — a
store's sample data, animated. It lives in the Data panel next to stores.

### 5.2 The honest test

The built-in pointer must be expressible as a device: `web` with cells
`pointerX/Y`, triggers `press`, `mouse-enter`, `mouse-leave`, `press-in/out`,
gestures `drag` and `pinch`, source `pointer`. Today `press → onClick` is
hard-wired in the emitter; it becomes the `web` device's lowering table. If
the pointer cannot be described as a device, the schema is wrong.

### 5.3 What stays fixed vs. what is data

| Fixed (the model) | User-defined (data) |
|---|---|
| cells, refs, interactions, app rules | which cells a device has |
| `Trigger { type, params }`, the `event.*` scope | which triggers exist and their payloads |
| `lowers: fold / switch / effect` | which effect actions exist |
| the focus cell and spatial navigation | whether a device participates |
| the gesture card (start / while / end / cancel) | which triggers and live cells form a gesture |
| `when <expr>` | — (already makes a trigger out of any cell) |
| composite actions (a named, parameterized `do` list — a reducer over existing actions) | which ones exist |

## 6. Authoring UX

- **Gesture card** on the node, one block: *While* (refs, pre-filtered to the
  device's live cells — the same property-reference pill as anywhere) ·
  *When it ends* (guarded actions) · *If cancelled* (collapsed, "resets
  automatically", expands only when start wrote a cell). The IR stays three
  plain triggers; the card is a view.
- **Condition triggers** appear in the trigger menu as "When … becomes true"
  with an expression field.
- **Per-tick triggers** are in the menu, labelled "runs ~60×/s".
- **Devices** are authored in the Data panel next to stores: `+ Device`,
  rows for cells / events / outputs, a source picker, the simulator inline.
- **Focus** is never authored; the focused variant is styled like hover.

## 7. Changes to the engine (all small, in order)

1. **Platform tags**: `'web' | 'native'` → add `tv`, `console`, `xr`,
   `watch`, `auto`; extend the `press` fallback table (click / tap / A / OK /
   Enter / look-and-pinch).
2. **Event payload in scope**: catalog entries declare `payload`; `buildScope`
   exposes `event.*` inside guards and action values; runtime and emitter
   supply it. (Today only the edit fold's `event.value` exists.)
3. **Built-in stores**: reserved read-only store ids with `builtin: true`;
   Data panel shows them, can't delete or edit samples; the runtime fills
   them.
4. **Focus**: `device.focusedNode`, `focus` / `blur` triggers, spatial
   navigation in the runtime, activate → `press` on the focused node.
5. **`when <expr>`** condition trigger, edge-triggered, lowered to an effect
   over a derive node.
6. **`gesture` symbol scoping** per node/instance in `buildScope` and the
   runtime env, like `item`.
7. **`Device`** in the IR (`DocumentMeta.devices`, so a file that uses a
   pedal opens elsewhere); the built-in devices expressed as definitions; the
   simulator panel.
8. **Catalog fill**, in priority order: `press-in/out`, `long-press`,
   `double-press`, `submit`, `focus/blur`, `key-press`, `swipe`, `appear`,
   `page-load`, `back`, then the drag / pinch edges and the `gesture` store.

Trigger keys become namespaced (`pedal.press`, `web.press`) — the catalog
needs a namespace rule and an unqualified-key resolution for the built-in
`web` device so existing IR (`press`) keeps working.

## 8. Open questions

- Is `gesture` one store with a scoped symbol, or a store per device that
  declares `gestures` (`pen.gesture`, `xr.gesture`)? Scoping the symbol is
  the same either way; the question is only naming.
- Multi-touch beyond pinch (two independent drags) — probably out of scope
  until a device needs it; the per-instance scoping already handles two
  fingers on two rows.
- Composite actions: reducer-only, or do they get parameters (`event.*`
  pass-through)?
- Where the simulator's state is saved: it is sample data, so per document,
  in the device definition.
