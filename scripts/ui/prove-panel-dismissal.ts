
process.env.NODE_ENV = 'test'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const layer = await import('../../src/ink/recessLayer.js')
const stack = await import('../../src/context/overlayStack.js')
const { nodeCache } = await import('../../src/ink/node-cache.js')
const { handleMouseEvent, default: App } = await import('../../src/ink/components/App.js')
const { createSelectionState } = await import('../../src/ink/geometry/selection.js')
stack.resetOverlayStackForTests()
const outer = {} as never
const inner = {} as never
nodeCache.set(outer, { x: 0, y: 15, width: 120, height: 25 })
nodeCache.set(inner, { x: 2, y: 16, width: 116, height: 23 })
const closeOuter = layer.registerElevatedSurface(outer)
check('a crew or tasks host alone supplies both halves', stack.anyModalOverlayActive() && layer.hasElevatedSurface(), JSON.stringify({ stack: stack.overlayStackSnapshot(), inside: layer.elevatedSurfaceContains(0, 15), outside: layer.elevatedSurfaceContains(0, 14) }))
check('surface registration does not own keyboard focus', stack.topOverlay() === null)
let focusReturns = 0
const input = stack.pushOverlay({ id: 'panel-control', modal: true, onFocusReturn: () => focusReturns++ })
const closeInner = layer.registerElevatedSurface(inner)
check('a frame mounted after its control cannot steal its keys', stack.topOverlay()?.token === input)
check('inner frame edge stays inside', layer.elevatedSurfaceContains(2, 16) === true && layer.elevatedSurfaceContains(117, 38) === true)
check('host padding is outside the inner frame', layer.elevatedSurfaceContains(1, 16) === false && layer.elevatedSurfaceContains(118, 38) === false)
stack.popOverlay(input)
check('surface registration cannot swallow focus return', focusReturns === 1)
closeInner()

let escapes = 0
let beneath = 0
let selections = 0
const selection = createSelectionState()
const app = new App({ selection, stdin: { isTTY: true }, stdout: {}, dispatchClick: () => { beneath++; return false }, getHyperlinkAt: () => { beneath++; return 'https://example.invalid' }, openHyperlink: () => { beneath++ }, dispatchHover: () => {}, notifySelectionChange: () => {}, handleSelectionStart: () => { selections++ }, handleSelectionDrag: () => { selections++ }, handleSelectionRelease: () => { selections++; return false }, handleMultiClick: () => { selections++ } } as never)
app.pressEscape = () => { escapes++ }
const mouse = (action: 'press' | 'release', col: number, row: number, button = 0) => handleMouseEvent(app, { kind: 'mouse', action, col, row, button } as never)
mouse('press', 1, 15)
mouse('press', 2, 15, 32)
mouse('release', 2, 15)
check('outside press, motion and release close once and touch nothing beneath', escapes === 1 && beneath === 0 && selections === 0, JSON.stringify({ escapes, beneath, selections }))
mouse('press', 1, 15)
mouse('release', 1, 15)
check('a second outside click is a second close, never multi-selection', escapes === 2 && selections === 0)
closeOuter()
check('unmount removes both registrations', !stack.anyOverlayActive() && !layer.hasElevatedSurface() && layer.elevatedSurfaceContains(1, 1) === null)
console.log(`${seen.size} registrations; ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
