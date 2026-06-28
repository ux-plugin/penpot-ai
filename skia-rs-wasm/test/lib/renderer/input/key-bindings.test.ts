import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { canvasMachine } from '@/lib/renderer/machine/canvas-machine'
import { buildKeyBindings, dispatchKey } from '@/lib/renderer/input/key-bindings'
import type { CommandCtx } from '@/lib/renderer/input/commands'
import { DEFAULT_SHORTCUTS } from '@/lib/renderer/store/shortcuts-store'

function ctxFor(actor: ReturnType<typeof createActor<typeof canvasMachine>>): CommandCtx {
  return {
    actor,
    renderer: null,
    getViewport: () => null,
    onViewportUpdate: undefined,
    zoomCenter: () => ({ x: 0, y: 0 }),
    shortcuts: DEFAULT_SHORTCUTS,
  }
}

/** Minimal KeyboardEvent stand-in (jsdom-free): only what dispatchKey reads. */
function key(code: string, opts: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }> = {}) {
  let prevented = false
  return {
    code,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    target: opts.target ?? null,
    preventDefault: () => { prevented = true },
    get defaultPrevented() { return prevented },
  } as unknown as KeyboardEvent
}

const bindings = buildKeyBindings(DEFAULT_SHORTCUTS)

describe('dispatchKey', () => {
  it('KeyP toggles the pen tool', () => {
    const a = createActor(canvasMachine).start()
    expect(dispatchKey(key('KeyP'), bindings, ctxFor(a))).toBe(true)
    expect(a.getSnapshot().context.drawTool).toBe('pen')
  })

  it('Escape cancels an armed draw tool (precedence over path-finish)', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'DRAW_TOOL_ACTIVATE', tool: 'rect' })
    dispatchKey(key('Escape'), bindings, ctxFor(a))
    expect(a.getSnapshot().context.drawTool).toBeNull()
  })

  it('Escape finishes a path edit when no draw tool is armed', () => {
    const a = createActor(canvasMachine).start()
    a.send({ type: 'START_PATH_EDIT', shapeId: 's1' })
    dispatchKey(key('Escape'), bindings, ctxFor(a))
    expect(a.getSnapshot().matches('pathEditing')).toBe(false)
  })

  it('KeyA only switches to Add while editing a path', () => {
    const a = createActor(canvasMachine).start()
    // Not editing: KeyA is unhandled.
    expect(dispatchKey(key('KeyA'), bindings, ctxFor(a))).toBe(false)
    a.send({ type: 'START_PATH_EDIT', shapeId: 's1' })
    expect(dispatchKey(key('KeyA'), bindings, ctxFor(a))).toBe(true)
    expect(a.getSnapshot().context.pathSubTool).toBe('add')
  })

  it('a modified tool letter (Ctrl+R) is ignored (bareOnly)', () => {
    const a = createActor(canvasMachine).start()
    expect(dispatchKey(key('KeyR', { ctrlKey: true }), bindings, ctxFor(a))).toBe(false)
    expect(a.getSnapshot().context.drawTool).toBeNull()
  })

  it('tool letters are ignored while typing in an input', () => {
    const a = createActor(canvasMachine).start()
    const target = { closest: (sel: string) => (sel.includes('input') ? {} : null) }
    expect(dispatchKey(key('KeyR', { target }), bindings, ctxFor(a))).toBe(false)
  })

  it('unbound key returns false', () => {
    const a = createActor(canvasMachine).start()
    expect(dispatchKey(key('KeyZ'), bindings, ctxFor(a))).toBe(false)
  })
})

describe('rebindable tool keys (config-driven)', () => {
  it('uses the configured key code for a tool, not a hardcoded one', () => {
    const a = createActor(canvasMachine).start()
    const custom = buildKeyBindings({ ...DEFAULT_SHORTCUTS, penKey: 'KeyQ' })
    // Old key no longer triggers pen…
    expect(dispatchKey(key('KeyP'), custom, ctxFor(a))).toBe(false)
    // …the rebound one does.
    expect(dispatchKey(key('KeyQ'), custom, ctxFor(a))).toBe(true)
    expect(a.getSnapshot().context.drawTool).toBe('pen')
  })
})
