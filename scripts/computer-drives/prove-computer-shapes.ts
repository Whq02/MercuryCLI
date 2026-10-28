import { check, finish, section } from '../computer/computerProofKit.ts'
import { allowEverything, pointOfPixelOn, resultOf, toolContext, toolUseTurn, withScreenshot } from '../computer/computerToolKit.ts'
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
const opening = await withScreenshot(ComputerTool as never, context, 'sequence-visible-frame')
context = opening.context
const checkpoint = await call({ action: 'sequence', steps: [{ action: 'screenshot', scale: 0.25 }, { action: 'click', x: 500, y: 400 }], settleMs: 0 })
const expected = pointOfPixelOn(opening.screen, 500, 400)
const click = driver.acts.filter(act => act.act === 'click').at(-1)
check('an intermediate screenshot never silently remaps unseen pixels', checkpoint.outcome === 'succeeded' && JSON.stringify(click?.detail.at) === JSON.stringify(expected), `${checkpoint.result}; ${JSON.stringify(click)}`)
if (process.platform === 'darwin') {
  const frontmost = driver.frontmostApplication.bind(driver)
  driver.frontmostApplication = async () => { const front = await frontmost(); return front.ok ? { ok: true, value: { ...front.value, identity: 'com.apple.Terminal' } } : front }
  driver.focusedText = async () => ({ ok: true, value: { text: 'visible terminal text', title: 'shell', role: 'AXTextArea' } })
  const terminal = await call({ action: 'sequence', steps: [{ action: 'screenshot' }] })
  check('screenshot steps preserve the terminal text road', terminal.outcome === 'succeeded' && !terminal.imagePath && terminal.result.includes('visible terminal text'), terminal.result)
}
finish('prove-computer-shapes')
