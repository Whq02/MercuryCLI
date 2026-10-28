import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section, sourceText } from '../computer/computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from '../computer/computerToolKit.ts'
import type { DesktopApplication, DesktopTreeElement } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const app: DesktopApplication = { identity: 'com.google.Chrome', name: 'Google Chrome', pid: 123, windowId: 'browser', title: null, bounds: { x: 0, y: 0, width: 400, height: 300 } }
const scene = join(scratchDir('after-state'), 'scene.json')
writeFileSync(scene, JSON.stringify({ frontmost: app, displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 400, height: 300, scale: 1, primary: true }], tree: [] }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolution = resolveDesktopDriver()
if (resolution.state !== 'ok') throw new Error(resolution.note)
const driver = resolution.driver
const context = toolContext()
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`after-${++serial}`, 'Computer', input) as never))
let page = 0
let unreadable = false
let treeReads = 0
let postReads = 0
let acted = false
const titles = ['Grok', 'New Bot - Grok', 'Automations - Grok']
const row = (depth: number, role: string, title: string | null, extra: Partial<DesktopTreeElement> = {}): DesktopTreeElement => ({ depth, role, title, value: null, frame: { x: 20, y: 20, width: 40, height: 20 }, ...extra })
driver.accessibilityTree = async (_app, _limits, signal) => {
  treeReads++
  if (acted) postReads++
  if (signal.aborted) return { ok: false, error: { kind: 'aborted', note: 'fixture read cancelled' } }
  if (unreadable && acted) return { ok: false, error: { kind: 'display', note: 'fixture tree unavailable' } }
  return { ok: true, value: { truncated: false, reason: null, scope: 'window', elements: [
    row(0, 'AXApplication', 'Google Chrome'),
    row(1, 'AXWindow', titles[page]!),
    row(2, 'AXTextField', 'Address and search bar', { value: page === 1 ? 'https://grok.com/bots/new?private=hidden#section' : 'grok.com/automations' }),
    row(2, 'AXButton', 'Open routine'),
    ...(page === 2 ? [row(3, 'AXGroup (AXApplicationDialog)', 'Mercury session webhook triage')] : []),
    row(4, 'AXRadioButton', 'Overview', { focused: true }),
  ] } }
}
const click = driver.click.bind(driver)
driver.click = async (...args) => {
  const result = await click(...args)
  page = Math.min(2, page + 1)
  acted = true
  return result
}
const target = { role: 'AXButton', name: 'Open routine' }
section('identical clicks return the screen after navigation')
const first = await call({ action: 'click', target, capture: false, settleMs: 0 })
acted = false
const second = await call({ action: 'click', target, capture: false, settleMs: 0 })
check('both identical clicks succeeded', first.outcome === 'succeeded' && second.outcome === 'succeeded', `${first.result}\n${second.result}`)
check('the first click reports the new window title from AX when frontmost has none', first.result.includes('now: window "New Bot - Grok"'), first.result)
check('the second click reports the new window and dialog', second.result.includes('now: window "Automations - Grok" · dialog "Mercury session webhook triage"'), second.result)
check('the focused control is an after-state fact', second.result.includes('· focus AXRadioButton "Overview"') && !second.result.includes('focus before input'), second.result)
check('the address bar is a host/path without credentials, query or fragment', first.result.includes('· url grok.com/bots/new') && !first.result.includes('private=') && !first.result.includes('#section'), first.result)
check('the same click no longer repeats an identical success line', first.result !== second.result, second.result)
check('each act reads the after-state once', postReads === 2, `post reads ${postReads}; all reads ${treeReads}`)
check('the after-state is on the card as the second line', first.result.split('\n')[1]?.includes('now: window "New Bot - Grok"') === true, first.result)

section('captured and verified acts keep the after-state')
page = 0
acted = false
const capture = driver.capture.bind(driver)
driver.capture = async (...args) => { page = 2; return capture(...args) }
const captured = await call({ action: 'click', target, capture: true, settleMs: 0 })
check('the after-state is read after the capture settles', captured.outcome === 'succeeded' && captured.result.includes('now: window "Automations - Grok"') && !!captured.imagePath, captured.result)
driver.capture = capture
page = 0
acted = false
const verified = await call({ action: 'click', target, verify: true, capture: false, settleMs: 0 })
check('verify does not replace the after-state', verified.outcome === 'succeeded' && verified.result.includes('now: window "New Bot - Grok"'), verified.result)

section('an unavailable read never repeats stale focus')
acted = false
unreadable = true
const unavailable = await call({ action: 'click', target, capture: false, settleMs: 0 })
check('an act still reports completion when its after-read is unavailable', unavailable.outcome === 'succeeded', unavailable.result)
check('an unavailable read does not claim the old focused control', !unavailable.result.includes('AXRadioButton "Overview"') && !unavailable.result.includes('focus before input'), unavailable.result)

section('an application switch keeps the tree permission boundary')
acted = false
unreadable = false
const frontmost = driver.frontmostApplication.bind(driver)
driver.frontmostApplication = async () => acted ? { ok: true, value: { ...app, identity: 'com.example.Other', name: 'Other', title: 'Another window' } } : frontmost()
const readsBeforeSwitch = postReads
const switched = await call({ action: 'click', target, capture: false, settleMs: 0 })
check('a new front application exposes its title but not its unapproved tree', switched.outcome === 'succeeded' && switched.result.includes('now: window "Another window"') && postReads === readsBeforeSwitch, switched.result)
driver.frontmostApplication = frontmost

section('optional after-state phrases')
const { treeObservation } = await import('../../src/tools/ComputerTool/fastRoad.ts')
const observation = (identity: string, elements: DesktopTreeElement[]) => treeObservation({ app: { ...app, identity, name: identity, title: 'Document' }, tree: { elements, truncated: false, reason: null } })
const sheet = observation('com.example.Editor', [row(0, 'AXWindow', 'Document'), row(1, 'AXSheet', 'Save as'), row(2, 'AXTextField', 'Name', { focused: true })])
check('sheets use the dialog phrase', sheet === 'now: window "Document" · dialog "Save as" · focus AXTextField "Name"', sheet)
const address = row(1, 'AXTextField', 'Address and search bar', { value: 'https://user:password@example.com/a?token=private#fragment' })
const browser = observation('com.google.Chrome', [address])
check('URL output drops userinfo, query and fragment', browser.endsWith('· url example.com/a') && !/password|private|fragment/.test(browser), browser)
const other = observation('com.example.Editor', [address])
check('non-browser text fields are not called URLs or dialogs', !other.includes(' · url ') && !other.includes(' · dialog '), other)
check('an ordinary group is not called a dialog', !observation('com.example.Editor', [row(1, 'AXGroup', 'Dialog settings')]).includes(' · dialog '))

section('native title sources')
const mac = sourceText('native/desktop/src/mac.rs')
check('macOS frontmost carries the focused AX window title', /ApplicationAnswer::found\(identity, name, Some\(pid as u32\), title, bounds\)/.test(mac) && /ax_string\(focused, "AXTitle"\)/.test(mac))
check('Windows already reads GetWindowTextW for frontmost', sourceText('native/desktop/src/win.rs').includes('Some(pid), window_title(window), window_bounds(window)'))
check('X11 already reads the active window title', sourceText('native/desktop/src/x11.rs').includes('Some(identity), pid, title, window_bounds(conn, window, root)'))
finish('prove-computer-after-state')
