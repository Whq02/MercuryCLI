import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'
import type { DesktopDriver, DesktopTree } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { toOpenaiStrictToolSchema } = await import('../../src/utils/messages/toolSchemaDialect.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const app = { identity: 'com.example.Browser', name: 'Browser', pid: 123, windowId: 'front', title: 'Front', bounds: { x: 0, y: 0, width: 400, height: 300 } }
const button = { role: 'AXButton', title: 'Save', frame: { x: 180, y: 150, width: 40, height: 20 } }
let deep: object = button
for (let n = 0; n < 10; n++) deep = { role: 'AXGroup', children: [deep] }
const scene = join(scratchDir('round-two'), 'scene.json')
writeFileSync(scene, JSON.stringify({ displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 400, height: 300, scale: 1, primary: true }], frontmost: app, cursor: { x: 10, y: 10 }, tree: [
  { role: 'AXWindow', title: 'Other', children: [button] },
  { role: 'AXMenuBar', children: [{ role: 'AXMenu', children: [button] }] },
  { role: 'AXWindow', title: 'Front', focused: true, frame: app.bounds, children: [deep, { role: 'AXTextField', title: 'Search', value: 'ready', focused: true, frame: { x: 20, y: 20, width: 80, height: 20 } }, { role: 'AXWebArea', title: 'Page' }] },
] }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolution = resolveDesktopDriver()
if (resolution.state !== 'ok') throw new Error(resolution.note)
const driver = resolution.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
let context = toolContext()
session.forgetDesktopOwner(ownerOf(context))
let serial = 0
const call = async (input: Record<string, unknown>, broker = allowEverything) => resultOf(await ComputerTool.call(input as never, context, broker, toolUseTurn(`round-two-${++serial}`, 'Computer', input) as never))
const target = { name: 'Save' }

section('closed provider schema and per-step validation')
const schema = zodToJsonSchema(ComputerTool.inputSchema)
const strict = toOpenaiStrictToolSchema(schema)
check('Computer is strict-expressible, including steps', strict.strict, JSON.stringify(strict).slice(0, 200))
const { mapToolsToOpenai } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { stripNullArgs } = await import('../../src/services/providers/openai/openaiWire.ts')
const { declaredInputSchema } = await import('../../src/services/providers/local/schemaTyping.ts')
const wire = mapToolsToOpenai([{ name: 'Computer', description: 'fixture', input_schema: schema } as never])
check('the real Responses mapper sends Computer strict', wire[0]?.strict === true)
const nullable = stripNullArgs({ action: 'sequence', steps: [{ action: 'key', key: 'Enter', target: null, capture: null, steps: null }, { action: 'wait', until: { name: 'Search', role: null, text: null }, depth: null }], target: null }, declaredInputSchema(ComputerTool))
check('nullable strict step fields normalize through the real schema reader', ComputerTool.inputSchema.safeParse(nullable).success, JSON.stringify(nullable))
check('unknown keys in a sequence step are rejected', !ComputerTool.inputSchema.safeParse({ action: 'sequence', steps: [{ action: 'key', key: 'Enter', surprise: true }] }).success)
const nested = await call({ action: 'sequence', steps: [{ action: 'sequence', steps: [{ action: 'key', key: 'Enter' }] }] })
check('nested sequences remain refused before input', nested.outcome === 'failed' && !driver.acts.some(a => a.act === 'keyTap'), nested.result)

section('focused window budget, target reach, page and focus facts')
const tree = await call({ action: 'tree', depth: 32, limit: 100 })
check('default scope excludes other windows and closed menus', tree.outcome === 'succeeded' && !tree.result.includes('Other') && !tree.result.includes('AXMenu'), tree.result)
check('tree numbers the field with its value and names the scope', /\[\d+\] AXTextField "Search" "ready"/.test(tree.result) && tree.result.includes('scope window'), tree.result)
const clicked = await call({ action: 'click', target, capture: false, label: 'save' })
check('an act reaches the deep target without custom limits', clicked.outcome === 'succeeded', clicked.result)
check('the resolved centre is used', driver.acts.some(a => a.act === 'click' && JSON.stringify(a.detail.at) === JSON.stringify({ x: 200, y: 160 })))
const all = await call({ action: 'tree', scope: 'app', depth: 32 })
check('explicit app scope retains other windows without hidden menu wrappers', all.outcome === 'succeeded' && all.result.includes('Other') && !all.result.includes('AXMenu'), all.result)
const originalTree = driver.accessibilityTree.bind(driver)
const unchanged: DesktopTree = { elements: [{ depth: 0, role: 'AXButton', title: 'Save', value: null, frame: button.frame }], truncated: false, reason: null }
driver.accessibilityTree = async () => ({ ok: true, value: unchanged })
const missing = await call({ action: 'click', target: { name: 'Absent' }, capture: false })
check('missing target says 0 matches, not ambiguous', missing.outcome === 'failed' && missing.result.includes('0 matches') && !missing.result.includes('ambiguous'), missing.result)
driver.accessibilityTree = async () => ({ ok: true, value: { ...unchanged, elements: [...unchanged.elements, ...unchanged.elements] } })
const ambiguous = await call({ action: 'click', target, capture: false })
check('multiple targets say ambiguous with the count', ambiguous.outcome === 'failed' && ambiguous.result.includes('ambiguous') && ambiguous.result.includes('2 matches'), ambiguous.result)
driver.accessibilityTree = async () => ({ ok: true, value: { ...unchanged, webContent: 'absent', scope: 'window' } as DesktopTree })
const absentPage = await call({ action: 'find', target: { text: 'Unexposed page' } })
check('missing page content is distinguished from a missing element', absentPage.result.includes('exposes no page content'), absentPage.result)
const absentWait = await call({ action: 'wait', until: { text: 'Unexposed page' }, durationMs: 20, capture: false })
check('a timed-out page wait names missing page content', absentWait.outcome === 'failed' && absentWait.result.includes('exposes no page content'), absentWait.result)
const absentClick = await call({ action: 'click', target: { text: 'Unexposed page' }, capture: false })
check('a missing page target names the same screenshot remedy', absentClick.outcome === 'failed' && absentClick.result.includes('exposes no page content'), absentClick.result)

section('verification reports signals, never guesses business success or retries')
driver.accessibilityTree = async () => ({ ok: true, value: unchanged })
const before = driver.acts.filter(a => a.act === 'click').length
const verified = await call({ action: 'click', target, capture: false, verify: true })
check('unchanged tree is explicit and suggests a read', verified.outcome === 'succeeded' && verified.result.includes('no observed change') && verified.result.includes('screenshot'), verified.result)
check('verification never retries the click', driver.acts.filter(a => a.act === 'click').length === before + 1)
let reads = 0
driver.accessibilityTree = async () => ({ ok: true, value: ++reads === 1 ? unchanged : { ...unchanged, elements: [...unchanged.elements, { depth: 0, role: 'AXStaticText', title: 'Saved', value: null, frame: null }] } })
const changed = await call({ action: 'key', key: 'Enter', capture: false, verify: true, label: 'confirm' })
check('verification notices changed signals', changed.outcome === 'succeeded' && changed.result.includes('tree changed'), changed.result)
driver.accessibilityTree = originalTree

section('reads in sequences keep independent permissions and stopping')
const decisions: string[] = []
const broker = (async (_tool: unknown, input: Record<string, unknown>) => {
  const decision = await ComputerTool.checkPermissions(input as never, context)
  decisions.push(`${input.action}:${ComputerTool.isReadOnly(input as never)}`)
  return decision.behavior === 'deny' ? decision : { behavior: 'allow' }
}) as never
const mixed = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'wait', until: { name: 'Search' }, durationMs: 1000 }, { action: 'tree' }, { action: 'find', target: { name: 'Search' } }, { action: 'type', text: 'query' }, { action: 'key', key: 'Enter', label: 'submit' }, { action: 'wait', durationMs: 0 }], capture: false }, broker)
check('act/wait/tree/find/type/key/timed-wait sequence completes image-free', mixed.outcome === 'succeeded' && mixed.result.includes('7/7') && !mixed.imagePath, mixed.result)
check('each read remains read-only at its permission broker', decisions.join(',') === 'click:false,wait:true,tree:true,find:true,type:false,key:false,wait:true', decisions.join(','))
const beforeTimeout = driver.acts.filter(a => a.act === 'typeText').length
const timed = await call({ action: 'sequence', steps: [{ action: 'wait', until: { name: 'Absent' }, durationMs: 20 }, { action: 'type', text: 'never' }], capture: false })
check('a timed-out wait stops the sequence before typing', timed.outcome === 'failed' && timed.result.includes('0/2') && driver.acts.filter(a => a.act === 'typeText').length === beforeTimeout, timed.result)

