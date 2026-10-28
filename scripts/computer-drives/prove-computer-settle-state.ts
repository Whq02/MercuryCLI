import { check, finish, section } from '../computer/computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from '../computer/computerToolKit.ts'
import type { DesktopTreeElement } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const resolution = resolveDesktopDriver()
if (resolution.state !== 'ok') throw new Error(resolution.note)
const driver = resolution.driver
const context = toolContext()
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`settle-${++serial}`, 'Computer', input) as never))
let title = 'Document'
let focus = 'First'
let inputValue = ''
let mode: 'title' | 'focus' | 'value' | 'same' | 'slow' = 'title'
let acted = false
let afterReads = 0
let cancelled = false
const app = { identity: 'com.example.Editor', name: 'Editor', pid: 123, title, windowId: 'editor', bounds: { x: 100, y: 100, width: 800, height: 600 } }
driver.frontmostApplication = async () => ({ ok: true, value: { ...app, title } })
driver.accessibilityTree = async (_app, _limits, signal) => {
  if (acted) afterReads++
  if (acted && mode === 'focus' && afterReads >= 3) focus = 'Second'
  if (acted && mode === 'slow') return new Promise(resolve => {
    const fallback = setTimeout(() => resolve({ ok: false, error: { kind: 'defect', note: 'the read deadline never arrived' } }), 1000)
    const abort = () => { clearTimeout(fallback); cancelled = true; resolve({ ok: false, error: { kind: 'aborted', note: 'fixture read cancelled' } }) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  const focused: DesktopTreeElement = { depth: 16, role: 'AXTextField', title: focus, value: inputValue, focused: true, frame: { x: focus === 'First' ? 150 : 250, y: 150, width: 80, height: 20 } }
  return { ok: true, value: { elements: [{ depth: 0, role: 'AXWindow', title, value: null, frame: app.bounds }], focused, truncated: true, reason: null, scope: 'window' } }
}
const keyTap = driver.keyTap.bind(driver)
driver.keyTap = async (...args) => {
  const answer = await keyTap(...args)
  acted = true
  afterReads = 0
  if (mode === 'title') title = title === 'Document' ? 'New Bot - Grok' : 'Automations - Grok'
  if (mode === 'value') inputValue = 'new text'
  return answer
}
const reset = (next: typeof mode) => { mode = next; acted = false; afterReads = 0; title = 'Document'; focus = 'First'; inputValue = '' }

section('change is an observation of the window or focused element')
const changed = await call({ action: 'key', key: 'Tab', settleMs: 100, capture: false })
check('navigation reports changed before the new after-state', changed.outcome === 'succeeded' && changed.result.includes('changed · now: window "New Bot - Grok"'), changed.result)
reset('same')
let start = Date.now()
const unchanged = await call({ action: 'key', key: 'Tab', settleMs: 100, capture: false })
check('no change waits through settleMs and reports unchanged', unchanged.outcome === 'succeeded' && unchanged.result.includes('unchanged · now: window "Document"') && Date.now() - start >= 90, unchanged.result)
reset('focus')
const focused = await call({ action: 'key', key: 'Tab', settleMs: 500, capture: false })
check('a delayed focus change is observed beyond the shallow tree', focused.outcome === 'succeeded' && focused.result.includes('changed · now: window "Document" · focus AXTextField "Second"') && afterReads >= 3, `${focused.result}; reads ${afterReads}`)
reset('value')
const typed = await call({ action: 'key', key: 'Tab', settleMs: 0, capture: false })
check('a value change in the same focused control is not a focus change', typed.result.includes('unchanged · now:') && typed.result.includes('focus AXTextField "First"'), typed.result)
reset('same')
const instant = await call({ action: 'key', key: 'Tab', settleMs: 0, capture: false })
check('zero settle still reads the after-state exactly once', instant.outcome === 'succeeded' && afterReads === 1 && instant.result.includes('unchanged · now:'), instant.result)

section('bounded reads and operator cancellation')
reset('slow')
start = Date.now()
const slow = await call({ action: 'key', key: 'Tab', settleMs: 50, capture: false })
check('settle cancels a slow tree without calling it an operator interruption', cancelled && Date.now() - start < 700 && slow.outcome === 'succeeded' && !slow.result.includes('interrupted by the operator'), slow.result)

section('sequences retain only the last step after-state')
reset('title')
const sequence = await call({ action: 'sequence', steps: [{ action: 'key', key: 'Tab' }, { action: 'key', key: 'Tab' }], capture: false, settleMs: 0 })
check('sequence has exactly one now line for its final step', sequence.outcome === 'succeeded' && (sequence.result.match(/now:/g)?.length ?? 0) === 1 && sequence.result.includes('changed · now: window "Automations - Grok"'), sequence.result)
reset('title')
const waited = await call({ action: 'sequence', steps: [{ action: 'key', key: 'Tab' }, { action: 'wait', durationMs: 0 }], capture: false, settleMs: 0 })
check('a final wait carries its own after-state, not the earlier key state', waited.outcome === 'succeeded' && (waited.result.match(/now:/g)?.length ?? 0) === 1 && waited.result.includes('unchanged · now: window "New Bot - Grok"'), waited.result)
reset('same')
const captured = await call({ action: 'key', key: 'Tab', capture: true, settleMs: 100 })
check('capture keeps the image but removes old settle prose', captured.outcome === 'succeeded' && !!captured.imagePath && captured.result.includes('unchanged · now:') && !/settle cap reached|screen stable|target region stable|window stable/.test(captured.result), captured.result)

section('a native-shaped fixture exposes focus beyond the shallow walk')
const { FakeDesktopDriver, FAKE_SCENE_DEFAULT } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
type FakeNode = typeof FAKE_SCENE_DEFAULT.tree[number]
let content: FakeNode = { role: 'AXRadioButton', title: 'Overview', focused: true }
for (let depth = 0; depth < 7; depth++) content = { role: 'AXGroup', children: [content] }
content = { role: 'AXGroup (AXApplicationDialog)', title: 'Webhook configuration', children: [content] }
for (let depth = 0; depth < 11; depth++) content = { role: 'AXGroup', children: [content] }
const fixture = new FakeDesktopDriver({ ...FAKE_SCENE_DEFAULT, frontmost: { ...app, title: 'Automations' }, tree: [{ role: 'AXWindow', title: 'Automations', focused: true, children: [content] }] }, null)
const before = await fixture.accessibilityTree({ ...app, title: 'Automations' }, { depth: 8, count: 200, scope: 'window' }, context.abortController.signal)
check('the pre-act tree carries the focused control even when its rows stop above it', before.ok && before.value.truncated && before.value.focused?.title === 'Overview' && !before.value.elements.some(row => row.title === 'Overview'))
const { readObservation, treeObservation } = await import('../../src/tools/ComputerTool/fastRoad.ts')
const deep = await readObservation(fixture, context.abortController.signal)
const words = treeObservation(deep)
check('depth-13 dialog and depth-21 focus survive the depth-3 observation', words === 'now: window "Automations" · dialog "Webhook configuration" · focus AXRadioButton "Overview"', words)
await fixture.close()

section('the final capture refreshes the sequence after-state')
reset('title')
const capture = driver.capture.bind(driver)
driver.capture = async (...args) => { title = 'After final capture'; return capture(...args) }
const sequenceShot = await call({ action: 'sequence', steps: [{ action: 'key', key: 'Tab' }], capture: true, settleMs: 0 })
check('only the after-state of the captured final screen is returned', sequenceShot.outcome === 'succeeded' && (sequenceShot.result.match(/now:/g)?.length ?? 0) === 1 && sequenceShot.result.includes('now: window "After final capture"'), sequenceShot.result)
driver.capture = capture

section('an operator interruption during the after-read remains an interruption')
reset('slow')
const controller = new AbortController()
const interruptedContext = toolContext({ controller })
const tree = driver.accessibilityTree.bind(driver)
driver.accessibilityTree = async (...args) => { if (acted) controller.abort(); return tree(...args) }
const interrupted = resultOf(await ComputerTool.call({ action: 'key', key: 'Tab', settleMs: 100 } as never, interruptedContext, allowEverything, toolUseTurn('settle-interrupted', 'Computer', { action: 'key', key: 'Tab' }) as never))
check('an interrupted observation fails and releases input', interrupted.outcome === 'failed' && interrupted.result.includes('interrupted by the operator') && interrupted.result.includes('released'), interrupted.result)
driver.accessibilityTree = tree
finish('prove-computer-settle-state')
