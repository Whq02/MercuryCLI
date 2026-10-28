import { writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const scratch = scratchDir('fast-road')
const app = { identity: 'com.example.Editor', name: 'Editor', pid: 123, windowId: 'editor', title: 'Document', bounds: { x: 0, y: 0, width: 400, height: 300 } }
const scene = join(scratch, 'scene.json')
writeFileSync(scene, JSON.stringify({ displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 400, height: 300, scale: 2, primary: true }], frontmost: app, cursor: { x: 50, y: 50 }, lines: ['Editor proof'], tree: [{ role: 'AXButton', title: 'Save', frame: { x: 100, y: 80, width: 40, height: 20 } }, { role: 'AXTextField', title: 'Search', frame: { x: 200, y: 80, width: 80, height: 20 } }] }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
let context = toolContext()
const owner = ownerOf(context)
session.forgetDesktopOwner(owner)
let serial = 0
const call = async (input: Record<string, unknown>, consent = allowEverything) => resultOf(await ComputerTool.call(input as never, context, consent, toolUseTurn(`fast-${++serial}`, 'Computer', input)))
const target = { role: 'AXButton', name: 'Save' }
const inputs = [
  { action: 'click', target, capture: false },
  { action: 'find', target },
  { action: 'wait', until: target, durationMs: 500, capture: false },
  { action: 'screenshot', region: { x: 20, y: 20, width: 100, height: 60 } },
  { action: 'sequence', steps: [{ action: 'click', target }, { action: 'type', text: 'hello' }, { action: 'key', key: 'Enter' }], settleMs: 0 },
]
section('new inputs are real tool inputs')
let supported = true
for (const input of inputs) {
  const parsed = ComputerTool.inputSchema.safeParse(input)
  check(`${input.action} fast input parses`, parsed.success, JSON.stringify(parsed))
  supported &&= parsed.success
}
if (!supported) finish('prove-computer-fast-road')

section('tree targeting asks before reading, resolves afresh and refuses ambiguity')
const first = await ComputerTool.checkPermissions(inputs[0] as never, context)
check('targeted click uses the existing application ask', first.behavior === 'ask', JSON.stringify(first))
check('permission check reads no unapproved accessibility tree', !driver.acts.some(a => a.act === 'accessibilityTree'))
const clicked = await call(inputs[0]!)
check('tree target needs no screenshot', clicked.outcome === 'succeeded', clicked.result)
const click = driver.acts.find(a => a.act === 'click')
check('the exact element centre reached the driver in points', JSON.stringify(click?.detail.at) === JSON.stringify({ x: 120, y: 90 }), JSON.stringify(click))
check('the result names the target, cursor and front application', clicked.result.includes('Save') && clicked.result.includes('cursor') && clicked.result.includes('Editor'), clicked.result)
const found = await call({ action: 'find', target })
check('find gives a numbered target without an image', found.outcome === 'succeeded' && /\[\d+\] AXButton "Save"/.test(found.result) && !found.result.includes('@') && !found.imagePath, found.result)
const originalTree = driver.accessibilityTree.bind(driver)
driver.accessibilityTree = async (...args) => {
  const tree = await originalTree(...args)
  if (tree.ok) tree.value.elements.push({ depth: 1, role: 'AXButton', title: 'Save', value: null, frame: { x: 20, y: 20, width: 20, height: 20 } })
  return tree
}
const beforeAmbiguous = driver.acts.filter(a => a.act === 'click').length
const ambiguous = await call({ action: 'click', target, capture: false })
check('ambiguous targets do not click', ambiguous.outcome === 'failed' && ambiguous.result.includes('2 matches') && driver.acts.filter(a => a.act === 'click').length === beforeAmbiguous, ambiguous.result)
driver.accessibilityTree = originalTree
const hovered = await call({ action: 'move', target, capture: false })
const triple = await call({ action: 'click', target, count: 3, capture: false })
const scrolled = await call({ action: 'scroll', target, dy: 2, capture: false })
const dragged = await call({ action: 'drag', target, toTarget: { role: 'AXTextField', name: 'Search' }, capture: false })
check('hover, triple-click, targeted scroll and drag all work', [hovered, triple, scrolled, dragged].every(r => r.outcome === 'succeeded'), JSON.stringify([hovered, triple, scrolled, dragged]))
check('triple-click retains the native click count', driver.acts.some(a => a.act === 'click' && a.detail.count === 3))

section('stable settle ends at a product mark and keeps only the final image')
const originalCapture = driver.capture.bind(driver)
const stableFrame = await originalCapture(0, context.abortController.signal)
if (!stableFrame.ok) throw new Error(stableFrame.error.note)
const { FakeDesktopDriver, FAKE_SCENE_DEFAULT } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
const displayList = await driver.displays()
if (!displayList.ok) throw new Error(displayList.error.note)
const animatedDriver = new FakeDesktopDriver({ ...FAKE_SCENE_DEFAULT, displays: displayList.value.displays, lines: ['A different frame'], noise: true }, null)
const movingFrame = await animatedDriver.capture(0, context.abortController.signal)
if (!movingFrame.ok) throw new Error(movingFrame.error.note)
check('the animation fixture has genuinely different pixels', !movingFrame.value.png.equals(stableFrame.value.png))
let captures = 0
driver.capture = async () => {
  captures++
  return { ok: true, value: { ...(captures === 2 ? movingFrame.value : stableFrame.value), capturedAt: Date.now() } }
}
const shots = join(process.env.MERCURY_CONFIG_DIR!, 'desktop-shots')
const shotCount = () => { try { return readdirSync(shots).filter(p => p.endsWith('.png')).length } catch { return 0 } }
const beforeShots = shotCount()
const settled = await call({ action: 'click', target, capture: true, settleMs: 2000 })
check('settle reports stable, not a blind timer', settled.outcome === 'succeeded' && settled.result.includes('screen stable'), settled.result)
check('settle compares changing frames and stops when equal', captures >= 4 && captures <= 5, String(captures))
check('settle saves only its final screenshot', shotCount() === beforeShots + 1, `${beforeShots} -> ${shotCount()}`)
driver.capture = originalCapture

section('tree wait is bounded, image-free when requested and does not inherit never-ask wait')
session.forgetDesktopOwner(owner)
const waiting = { action: 'wait', until: target, durationMs: 1000, capture: false }
const waitPermission = await ComputerTool.checkPermissions(waiting as never, context)
check('wait-until asks like tree', waitPermission.behavior === 'ask', JSON.stringify(waitPermission))
let reads = 0
driver.accessibilityTree = async (...args) => {
  reads++
  const tree = await originalTree(...args)
  if (tree.ok && reads < 3) tree.value.elements = []
  return tree
}
const waited = await call(waiting)
check('wait-until polls until the named element appears', waited.outcome === 'succeeded' && reads >= 3 && !waited.imagePath, waited.result)
driver.accessibilityTree = originalTree
const timeout = await call({ action: 'wait', until: { name: 'Absent' }, durationMs: 20, capture: false })
check('missing element times out honestly', timeout.outcome === 'failed' && timeout.result.includes('timed out'), timeout.result)
let readCancelled = false
driver.accessibilityTree = async (_app, _limits, signal) => new Promise(resolve => {
  const fallback = setTimeout(() => resolve({ ok: false, error: { kind: 'defect', note: 'deadline never reached the driver' } }), 1000)
  const cancel = () => { clearTimeout(fallback); readCancelled = true; resolve({ ok: false, error: { kind: 'aborted', note: 'fixture read cancelled' } }) }
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
})
const slow = await call({ action: 'wait', until: target, durationMs: 20, capture: false })
check('the deadline cancels a slow tree read and is not called an operator interruption', readCancelled && slow.outcome === 'failed' && slow.result.includes('timed out') && !slow.result.includes('interrupted by the operator'), slow.result)
driver.accessibilityTree = originalTree

section('region captures preserve the global point mapping')
const opening = await withScreenshot(ComputerTool as never, context, 'region-opening')
context = opening.context
const region = { x: 100, y: 80, width: 120, height: 60 }
const cropped = await withScreenshot(ComputerTool as never, context, 'region-crop', { action: 'screenshot', region })
check('the image is only the requested rectangle', cropped.outcome === 'succeeded' && cropped.screen.imageWidth === 120 && cropped.screen.imageHeight === 60, cropped.result)
check('crop origin maps through the previous screenshot scale', cropped.screen.originX === Number(opening.screen.originX) + region.x * Number(opening.screen.pointWidth) / Number(opening.screen.imageWidth), JSON.stringify(cropped.screen))
context = cropped.context
const regionClick = await call({ action: 'click', x: 20, y: 20, capture: false })
check('pixel fallback acts against the cropped screenshot', regionClick.outcome === 'succeeded', regionClick.result)
const invalid = await call({ action: 'screenshot', region: { x: 110, y: 0, width: 30, height: 20 } })
check('a crop outside the visible image refuses', invalid.outcome === 'failed' && invalid.result.includes('outside'), invalid.result)

section('sequences check every act and stop at the first refusal')
session.forgetDesktopOwner(owner)
const decisions: string[] = []
const consent = (async (_tool: unknown, input: Record<string, unknown>) => {
  const decision = await ComputerTool.checkPermissions(input as never, context)
  decisions.push(`${input.action}:${decision.behavior}`)
  return { behavior: 'allow', updatedInput: input }
}) as never
const beforeSequenceShots = shotCount()
const sequenced = await call(inputs[4]!, consent)
check('three acts complete in order', sequenced.outcome === 'succeeded' && sequenced.result.includes('3/3'), sequenced.result)
check('the first step asks and later acts use its grant', decisions.join(',') === 'click:ask,type:allow,key:allow', decisions.join(','))
check('a sequence saves one final screenshot', shotCount() === beforeSequenceShots + 1, `${beforeSequenceShots} -> ${shotCount()}`)
const beforeRefused = driver.acts.filter(a => ['click', 'typeText', 'keyTap'].includes(a.act)).length
const refused = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'key', key: 'NoSuchKey' }, { action: 'type', text: 'never' }], capture: false })
check('a malformed sequence is rejected before its first act', refused.outcome === 'failed' && driver.acts.filter(a => ['click', 'typeText', 'keyTap'].includes(a.act)).length === beforeRefused, refused.result)
const originalFront = driver.frontmostApplication.bind(driver)
let changed = false
const originalClick = driver.click.bind(driver)
driver.click = async (...args) => { const result = await originalClick(...args); changed = true; return result }
driver.frontmostApplication = async () => changed ? { ok: true, value: { ...app, identity: 'com.example.Other', name: 'Other' } } : originalFront()
const denied = (async (_tool: unknown, input: Record<string, unknown>) => {
  const decision = await ComputerTool.checkPermissions(input as never, context)
  return decision.behavior === 'ask' ? { behavior: 'deny', message: 'operator declined' } : decision
}) as never
const beforeKeys = driver.acts.filter(a => a.act === 'keyTap').length
const stopped = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'key', key: 'Enter' }, { action: 'type', text: 'never' }], capture: false }, denied)
check('changing application asks afresh and refusal stops the sequence', stopped.outcome === 'failed' && stopped.result.includes('1/3') && driver.acts.filter(a => a.act === 'keyTap').length === beforeKeys, stopped.result)
driver.frontmostApplication = originalFront
driver.click = originalClick
session.forgetDesktopOwner(owner)