section('region frame reminders and stable image scale')
const opened = await withScreenshot(ComputerTool as never, context, 'round-two-opening')
context = opened.context
const cropped = await withScreenshot(ComputerTool as never, context, 'round-two-crop', { action: 'screenshot', region: { x: 40, y: 40, width: 100, height: 60 } })
context = cropped.context
check('region result explicitly changes the coordinate frame', cropped.result.includes('coordinates now refer to this region') && cropped.result.includes('origin 40,40 pt') && cropped.result.includes('full screenshot'), cropped.result)
const outside = await call({ action: 'click', x: 120, y: 10, capture: false })
check('outside-region action repeats the frame remedy', outside.outcome === 'failed' && outside.result.includes('region') && outside.result.includes('full screenshot'), outside.result)
const full = await withScreenshot(ComputerTool as never, context, 'round-two-full')
context = full.context
check('returning to full screenshot announces changed coordinates', full.result.includes('previous coordinates do not apply'), full.result)
const scaleSource = readFileSync(new URL('../../src/tools/ComputerTool/ComputerTool.ts', import.meta.url), 'utf8')
check('screenshot preparation does not reuse content-dependent Read image shrinkage', !scaleSource.includes('readImageWithTokenBudget'))
const { FakeDesktopDriver, FAKE_SCENE_DEFAULT } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
const display = { index: 0, id: 'scale-proof', originX: 0, originY: 0, width: 1920, height: 1080, scale: 1, primary: true }
const plainDriver = new FakeDesktopDriver({ ...FAKE_SCENE_DEFAULT, displays: [display], noise: false }, null)
const noisyDriver = new FakeDesktopDriver({ ...FAKE_SCENE_DEFAULT, displays: [display], noise: true }, null)
const capture = driver.capture.bind(driver)
const displays = driver.displays.bind(driver)
driver.displays = () => plainDriver.displays()
driver.capture = (...args) => plainDriver.capture(...args)
const plainShot = await call({ action: 'screenshot' })
driver.capture = (...args) => noisyDriver.capture(...args)
const noisyShot = await call({ action: 'screenshot' })
check('different image complexity does not shrink the coordinate scale', plainShot.outcome === 'succeeded' && noisyShot.outcome === 'succeeded' && plainShot.screen?.imageWidth === noisyShot.screen?.imageWidth && plainShot.screen?.imageHeight === noisyShot.screen?.imageHeight, JSON.stringify([plainShot.screen, noisyShot.screen]))
check('the result states its pixel-to-point scale', noisyShot.result.includes('scale ') && noisyShot.result.includes('px/pt'), noisyShot.result)
driver.capture = capture
driver.displays = displays

