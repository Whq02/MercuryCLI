import { writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const claim = await import('../../src/services/desktop/desktopClaim.ts')
const { acquirePidLock, releasePidLock } = await import('../../src/substrate/pidLock.ts')
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
check('settle reports the unchanged after-state without stability prose', settled.outcome === 'succeeded' && settled.result.includes('unchanged · now: window "Document"') && !settled.result.includes('screen stable'), settled.result)
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
const defaulted = await call({ action: 'wait', until: target, capture: false })
check('wait with until waits up to 5 s by default and says how long the condition took', defaulted.outcome === 'succeeded' && /met after \d+ms of 5000/.test(defaulted.result), defaulted.result)
const plain = await call({ action: 'wait', capture: false })
check('a plain wait keeps its 1 s default', plain.outcome === 'succeeded' && plain.result.startsWith('wait 1000ms'), plain.result)
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

section('a screenshot step inside a sequence sets the coordinates for the steps after it, so a pixel act there is refused as unseen')
{
  const reopened = await withScreenshot(ComputerTool as never, context, 'sequence-opening')
  context = reopened.context
  const inner = { x: 100, y: 80, width: 120, height: 60 }
  const ratio = Number(reopened.screen.pointWidth) / Number(reopened.screen.imageWidth)
  const staleX = Number(reopened.screen.originX) + 20 * ratio
  const staleY = Number(reopened.screen.originY) + 20 * ratio
  const inSequence = await call({ action: 'sequence', steps: [{ action: 'screenshot', region: inner }, { action: 'click', x: 20, y: 20 }] })
  check('the click after an in-sequence screenshot does not act through the previous top-level map', inSequence.outcome === 'failed' && inSequence.result.includes('sequence 1/2 completed') && !inSequence.result.includes(`→ (${staleX}, ${staleY}) pt`), inSequence.result.slice(0, 300))
  check('it is refused for the reason the model can act on: the screenshot was taken in this same message and has not been seen — take it alone, then act', inSequence.result.includes('click refused: the last screenshot was taken in this same message — you have not seen it; take the screenshot alone, then the region or the act; nothing further done'), inSequence.result.slice(0, 300))
  check("the in-sequence screenshot's own line is kept in the answer and says the coordinates now refer to the region", inSequence.result.includes('coordinates now refer to this region'), inSequence.result.slice(0, 400))
}

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

section('the sequence state line compares the screen before the first step with the screen after the last, whatever the last step is')
{
  const originalFrontS = driver.frontmostApplication.bind(driver)
  const originalClickS = driver.click.bind(driver)
  let clicked = false
  driver.click = async (...args) => { const answer = await originalClickS(...args); clicked = true; return answer }
  driver.frontmostApplication = async () => { const front = await originalFrontS(); return clicked && front.ok ? { ok: true, value: { ...front.value, windowId: 'editor-renamed', title: 'Renamed' } } : front }
  const trailingWait = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'wait', durationMs: 10 }], capture: false })
  check('a click that changed the window followed by a wait reads changed, not unchanged', trailingWait.outcome === 'succeeded' && /^changed · now:/m.test(trailingWait.result), trailingWait.result)
  clicked = false
  const trailingShot = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'screenshot' }] })
  check('a sequence ending in a screenshot is compared and its focus read, never "not compared · focus not read"', trailingShot.outcome === 'succeeded' && /^changed · now:/m.test(trailingShot.result) && !trailingShot.result.includes('not compared') && !trailingShot.result.includes('focus not read'), trailingShot.result)
  clicked = false
  const trailingFind = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'find', target }], capture: false })
  check('a click followed by a find reads changed too', trailingFind.outcome === 'succeeded' && /^changed · now:/m.test(trailingFind.result), trailingFind.result)
  driver.click = originalClickS
  driver.frontmostApplication = originalFrontS
  const waits = await call({ action: 'sequence', steps: [{ action: 'wait', durationMs: 10 }, { action: 'wait', durationMs: 10 }], capture: false })
  check('two waits that changed nothing read unchanged with the focus named', waits.outcome === 'succeeded' && /^unchanged · now:.*focus /m.test(waits.result), waits.result)
  session.forgetDesktopOwner(owner)
}

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