section('new forms retain terminal, bounds, window and permission guards')
context = toolContext()
const originalOwn = driver.ownTerminalApplication.bind(driver)
driver.ownTerminalApplication = async () => ({ ok: true, value: app })
const beforeOwn = driver.acts.filter(a => a.act === 'click').length
const ownTarget = await call({ action: 'click', target, capture: false })
check('tree targets cannot click the terminal running this session', ownTarget.outcome === 'failed' && ownTarget.result.includes('inside the window of the terminal running this session') && driver.acts.filter(a => a.act === 'click').length === beforeOwn, ownTarget.result)
driver.ownTerminalApplication = originalOwn
for (const kind of ['bounds', 'truncated'] as const) {
  driver.accessibilityTree = async (...args) => {
    const tree = await originalTree(...args)
    if (tree.ok) {
      if (kind === 'truncated') tree.value.truncated = true
      else for (const element of tree.value.elements) element.frame = null
    }
    return tree
  }
  const refused = await call({ action: 'click', target, capture: false })
  check(`${kind}: no coordinate guessing for a tree target`, refused.outcome === 'failed' && refused.result.includes(kind === 'bounds' ? 'no usable bounds' : 'truncated'), refused.result)
}
driver.accessibilityTree = async (...args) => {
  const tree = await originalTree(...args)
  driver.frontmostApplication = async () => ({ ok: true, value: { ...app, windowId: 'moved' } })
  return tree
}
const movedWait = await call({ action: 'wait', until: target, capture: false })
check('wait-until refuses a window change during the read', movedWait.outcome === 'failed' && movedWait.result.includes('front window changed'), movedWait.result)
driver.accessibilityTree = originalTree
driver.frontmostApplication = originalFront