section('headless policy is a denial, with a remedy, not a new grant')
const { getAskChannel, setAskChannel } = await import('../../src/bootstrap/state.ts')
const channel = getAskChannel()
setAskChannel('none')
const headless = toolContext({ interactive: false })
const validation = await ComputerTool.validateInput!({ action: 'screenshot' }, headless)
check('valid headless syntax reaches the policy stage', validation.result, JSON.stringify(validation))
const denied = await ComputerTool.checkPermissions({ action: 'screenshot' }, headless)
check('policy stage denies headless reads with the interactive remedy', denied.behavior === 'deny' && denied.message.includes('open an interactive session'), JSON.stringify(denied))
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
for (const mode of ['default', 'sovereign'] as const) {
  headless.getAppState().toolPermissionContext.mode = mode
  headless.getAppState().toolPermissionContext.isBypassPermissionsModeAvailable = true
  const verdict = await decideToolPermission(ComputerTool, { action: 'screenshot' }, headless)
  check(`${mode}: actual permission engine preserves the headless denial`, verdict.decision.behavior === 'deny', JSON.stringify(verdict.decision))
}
const attempted = await ComputerTool.call({ action: 'screenshot' }, headless)
check('direct calls retain the headless defence', attempted.data.outcome === 'failed' && attempted.data.result.includes('policy denial'), attempted.data.result)
setAskChannel(channel)
session.forgetDesktopOwner(ownerOf(context))
finish('prove-computer-round-two')
