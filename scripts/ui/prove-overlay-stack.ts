#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-overlay-stack.ts — the overlay OWNERSHIP stack oracle
//  (mercury-feel; DoD: "Only the top modal owns keyboard input and
//  Escape. Closing it restores the exact prior focus").
//
//  UNIT: instance identity (duplicate semantic ids never collide — the old
//  Set<string> model's structural bug), z-order, focus-return runs only when
//  the popped entry was top.
//
//  LIVE: two stacked overlays under the real ink input pipeline; ONE esc
//  closes exactly ONE layer (the top), even though the first pop makes the
//  second overlay top mid-dispatch (the one-pop-per-event stamp), and the
//  next esc closes the survivor.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-overlay-stack.ts
// ============================================================================
process.env.NODE_ENV = 'test'

import { Readable, Writable } from 'node:stream'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const {
  pushOverlay,
  popOverlay,
  topOverlay,
  anyOverlayActive,
  anyModalOverlayActive,
  overlayStackSnapshot,
  resetOverlayStackForTests,
} = await import('../../src/context/overlayStack.js')

console.log('prove-overlay-stack')
console.log('── unit: instance identity + z-order + focus-return ──')

resetOverlayStackForTests()
const t1 = pushOverlay({ id: 'select', modal: true })
const t2 = pushOverlay({ id: 'select', modal: true })
check('duplicate semantic ids register independently', overlayStackSnapshot().length === 2)
check('top is the last-pushed instance', topOverlay()?.token === t2)
popOverlay(t1)
check('popping the FIRST instance leaves the second registered (old Set model failed this)', anyOverlayActive() && topOverlay()?.token === t2)
popOverlay(t2)
check('stack empties cleanly', !anyOverlayActive())

let focusReturns = 0
const fA = pushOverlay({ id: 'a', modal: true, onFocusReturn: () => focusReturns++ })
const fB = pushOverlay({ id: 'b', modal: true, onFocusReturn: () => focusReturns++ })
popOverlay(fA) // buried layer closes — must NOT steal focus back
check('popping a BURIED layer does not run its focus-return', focusReturns === 0)
popOverlay(fB) // top closes — restores opener focus
check('popping the TOP layer runs its focus-return', focusReturns === 1)

resetOverlayStackForTests()
pushOverlay({ id: 'autocomplete', modal: false })
check('non-modal overlay counts as active but not modal', anyOverlayActive() && !anyModalOverlayActive())
resetOverlayStackForTests()

console.log('── live: one esc closes exactly one layer ──')

const React = await import('react')
const { render, Box, Text } = await import('../../src/ink.js')
const { default: useInput } = await import('../../src/ink/hooks/use-input.js')
const { useRegisterOverlay, isTopOverlayNow } = await import('../../src/context/overlayContext.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')

let written = ''
const stdout = Object.assign(
  new Writable({
    write(chunk: Buffer, _enc, cb) {
      written += chunk.toString()
      cb()
    },
  }),
  { columns: 90, rows: 24, isTTY: false },
) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  setRawMode() {},
  ref() {},
  unref() {},
}) as unknown as NodeJS.ReadStream
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

const h = React.createElement as (...a: unknown[]) => React.ReactElement

// A layer registering on the stack with the house esc pattern.
function Layer({ id, onClose }: { id: string; onClose: () => void }): React.ReactNode {
  const token = useRegisterOverlay(id)
  useInput((_i, key) => {
    if (key.escape) {
      if (token !== null && !isTopOverlayNow(token)) return
      onClose()
    }
  })
  return h(Text as never, {}, `layer-${id}-open`)
}

function Host(): React.ReactNode {
  const [aOpen, setAOpen] = React.useState(true)
  const [bOpen, setBOpen] = React.useState(true)
  return h(
    Box as never,
    { flexDirection: 'column' },
    h(Text as never, {}, `state a=${aOpen ? 'open' : 'closed'} b=${bOpen ? 'open' : 'closed'}`),
    aOpen ? h(Layer as never, { id: 'under', onClose: () => setAOpen(false) }) : null,
    bOpen ? h(Layer as never, { id: 'over', onClose: () => setBOpen(false) }) : null,
  )
}

const instance = await render(h(AppStateProvider as never, {}, h(Host as never, {})), {
  stdout,
  stdin,
  exitOnCtrlC: false,
  patchConsole: false,
})
await new Promise(r => setTimeout(r, 40))
check('both layers registered', overlayStackSnapshot().length === 2, `${overlayStackSnapshot().length}`)

const esc = async () => {
  ;(stdin as unknown as Readable).push('\x1b')
  await new Promise(r => setTimeout(r, 300)) // lone-ESC grace
}

written = ''
await esc()
check('first esc closed ONLY the top layer', strip(written).includes('a=open b=closed'), strip(written).slice(-90))
check('the under layer survived the same keypress (one-pop-per-event)', overlayStackSnapshot().length === 1)

written = ''
await esc()
check('second esc closed the remaining layer', strip(written).includes('a=closed b=closed'))
check('stack empty after both closes', !anyOverlayActive())

instance.unmount?.()

// ── SOURCE: the composer's typeahead bridge yields to a modal overlay ──────
// The bridge re-dispatches every REPL keypress into the suggestion arms; the
// empty-prompt Tab arm consumes Tab (it paints the thinking-toggle hint)
// whenever the cockpit rails are not mounted. A modal overlay — a board, a
// select, a dialog — owns the keys while it is up, so the bridge must
// stand aside at EVENT time (its is-active flag is frozen across pushes):
// under 100 columns Tab on the /workflows board never reached the section
// strip because the hint arm swallowed it first.
{
  const { readFileSync } = await import('node:fs')
  const typeahead = readFileSync(new URL('../../src/hooks/useTypeahead.tsx', import.meta.url), 'utf8')
  const bridgeAt = typeahead.indexOf("if (currentSurfaceRoute().kind !== 'repl') return")
  const bridge = bridgeAt === -1 ? '' : typeahead.slice(bridgeAt, bridgeAt + 600)
  check(
    'the typeahead bridge reads the modal overlay stack at event time (anyModalOverlayActive)',
    typeahead.includes("import { anyModalOverlayActive } from '../context/overlayStack.js'") &&
      /if \(anyModalOverlayActive\(\)\) return/.test(bridge),
  )
  check(
    'the modal check sits BEFORE the keypress is re-dispatched into the suggestion arms',
    bridge.indexOf('if (anyModalOverlayActive()) return') !== -1 &&
      bridge.indexOf('if (anyModalOverlayActive()) return') < bridge.indexOf('new KeyboardEvent(event.keypress)'),
  )
  const overlayCtx = readFileSync(new URL('../../src/context/overlayContext.tsx', import.meta.url), 'utf8')
  check(
    "a board registers as a MODAL overlay (only 'autocomplete' is non-modal)",
    /NON_MODAL_OVERLAYS = new Set\(\['autocomplete'\]\)/.test(overlayCtx),
  )
}

console.log(failures === 0 ? '\n✓ prove-overlay-stack: all green' : `\n✗ prove-overlay-stack: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