section('a clamped target is scrolled into view and acted on in one act; one that will not come into view is refused with honest words (a browser reports an element below the fold as a 1 pt strip: frame y 985, height 1)')
{
  const chrome = { identity: 'com.example.Browser', name: 'Browser', pid: 4242, windowId: 'careers', title: 'Careers — Example', bounds: { x: 0, y: 30, width: 1920, height: 956 } }
  const area = (role: string, title: string, frame: { x: number; y: number; width: number; height: number }, extra: Record<string, unknown> = {}) => ({ role, title, frame, ...extra })
  const far = join(scratch, 'far.json')
  writeFileSync(far, JSON.stringify({
    displays: [{ index: 0, id: 'careers', originX: 0, originY: 0, width: 1920, height: 1080, scale: 2, primary: true }],
    frontmost: chrome,
    cursor: { x: 50, y: 50 },
    lines: ['Careers'],
    tree: [{ role: 'AXWindow', title: chrome.title, focused: true, frame: chrome.bounds, children: [
      { role: 'AXWebArea', title: 'Careers', frame: { x: 0, y: 120, width: 1920, height: 866 }, children: [
        area('AXTextArea', 'AF7', { x: 742, y: 300, width: 721, height: 120 }),
        area('AXTextArea', 'AF8', { x: 742, y: 600, width: 721, height: 120 }, { focused: true }),
        area('AXTextArea', 'AF10', { x: 742, y: 985, width: 721, height: 1 }, { visibleFrame: { x: 742, y: 700, width: 721, height: 120 } }),
        area('AXLink', 'Edit about', { x: 1000, y: 985, width: 265, height: 1 }, { visibleFrame: { x: 1000, y: 840, width: 265, height: 20 } }),
        area('AXTextArea', 'AF11', { x: 742, y: 985, width: 100, height: 1 }, { visibleFrame: { x: 742, y: 500, width: 100, height: 40 } }),
        area('AXTextArea', 'AF12', { x: 742, y: 985, width: 100, height: 1 }, { visibleFrame: { x: 742, y: 560, width: 100, height: 40 } }),
        area('AXTextArea', 'DragEnd', { x: 742, y: 985, width: 100, height: 1 }, { visibleFrame: { x: 742, y: 620, width: 100, height: 40 } }),
        area('AXTextArea', 'Tall', { x: 20, y: 100, width: 600, height: 900 }),
        area('AXButton', 'Footer', { x: 742, y: 966, width: 100, height: 20 }),
        area('AXButton', 'Header', { x: 742, y: 120, width: 100, height: 1 }),
        area('AXButton', 'Stuck', { x: 742, y: 985, width: 100, height: 1 }, { actions: [], wheel: false }),
        { role: 'AXCheckBox (AXSwitch)', title: 'Review producer notes', frame: { x: 1500, y: 300, width: 40, height: 24 } },
        { role: 'AXStaticText', value: 'Studio', frame: { x: 1700, y: 360, width: 60, height: 20 } },
        { role: 'AXGroup', title: 'Studio', frame: { x: 1700, y: 400, width: 200, height: 500 }, children: [
          area('AXButton', 'Review', { x: 1750, y: 420, width: 80, height: 24 }),
          area('AXButton', 'Review', { x: 1750, y: 899, width: 80, height: 1 }, { visibleFrame: { x: 1750, y: 600, width: 80, height: 24 } }),
          area('AXButton', 'Review', { x: 1750, y: 899, width: 80, height: 1 }, { visibleFrame: { x: 1750, y: 640, width: 80, height: 24 } }),
        ] },
      ] },
    ] }],
  }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = far
  resetDesktopDriverForTest()
  const page = resolveDesktopDriver()
  if (page.state !== 'ok') throw new Error(page.note)
  const chromeDriver = page.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  context = toolContext()
  session.forgetDesktopOwner(ownerOf(context))
  const clicks = () => chromeDriver.acts.filter(a => a.act === 'click').map(a => JSON.stringify(a.detail.at))
  const scrolls = () => chromeDriver.acts.filter(a => a.act === 'scrollToVisible').length
  const clamped = await call({ action: 'click', target: { role: 'AXTextArea', name: 'AF10' }, capture: false })
  check('a 1 pt strip is scrolled into view and clicked at the frame it then has, and the words say so', clamped.outcome === 'succeeded' && clamped.result.includes('AF10') && clamped.result.includes('scrolled into view first (action)') && clicks().at(-1) === JSON.stringify({ x: 1102.5, y: 760 }) && scrolls() === 1, clamped.result)
  const found = await call({ action: 'find', target: { role: 'AXLink', name: 'Edit about' } })
  const ref = Number(/\[(\d+)\] AXLink "Edit about"/.exec(found.result)?.[1])
  const byRef = await call({ action: 'click', ref, capture: false })
  check('the ref road scrolls the same way and clicks the visible frame', found.outcome === 'succeeded' && byRef.outcome === 'succeeded' && byRef.result.includes('scrolled into view first (action)') && clicks().at(-1) === JSON.stringify({ x: 1132.5, y: 850 }), byRef.result)
  const header = await call({ action: 'click', target: { role: 'AXButton', name: 'Header' }, capture: false })
  check('a strip that stays a strip after the scroll is refused honestly, with the next move named, and never clicked', header.outcome === 'failed' && header.result.includes('squashed to a strip 1 pt tall') && header.result.includes('was scrolled (action) and is still clipped: the target is squashed to a strip') && header.result.includes('collapsed or covered: take a screenshot') && clicks().length === 2, header.result)
  const stuck = await call({ action: 'click', target: { role: 'AXButton', name: 'Stuck' }, capture: false })
  check('a pane with no scroll action whose wheel moves nothing is refused as not scrolled, never clicked', stuck.outcome === 'failed' && stuck.result.includes('did not scroll into view') && stuck.result.includes('collapsed or covered') && clicks().length === 2, stuck.result)
  const dragged = await call({ action: 'drag', target: { role: 'AXTextArea', name: 'AF7' }, toTarget: { role: 'AXButton', name: 'Header' }, capture: false })
  check('a drag whose destination will not come into view is refused before any input', dragged.outcome === 'failed' && dragged.result.includes('was scrolled (action) and did not move') && !chromeDriver.acts.some(a => a.act === 'drag'), dragged.result)
  const tall = await call({ action: 'click', target: { role: 'AXTextArea', name: 'Tall' }, capture: false })
  check('an element clipped at both edges still clicks its centre without a scroll', tall.outcome === 'succeeded' && !tall.result.includes('scrolled into view') && clicks().at(-1) === JSON.stringify({ x: 320, y: 550 }), tall.result)
  const footer = await call({ action: 'click', target: { role: 'AXButton', name: 'Footer' }, capture: false })
  check('a 20-pt control touching the bottom edge still clicks without a scroll', footer.outcome === 'succeeded' && !footer.result.includes('scrolled into view') && clicks().at(-1) === JSON.stringify({ x: 792, y: 976 }), footer.result)
  const rooted = await call({ action: 'tree', root: { role: 'AXTextArea', name: 'AF10' } })
  check('the tree-root road is untouched by the edge rule', rooted.outcome === 'succeeded' && rooted.result.includes('AXTextArea "AF10"'), rooted.result)
  const read = await call({ action: 'read', target: { role: 'AXTextArea', name: 'AF10' } })
  check('read is untouched by the edge rule', read.outcome === 'succeeded', read.result)
  const reviews = await call({ action: 'find', target: { role: 'AXButton', name: 'Review' } })
  const refs = [...reviews.result.matchAll(/\[(\d+)\] AXButton "Review"/g)].map(m => Number(m[1]))
  check('three identical siblings, two of them squashed to the same strip, get three refs', reviews.outcome === 'succeeded' && refs.length === 3 && new Set(refs).size === 3, reviews.result)
  const second = await call({ action: 'click', ref: refs[1]!, capture: false })
  check('a ref to one of two identical strips resolves to that one alone, is scrolled into view and clicked at its own visible frame', second.outcome === 'succeeded' && !second.result.includes('match it now') && second.result.includes('scrolled into view first') && clicks().at(-1) === JSON.stringify({ x: 1790, y: 612 }), second.result)
  const stale = await call({ action: 'click', ref: refs[2]!, capture: false })
  check('after one strip was scrolled into view the list changed, so a ref to a remaining strip asks for a fresh find instead of acting on a shifted neighbour', stale.outcome === 'failed' && stale.result.includes('no element of the latest tree matches it now') && stale.result.includes('find again'), stale.result)
  const again = await call({ action: 'find', target: { role: 'AXButton', name: 'Review' } })
  const freshRefs = [...again.result.matchAll(/\[(\d+)\] AXButton "Review"/g)].map(m => Number(m[1]))
  const third = await call({ action: 'click', ref: freshRefs[2]!, capture: false })
  check('a fresh find gives the remaining strip its own ref, which scrolls and clicks its own visible frame', freshRefs.length === 3 && third.outcome === 'succeeded' && clicks().at(-1) === JSON.stringify({ x: 1790, y: 652 }), third.result)
  const nothing = await call({ action: 'find', target: { role: 'AXButton', name: 'No Such Button' } })
  const afterEmpty = await call({ action: 'click', ref: freshRefs[0]!, capture: false })
  check('a find that matched nothing keeps the refs the model holds', nothing.outcome === 'succeeded' && nothing.result.includes('0 elements') && afterEmpty.outcome === 'succeeded' && clicks().at(-1) === JSON.stringify({ x: 1790, y: 432 }), JSON.stringify({ nothing: nothing.outcome + ' ' + nothing.result.slice(0, 200), afterEmpty: afterEmpty.outcome + ' ' + afterEmpty.result.slice(0, 300) }))
  const noop = await call({ action: 'click', target: { role: 'AXTextArea', name: 'AF11' }, capture: false })
  check('the state line is read after the scroll, so a scrolled click that changed nothing reads unchanged', noop.outcome === 'succeeded' && /^unchanged · now:/m.test(noop.result) && noop.result.includes('scrolled into view first'), noop.result)
  const verified = await call({ action: 'click', target: { role: 'AXTextArea', name: 'AF12' }, verify: true, capture: false })
  check('verify after a scroll compares window trees: a no-op click reads no observed change', verified.outcome === 'succeeded' && verified.result.includes('scrolled into view first') && verified.result.includes('no observed change in the tree'), verified.result)
  const dragScrolled = await call({ action: 'drag', target: { role: 'AXTextArea', name: 'AF7' }, toTarget: { role: 'AXTextArea', name: 'DragEnd' }, capture: false })
  const lastDrag = chromeDriver.acts.filter(a => a.act === 'drag').at(-1)
  check('a drag whose destination was scrolled into view re-resolves both ends on the post-scroll tree and drags to the visible frame', dragScrolled.outcome === 'succeeded' && dragScrolled.result.includes('scrolled into view first') && JSON.stringify(lastDrag?.detail.to) === JSON.stringify({ x: 792, y: 640 }), `${dragScrolled.result} · ${JSON.stringify(lastDrag?.detail)}`)
  const wheel = await call({ action: 'scroll', target: { role: 'AXButton', name: 'Header' }, dy: 3, capture: false })
  check('a scroll act at a clipped target wheels where it was asked and never scrolls it into view first', wheel.outcome === 'succeeded' && !wheel.result.includes('scrolled into view') && !chromeDriver.acts.slice(-3).some(a => a.act === 'scrollToVisible'), wheel.result)
  const asSwitch = await call({ action: 'find', target: { role: 'AXSwitch' } })
  const asCheckBox = await call({ action: 'find', target: { role: 'AXCheckBox' } })
  check('a role with a subrole, "AXCheckBox (AXSwitch)", is found by either word', asSwitch.result.includes('AXCheckBox (AXSwitch) "Review producer notes"') && asCheckBox.result.includes('AXCheckBox (AXSwitch) "Review producer notes"'), `${asSwitch.result}\n${asCheckBox.result}`)
  const staticText = await call({ action: 'click', target: { role: 'AXStaticText', name: 'Studio' }, capture: false })
  check('a static text with no title is named by its value, as the candidate lines print it', staticText.outcome === 'succeeded' && clicks().at(-1) === JSON.stringify({ x: 1730, y: 370 }), staticText.result)
  const findApplication = chromeDriver.findApplication
  const activateApplication = chromeDriver.activateApplication
  chromeDriver.findApplication = async () => ({ ok: true, value: chrome })
  chromeDriver.activateApplication = async () => ({ ok: true, value: chrome })
  const focusedPlain = await call({ action: 'focusApp', focusApp: { name: 'Browser' } })
  check('focusApp without capture answers one line and no image', focusedPlain.outcome === 'succeeded' && focusedPlain.result.startsWith('focusApp: ') && !focusedPlain.result.includes('\n') && !focusedPlain.imagePath, focusedPlain.result)
  const focusedShot = await call({ action: 'focusApp', focusApp: { name: 'Browser' }, capture: true, settleMs: 10 })
  check('focusApp with capture brings the application forward and returns a screenshot after it settles', focusedShot.outcome === 'succeeded' && focusedShot.result.includes('focusApp: ') && !!focusedShot.imagePath, focusedShot.result)
  chromeDriver.findApplication = findApplication
  chromeDriver.activateApplication = activateApplication
  const scrollsBefore = () => chromeDriver.acts.filter(a => a.act === 'scrollToVisible').length
  await claim.releaseDesktopClaim()
  const lockPath = claim.desktopClaimPath()
  const foreign = await acquirePidLock(lockPath, 'other-session:proof', { liveness: 'assume-dead' })
  const before = scrollsBefore()
  const held = await call({ action: 'click', target: { role: 'AXTextArea', name: 'AF10' }, capture: false })
  check("another session's claim refuses the act before any scroll", foreign.held && held.outcome === 'failed' && held.result.includes('another session is driving the desktop') && scrollsBefore() === before, `${held.result} · scrolls ${before} → ${scrollsBefore()}`)
  await releasePidLock(lockPath, 'other-session:proof')
  const denied = toolContext({ deny: ['Computer(captcha)'] })
  session.forgetDesktopOwner(ownerOf(denied))
  const robotScene = join(scratch, 'robot.json')
  writeFileSync(robotScene, JSON.stringify({
    displays: [{ index: 0, id: 'careers', originX: 0, originY: 0, width: 1920, height: 1080, scale: 2, primary: true }],
    frontmost: chrome, cursor: { x: 50, y: 50 }, lines: ['Careers'],
    tree: [{ role: 'AXWindow', title: chrome.title, focused: true, frame: chrome.bounds, children: [{ role: 'AXWebArea', title: 'Careers', frame: { x: 0, y: 120, width: 1920, height: 866 }, children: [
      area('AXTextArea', 'Comments', { x: 742, y: 300, width: 721, height: 120 }),
      area('AXCheckBox', "I'm not a robot", { x: 742, y: 985, width: 304, height: 1 }, { visibleFrame: { x: 742, y: 700, width: 304, height: 78 } }),
    ] }] }],
  }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = robotScene
  resetDesktopDriverForTest()
  const robotPage = resolveDesktopDriver()
  if (robotPage.state !== 'ok') throw new Error(robotPage.note)
  const robotDriver = robotPage.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  const robot = resultOf(await ComputerTool.call({ action: 'click', target: { role: 'AXCheckBox', name: "I'm not a robot" }, capture: false } as never, denied, allowEverything, toolUseTurn('fast-robot', 'Computer', {})))
  check('a challenge checkbox squashed below the fold is a challenge: the deny rule refuses it before any scroll or click', robot.outcome === 'failed' && robot.result.includes('Computer(captcha)') && !robotDriver.acts.some(a => a.act === 'scrollToVisible' || a.act === 'click'), `${robot.result} · acts ${robotDriver.acts.map(a => a.act).join(',')}`)
  session.forgetDesktopOwner(ownerOf(denied))
  const allowing = toolContext()
  session.forgetDesktopOwner(ownerOf(allowing))
  resetDesktopDriverForTest()
  const allowedPage = resolveDesktopDriver()
  if (allowedPage.state !== 'ok') throw new Error(allowedPage.note)
  const allowedDriver = allowedPage.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  const allowed = resultOf(await ComputerTool.call({ action: 'click', target: { role: 'AXCheckBox', name: "I'm not a robot" }, capture: false } as never, allowing, allowEverything, toolUseTurn('fast-robot-allowed', 'Computer', {})))
  check('a clipped challenge the operator allows is scrolled into view once and clicked', allowed.outcome === 'succeeded' && allowed.result.includes('scrolled into view first') && allowedDriver.acts.filter(a => a.act === 'scrollToVisible').length === 1 && allowedDriver.acts.some(a => a.act === 'click'), `${allowed.result} · acts ${allowedDriver.acts.map(a => a.act).join(',')}`)
  session.forgetDesktopOwner(ownerOf(allowing))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = far
  resetDesktopDriverForTest()
  const prompt = await ComputerTool.prompt()
  check('the tool\'s words teach fill and fields', prompt.includes('fill (target/ref) sets the value and reads it back') && prompt.includes('fields lists the controls') && JSON.stringify(ComputerTool.inputJSONSchema).includes('type or fill:'), prompt)
  session.forgetDesktopOwner(ownerOf(context))
}
section('a ref remembers its place in the list, one level up too; a one-step sequence over a scrolled no-op reads unchanged')
{
  const chrome = { identity: 'com.example.Browser', name: 'Browser', pid: 4242, windowId: 'rows', title: 'Rows — Example', bounds: { x: 0, y: 30, width: 1920, height: 956 } }
  const rowsScene = (rows: number) => ({
    displays: [{ index: 0, id: 'rows', originX: 0, originY: 0, width: 1920, height: 1080, scale: 2, primary: true }],
    frontmost: chrome, cursor: { x: 50, y: 50 }, lines: ['Rows'],
    tree: [{ role: 'AXWindow', title: chrome.title, focused: true, frame: chrome.bounds, children: [{ role: 'AXWebArea', title: 'Rows', frame: { x: 0, y: 120, width: 1920, height: 866 }, children: [
      ...Array.from({ length: rows }, (_, index) => ({ role: 'AXGroup', frame: { x: 100, y: 200 + index * 60, width: 800, height: 50 }, children: [{ role: 'AXButton', title: 'Delete', frame: { x: 800, y: 210 + index * 60, width: 80, height: 30 } }] })),
      { role: 'AXTextArea', title: 'AF13', frame: { x: 742, y: 985, width: 100, height: 1 }, visibleFrame: { x: 742, y: 700, width: 100, height: 40 } },
    ] }] }],
  })
  const rowsFile = join(scratch, 'rows.json')
  writeFileSync(rowsFile, JSON.stringify(rowsScene(3)))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = rowsFile
  resetDesktopDriverForTest()
  const page = resolveDesktopDriver()
  if (page.state !== 'ok') throw new Error(page.note)
  context = toolContext()
  session.forgetDesktopOwner(ownerOf(context))
  const found = await call({ action: 'find', target: { role: 'AXButton', name: 'Delete' } })
  const refs = [...found.result.matchAll(/\[(\d+)\] AXButton "Delete"/g)].map(m => Number(m[1]))
  check('three Delete buttons in three untitled rows get three refs', found.outcome === 'succeeded' && refs.length === 3, found.result)
  writeFileSync(rowsFile, JSON.stringify(rowsScene(2)))
  resetDesktopDriverForTest()
  const shifted = resolveDesktopDriver()
  if (shifted.state !== 'ok') throw new Error(shifted.note)
  const rowsDriver = shifted.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  const stale = await call({ action: 'click', ref: refs[1]!, capture: false })
  check("after the first row disappeared, the second row's ref is refused (its place in the list moved one level up), never clicking the row now in its place", stale.outcome === 'failed' && stale.result.includes('find again') && !rowsDriver.acts.some(a => a.act === 'click'), `${stale.result} · acts ${rowsDriver.acts.map(a => a.act).join(',')}`)
  const sequence = await call({ action: 'sequence', steps: [{ action: 'click', target: { role: 'AXTextArea', name: 'AF13' } }], capture: false })
  check('a one-step sequence whose click scrolled its target into view and changed nothing else reads unchanged', sequence.outcome === 'succeeded' && /^unchanged · now:/m.test(sequence.result) && sequence.result.includes('scrolled into view first'), sequence.result)
  writeFileSync(rowsFile, JSON.stringify({ ...rowsScene(2), tree: [{ role: 'AXWindow', title: chrome.title, focused: true, frame: chrome.bounds, children: [{ role: 'AXWebArea', title: 'Rows', frame: { x: 0, y: 120, width: 1920, height: 866 }, focused: true, children: [
    { role: 'AXButton', title: 'Count', frame: { x: 742, y: 985, width: 100, height: 1 }, visibleFrame: { x: 742, y: 700, width: 100, height: 40 }, focusOnClick: true },
  ] }] }] }))
  resetDesktopDriverForTest()
  const focusing = resolveDesktopDriver()
  if (focusing.state !== 'ok') throw new Error(focusing.note)
  const focusSequence = await call({ action: 'sequence', steps: [{ action: 'click', target: { role: 'AXButton', name: 'Count' } }, { action: 'wait', durationMs: 50 }], capture: false })
  check('a sequence whose scrolled click moved the focus to the button reads changed (the scroll alone is not the change, the focus is)', focusSequence.outcome === 'succeeded' && /^changed · now:/m.test(focusSequence.result) && focusSequence.result.includes('scrolled into view first'), focusSequence.result)
  session.forgetDesktopOwner(ownerOf(context))
}
section("a Windows-shaped tree: the window's own off-screen report is the clipped signal; a frame inside the window but past the display's edge is refused, never clicked")
{
  const chrome = { identity: 'chrome.exe', name: 'chrome', pid: 4343, windowId: 'parity', title: 'Parity — Chrome', bounds: { x: 0, y: 75, width: 1750, height: 1102 } }
  const paneScene = {
    displays: [{ index: 0, id: 'box', originX: 0, originY: 0, width: 1920, height: 1080, scale: 1, primary: true }],
    frontmost: chrome, cursor: { x: 50, y: 50 }, lines: ['Parity'],
    tree: [{ role: 'AXWindow', title: chrome.title, focused: true, frame: chrome.bounds, children: [{ role: 'AXWebArea', title: 'Parity', frame: { x: 0, y: 195, width: 1750, height: 982 }, children: [
      { role: 'AXStaticText', title: 'Row 1 of the long list', frame: { x: 300, y: 300, width: 187, height: 28 } },
      { role: 'AXButton', title: 'Copy', frame: { x: 900, y: 300, width: 60, height: 28 } },
      { role: 'AXStaticText', title: 'Row 9 of the long list', frame: { x: 300, y: 738, width: 187, height: 28 }, offscreen: true, visibleFrame: { x: 300, y: 420, width: 187, height: 28 } },
      { role: 'AXButton', title: 'Copy', frame: { x: 900, y: 738, width: 60, height: 28 }, offscreen: true },
      { role: 'AXStaticText', title: 'Row 40 of the long list', frame: { x: 300, y: 800, width: 187, height: 28 }, offscreen: true },
      { role: 'AXButton', title: 'Copy', frame: { x: 900, y: 800, width: 60, height: 28 }, offscreen: true },
      { role: 'AXButton', title: 'Open below', frame: { x: 546, y: 1200, width: 81, height: 42 }, visibleFrame: { x: 546, y: 1084, width: 81, height: 42 } },
      { role: 'AXButton', title: 'Open low', frame: { x: 546, y: 1105, width: 81, height: 42 } },
    ] }] }],
  }
  const paneFile = join(scratch, 'pane.json')
  writeFileSync(paneFile, JSON.stringify(paneScene))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = paneFile
  resetDesktopDriverForTest()
  const page = resolveDesktopDriver()
  if (page.state !== 'ok') throw new Error(page.note)
  const paneDriver = page.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  context = toolContext()
  session.forgetDesktopOwner(ownerOf(context))
  const listed = await call({ action: 'find', target: { role: 'AXStaticText', text: 'Row 9 of the long list' } })
  check('a find names the row the window reports off screen', listed.outcome === 'succeeded' && /AXStaticText "Row 9 of the long list" \(scrolled out of view\)/.test(listed.result), listed.result)
  const row = await call({ action: 'click', target: { role: 'AXStaticText', text: 'Row 9 of the long list' }, capture: false })
  const rowClick = paneDriver.acts.filter(a => a.act === 'click').at(-1)
  check('a row with an unclipped frame inside the window that its window reports off screen is scrolled into view and clicked where it lands', row.outcome === 'succeeded' && row.result.includes('scrolled into view first (action)') && JSON.stringify(rowClick?.detail.at ?? { x: rowClick?.detail.x, y: rowClick?.detail.y }).includes('434'), `${row.result} · ${JSON.stringify(rowClick?.detail)}`)
  const clicksBefore = paneDriver.acts.filter(a => a.act === 'click').length
  const stuck = await call({ action: 'click', target: { role: 'AXStaticText', text: 'Row 40 of the long list' }, capture: false })
  check('a row still reported off screen after the scroll is refused with the next move named, nothing clicked', stuck.outcome === 'failed' && stuck.result.includes('the target is scrolled out of view (its window reports it off screen); it was scrolled (action) and did not move') && stuck.result.includes('take a screenshot') && paneDriver.acts.filter(a => a.act === 'click').length === clicksBefore, stuck.result)
  const below = await call({ action: 'click', target: { role: 'AXButton', name: 'Open below' }, capture: false })
  check("a target scrolled to a frame inside the window but below the display's edge is refused with the window named, nothing clicked", below.outcome === 'failed' && below.result.includes("below the display's edge") && below.result.includes('move or resize the window so the target lies on the screen') && paneDriver.acts.filter(a => a.act === 'click').length === clicksBefore, below.result)
  const low = await call({ action: 'click', target: { role: 'AXButton', name: 'Open low' }, capture: false })
  check("a target already inside the window but off the display is refused before any click", low.outcome === 'failed' && low.result.includes("below the display's edge (0 pt visible; the window extends past the screen); it was scrolled (action) and did not move") && paneDriver.acts.filter(a => a.act === 'click').length === clicksBefore, low.result)
  session.forgetDesktopOwner(ownerOf(context))
}
section("two displays and a work area: a target on the second screen is clicked where windows span displays and refused where they do not; one over the taskbar strip is refused unless the window covers its display; a scroll past the screen wheels at the window's nearest point on it; the window's clickable point aims the click")
{
  const chrome = { identity: 'chrome.exe', name: 'chrome', pid: 4444, windowId: 'wide', title: 'Wide — Chrome', bounds: { x: 500, y: 75, width: 2000, height: 1000 } }
  const wideScene = {
    displays: [
      { index: 0, id: 'left', originX: 0, originY: 0, width: 1920, height: 1080, scale: 1, primary: true, work: { x: 0, y: 0, width: 1920, height: 1030 } },
      { index: 1, id: 'right', originX: 1920, originY: 0, width: 1920, height: 1080, scale: 1, primary: false, work: { x: 1920, y: 0, width: 1920, height: 1030 } },
    ],
    frontmost: chrome, cursor: { x: 50, y: 50 }, lines: ['Wide'],
    tree: [{ role: 'AXWindow', title: chrome.title, focused: true, frame: chrome.bounds, children: [{ role: 'AXWebArea', title: 'Wide', frame: { x: 500, y: 195, width: 2000, height: 880 }, children: [
      { role: 'AXButton', title: 'Far right', frame: { x: 2300, y: 300, width: 100, height: 40 } },
      { role: 'AXButton', title: 'Under the taskbar', frame: { x: 1200, y: 1035, width: 100, height: 40 } },
      { role: 'AXStaticText', title: 'Row under the taskbar', frame: { x: 1200, y: 1040, width: 300, height: 28 } },
      { role: 'AXButton', title: 'Aimed', frame: { x: 1300, y: 400, width: 200, height: 40 }, clickablePoint: { x: 1320, y: 435 } },
      { role: 'AXButton', title: 'Pointless', frame: { x: 1300, y: 500, width: 200, height: 40 }, clickablePoint: null },
    ] }] }],
  }
  const wideFile = join(scratch, 'wide.json')
  writeFileSync(wideFile, JSON.stringify(wideScene))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = wideFile
  resetDesktopDriverForTest()
  const page = resolveDesktopDriver()
  if (page.state !== 'ok') throw new Error(page.note)
  const wideDriver = page.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  context = toolContext()
  session.forgetDesktopOwner(ownerOf(context))
  const clicks = () => wideDriver.acts.filter(a => a.act === 'click')
  const far = await call({ action: 'click', target: { role: 'AXButton', name: 'Far right' }, capture: false })
  check("a target on the second display of a window spanning two screens is clicked where it is, with no scroll and no refusal", far.outcome === 'succeeded' && !far.result.includes('scrolled into view') && clicks().length === 1 && !wideDriver.acts.some(a => a.act === 'scrollToVisible'), `${far.result} · ${wideDriver.acts.map(a => a.act).join(',')}`)
  const taskbar = await call({ action: 'click', target: { role: 'AXButton', name: 'Under the taskbar' }, capture: false })
  check("a target centred over the taskbar strip (inside the display, outside its work area) is refused with the display's edge named, nothing clicked", taskbar.outcome === 'failed' && taskbar.result.includes("below the display's edge") && clicks().length === 1, taskbar.result)
  const wheel = await call({ action: 'scroll', target: { role: 'AXStaticText', text: 'Row under the taskbar' }, dy: 3, capture: false })
  const lastWheel = wideDriver.acts.filter(a => a.act === 'scroll').at(-1)
  check("a scroll pointed past the screen's edge wheels at the window's nearest point on the screen and says so", wheel.outcome === 'succeeded' && wheel.result.includes('wheeled at (1350, 1028) pt, the nearest point of the window on the screen') && (lastWheel?.detail.at as { y?: number } | undefined)?.y === 1028, `${wheel.result} · ${JSON.stringify(lastWheel?.detail)}`)
  const aimed = await call({ action: 'click', target: { role: 'AXButton', name: 'Aimed' }, capture: false })
  const aimedClick = clicks().at(-1)
  check("a click lands at the element's own clickable point when the window reports one off the frame's centre, and says so", aimed.outcome === 'succeeded' && aimed.result.includes('aimed at its clickable point') && JSON.stringify(aimedClick?.detail.at) === JSON.stringify({ x: 1320, y: 435 }), `${aimed.result} · ${JSON.stringify(aimedClick?.detail)}`)
  const pointless = await call({ action: 'click', target: { role: 'AXButton', name: 'Pointless' }, capture: false })
  const pointlessClick = clicks().at(-1)
  check("an element the window reports no clickable point for is clicked at its centre, with no aim words", pointless.outcome === 'succeeded' && !pointless.result.includes('aimed at') && JSON.stringify(pointlessClick?.detail.at) === JSON.stringify({ x: 1400, y: 520 }), `${pointless.result} · ${JSON.stringify(pointlessClick?.detail)}`)
  writeFileSync(wideFile, JSON.stringify({ ...wideScene, spanning: false }))
  resetDesktopDriverForTest()
  const oneAtATime = resolveDesktopDriver()
  if (oneAtATime.state !== 'ok') throw new Error(oneAtATime.note)
  const oneDriver = oneAtATime.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  const cut = await call({ action: 'click', target: { role: 'AXButton', name: 'Far right' }, capture: false })
  check("when windows show on one display at a time (macOS with separate Spaces), the target on the second display is refused as past the display's edge, nothing clicked", cut.outcome === 'failed' && cut.result.includes("the display's edge") && !oneDriver.acts.some(a => a.act === 'click'), cut.result)
  const full = { identity: 'chrome.exe', name: 'chrome', pid: 4445, windowId: 'full', title: 'Full — Chrome', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  const fullScene = {
    displays: [{ index: 0, id: 'only', originX: 0, originY: 0, width: 1920, height: 1080, scale: 1, primary: true, work: { x: 0, y: 0, width: 1920, height: 1030 } }],
    frontmost: full, cursor: { x: 50, y: 50 }, lines: ['Full'],
    tree: [{ role: 'AXWindow', title: full.title, focused: true, frame: full.bounds, children: [{ role: 'AXWebArea', title: 'Full', frame: full.bounds, children: [
      { role: 'AXButton', title: 'Play', frame: { x: 900, y: 1040, width: 120, height: 36 } },
    ] }] }],
  }
  const fullFile = join(scratch, 'full.json')
  writeFileSync(fullFile, JSON.stringify(fullScene))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = fullFile
  resetDesktopDriverForTest()
  const fullPage = resolveDesktopDriver()
  if (fullPage.state !== 'ok') throw new Error(fullPage.note)
  const fullDriver = fullPage.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  session.forgetDesktopOwner(ownerOf(context))
  const play = await call({ action: 'click', target: { role: 'AXButton', name: 'Play' }, capture: false })
  check("a window covering its whole display draws over the taskbar, so a control in that strip is clicked", play.outcome === 'succeeded' && fullDriver.acts.some(a => a.act === 'click'), `${play.result} · ${fullDriver.acts.map(a => a.act).join(',')}`)
  session.forgetDesktopOwner(ownerOf(context))
}
finish('prove-computer-fast-road')
