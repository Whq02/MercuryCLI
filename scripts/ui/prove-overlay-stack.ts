#!/usr/bin/env bun
process.env.NODE_ENV = 'test'

import { Readable, Writable } from 'node:stream'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

const {
  pushOverlay,
  popOverlay,
  topOverlay,
  anyOverlayActive,
  anyModalOverlayActive,
  overlayStackSnapshot,
  resetOverlayStackForTests,
} = await import('../../src/screen/overlays/overlayStack.js')

console.log('prove-overlay-stack')
console.log('── unit: instance identity + z-order + focus-return ──')

resetOverlayStackForTests()
const t1 = pushOverlay({ id: 'select', modal: true })
const t2 = pushOverlay({ id: 'select', modal: true })
check('duplicate semantic ids register independently', overlayStackSnapshot().length === 2, '', 'pushOverlay in src/screen/overlays/overlayStack.ts must keep one entry per push, keyed by token and not by id')
check('top is the last-pushed instance', topOverlay()?.token === t2, '', 'topOverlay in src/screen/overlays/overlayStack.ts must return the last pushed entry')
popOverlay(t1)
check('popping the FIRST instance leaves the second registered (old Set model failed this)', anyOverlayActive() && topOverlay()?.token === t2, '', 'popOverlay in src/screen/overlays/overlayStack.ts must remove only the entry of the token it is given')
popOverlay(t2)
check('stack empties cleanly', !anyOverlayActive(), '', 'popOverlay in src/screen/overlays/overlayStack.ts must leave the stack empty once every token is popped')

let focusReturns = 0
const fA = pushOverlay({ id: 'a', modal: true, onFocusReturn: () => focusReturns++ })
const fB = pushOverlay({ id: 'b', modal: true, onFocusReturn: () => focusReturns++ })
popOverlay(fA)
check('popping a BURIED layer does not run its focus-return', focusReturns === 0, '', 'popOverlay in src/screen/overlays/overlayStack.ts must call onFocusReturn only when the popped entry was the top one')
popOverlay(fB)
check('popping the TOP layer runs its focus-return', focusReturns === 1, '', 'popOverlay in src/screen/overlays/overlayStack.ts must call onFocusReturn of the popped top entry')

resetOverlayStackForTests()
pushOverlay({ id: 'autocomplete', modal: false })
check('non-modal overlay counts as active but not modal', anyOverlayActive() && !anyModalOverlayActive(), '', 'anyOverlayActive and anyModalOverlayActive in src/screen/overlays/overlayStack.ts must tell a non-modal entry from a modal one')
resetOverlayStackForTests()

console.log('── live: one esc closes exactly one layer ──')

const React = await import('react')
const { render, Box, Text } = await import('../../src/screen/themedRenderer.js')
const { default: useInput } = await import('../../src/screen/renderer/bindings/use-input.js')
const { useRegisterOverlay, isTopOverlayNow } = await import('../../src/screen/overlays/overlayHooks.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')

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
check('both layers registered', overlayStackSnapshot().length === 2, `${overlayStackSnapshot().length}`, 'useRegisterOverlay in src/screen/overlays/overlayHooks.tsx must push one entry per mounted Layer')

const esc = async () => {
  ;(stdin as unknown as Readable).push('\x1b')
  await new Promise(r => setTimeout(r, 300))
}

written = ''
await esc()
check('first esc closed ONLY the top layer', strip(written).includes('a=open b=closed'), strip(written).slice(-90), 'the Esc handler in Layer must call onClose only when isTopOverlayNow (src/screen/overlays/overlayStack.ts) is true for its token')
check('the under layer survived the same keypress (one-pop-per-event)', overlayStackSnapshot().length === 1, '', 'useRegisterOverlay in src/screen/overlays/overlayHooks.tsx must keep the under layer registered after the top layer closes')

written = ''
await esc()
check('second esc closed the remaining layer', strip(written).includes('a=closed b=closed'), '', 'the second Esc must reach the remaining layer once the top one is popped (isTopOverlayNow in src/screen/overlays/overlayStack.ts)')
check('stack empty after both closes', !anyOverlayActive(), '', 'useRegisterOverlay in src/screen/overlays/overlayHooks.tsx must pop its token when the layer unmounts')

instance.unmount?.()


console.log(failures === 0 ? '\n✓ prove-overlay-stack: all green' : `\n✗ prove-overlay-stack: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