const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
context = toolContext()
context.getAppState().toolPermissionContext.mode = 'sovereign'
context.getAppState().toolPermissionContext.isBypassPermissionsModeAvailable = true
const engineDecisions: string[] = []
const broker = (async (_tool: unknown, input: Record<string, unknown>) => {
  const { decision } = await decideToolPermission(ComputerTool, input, context)
  engineDecisions.push(decision.behavior)
  return decision
}) as never
const sovereign = await call({ action: 'sequence', steps: inputs[4]!.steps, capture: false }, broker)
check('the real decision engine allows every sovereign step without asks', sovereign.outcome === 'succeeded' && engineDecisions.join(',') === 'allow,allow,allow', `${sovereign.result}; ${engineDecisions}`)
context = toolContext({ deny: [`Computer(app:${app.identity})`] })
context.getAppState().toolPermissionContext.mode = 'sovereign'
context.getAppState().toolPermissionContext.isBypassPermissionsModeAvailable = true
const denyCount = driver.acts.filter(a => a.act === 'click').length
const appDenied = await call({ action: 'sequence', steps: inputs[4]!.steps, capture: false }, broker)
check('application denies still win inside sovereign sequences', appDenied.outcome === 'failed' && driver.acts.filter(a => a.act === 'click').length === denyCount, appDenied.result)
context = toolContext()
session.approveApp(owner, app)
driver.click = async (...args) => {
  const done = await originalClick(...args)
  context.getAppState().toolPermissionContext.alwaysDenyRules = { localSettings: ['Computer'] }
  return done
}
const genericDenied = await call({ action: 'sequence', steps: inputs[4]!.steps, capture: false }, broker)
check('a new whole-tool deny is checked even when the application has a grant', genericDenied.outcome === 'failed' && genericDenied.result.includes('1/3'), genericDenied.result)
driver.click = originalClick
session.forgetDesktopOwner(owner)
finish('prove-computer-fast-road')
