import { check, finish, section } from '../computer/computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn, withScreenshot } from '../computer/computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
let context = toolContext()
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`shapes-${++serial}`, 'Computer', input) as never))
const target = { role: 'AXButton', name: 'Bold' }
const shapes = [
  { action: 'click', target, capture: true, scale: 0.5, settleMs: 0 },
  { action: 'key', key: 'Enter', capture: true, scale: 0.5, settleMs: 0 },
  { action: 'key', key: 'Enter', capture: true, full: true, settleMs: 0 },
  { action: 'sequence', steps: [{ action: 'screenshot' }], settleMs: 0 },
  { action: 'tree', depth: 40 },
]
section('five research shape refusals become usable calls')
let refused = 0
for (const input of shapes) {
  const validated = await ComputerTool.validateInput!(input as never, context)
  if (!validated.result) refused++
  check(`${JSON.stringify(input)} is accepted`, validated.result, JSON.stringify(validated))
  const result = await call(input)
  check(`${input.action} completes`, result.outcome === 'succeeded', result.result)
}
console.log(`Research shapes refused: ${refused}/5`)
for (const input of [
  { action: 'hold', key: 'Shift', durationMs: 50 },
  { action: 'type', text: 'hello' },
  { action: 'move', target },
  { action: 'scroll', target, dy: 1 },
  { action: 'drag', target, toTarget: target },
]) {
  const result = await call({ ...input, capture: true, display: 0, full: true, scale: 0.25, settleMs: 0 })
  check(`${input.action} capture options reach the screenshot`, result.outcome === 'succeeded' && result.imagePath !== undefined && result.result.includes('native fraction 0.25'), result.result)
}
for (const input of [
  { action: 'click', target, scale: 0.5 },
  { action: 'type', text: 'hello', full: true, capture: false },
  { action: 'key', key: 'Enter', capture: true, display: -1 },
  { action: 'tree', depth: -1 },
  { action: 'tree', limit: 0 },
  { action: 'sequence', steps: [{ action: 'sequence', steps: [{ action: 'wait' }] }] },
]) {
  const result = await ComputerTool.validateInput!(input as never, context)
  check('invalid or unused fields still refuse', !result.result, JSON.stringify(input))
}
const originalTree = driver.accessibilityTree.bind(driver)
let limits: { depth: number; count: number } | undefined
driver.accessibilityTree = async (app, requested, signal) => { limits = requested; return originalTree(app, requested, signal) }
const clamped = await call({ action: 'tree', depth: 40, limit: 9000 })
check('the native call receives capped budgets', limits?.depth === 32 && limits.count === 2000, JSON.stringify(limits))
check('one note names both clamps', clamped.result.split('\n').filter(line => line.startsWith('clamped:')).join('\n') === 'clamped: depth 40 → 32; limit 9000 → 2000', clamped.result)
const captured = await call({ action: 'sequence', steps: [{ action: 'screenshot', full: true, scale: 0.25 }, { action: 'key', key: 'Enter' }, { action: 'screenshot' }], settleMs: 0 })
check('screenshot steps run in order with one result image', captured.outcome === 'succeeded' && captured.result.includes('3/3') && captured.imagePath !== undefined, captured.result)
const imageFree = await call({ action: 'sequence', steps: [{ action: 'screenshot' }, { action: 'key', key: 'Enter' }], capture: false })
check('sequence capture:false still overrides screenshots', imageFree.outcome === 'succeeded' && !imageFree.imagePath, imageFree.result)
context = (await withScreenshot(ComputerTool as never, context, 'sequence-visible-frame')).context
const clicksBefore = driver.acts.filter(act => act.act === 'click').length
const checkpoint = await call({ action: 'sequence', steps: [{ action: 'screenshot', scale: 0.25 }, { action: 'click', x: 500, y: 400 }], settleMs: 0 })
const clicksAfter = driver.acts.filter(act => act.act === 'click').length
check('an intermediate screenshot never lends unseen pixels: a pixel step after it is refused with the reason and nothing is clicked', checkpoint.outcome === 'failed' && checkpoint.result.includes('click refused: the last screenshot was taken in this same message — you have not seen it; take the screenshot alone, then the region or the act') && clicksAfter === clicksBefore, `${checkpoint.result}; clicks ${clicksBefore} → ${clicksAfter}`)
check("the refused sequence returns no image and publishes no map (an error answer travels as text alone): the step's screenshot line gives way to the not-returned words", checkpoint.imagePath === undefined && checkpoint.screen === undefined && !checkpoint.result.includes('screenshot:') && checkpoint.result.includes('screenshot taken by the step but not returned'), checkpoint.result)
const { createAssistantMessage } = await import('../../src/utils/messages.ts')
const unseenShot = await withScreenshot(ComputerTool as never, toolContext(), 'shapes-unseen-shot')
const sameMessage = createAssistantMessage({ content: [{ type: 'tool_use', id: unseenShot.toolUseId, name: 'Computer', input: { action: 'screenshot', full: true } }, { type: 'tool_use', id: 'shapes-unseen-act', name: 'Computer', input: { action: 'click', x: 10, y: 10 } }] as never })
const unseen = resultOf(await ComputerTool.call({ action: 'click', x: 10, y: 10, capture: false } as never, toolContext(), allowEverything, sameMessage as never))
check('a screenshot taken in this same message is not yet seen: the act is refused with the words that name the road', unseen.outcome === 'failed' && unseen.result.includes('taken in this same message — you have not seen it; take the screenshot alone, then the region or the act'), unseen.result)
const unseenRegion = resultOf(await ComputerTool.call({ action: 'screenshot', region: { x: 0, y: 0, width: 20, height: 20 } } as never, toolContext(), allowEverything, sameMessage as never))
check('a region of that unseen screenshot is refused with the same words', unseenRegion.outcome === 'failed' && unseenRegion.result.includes('taken in this same message'), unseenRegion.result)
const elsewhere = resultOf(await ComputerTool.call({ action: 'click', x: 10, y: 10, capture: false } as never, toolContext(), allowEverything, toolUseTurn('shapes-later-act', 'Computer', { action: 'click', x: 10, y: 10 }) as never))
check('a screenshot that left the conversation keeps its own words', elsewhere.outcome === 'failed' && elsewhere.result.includes('no longer in the conversation') && !elsewhere.result.includes('same message'), elsewhere.result)
if (process.platform === 'darwin') {
  const frontmost = driver.frontmostApplication.bind(driver)
  driver.frontmostApplication = async () => { const front = await frontmost(); return front.ok ? { ok: true, value: { ...front.value, identity: 'com.apple.Terminal' } } : front }
  driver.focusedText = async () => ({ ok: true, value: { text: 'visible terminal text', title: 'shell', role: 'AXTextArea' } })
  const terminal = await call({ action: 'sequence', steps: [{ action: 'screenshot' }] })
  check('screenshot steps preserve the terminal text road', terminal.outcome === 'succeeded' && !terminal.imagePath && terminal.result.includes('visible terminal text'), terminal.result)
}
finish('prove-computer-shapes')
