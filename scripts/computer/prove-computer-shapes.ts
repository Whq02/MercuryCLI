import { check, finish, section } from './computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/integrations/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
const { resolveDesktopDriver } = await import('../../src/integrations/desktop/resolveDriver.ts')
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
check('screenshot steps run in order with one returned image and honest accounting for the earlier saved shot', captured.outcome === 'succeeded' && captured.result.includes('3/3') && captured.imagePath !== undefined && captured.result.includes('images: 1 of 2 returned'), captured.result)
const explicitUnderNoFinal = await call({ action: 'sequence', steps: [{ action: 'screenshot' }, { action: 'key', key: 'Enter' }], capture: false })
check('sequence capture:false suppresses only the final capture while explicit screenshot steps still capture', explicitUnderNoFinal.outcome === 'succeeded' && explicitUnderNoFinal.imagePath !== undefined && !explicitUnderNoFinal.result.includes('images: 1 of'), explicitUnderNoFinal.result)
context = (await withScreenshot(ComputerTool as never, context, 'sequence-visible-frame')).context
const clicksBefore = driver.acts.filter(act => act.act === 'click').length
const capturesBefore = driver.acts.filter(act => act.act === 'capture').length
const checkpoint = await call({ action: 'sequence', steps: [{ action: 'screenshot', scale: 0.25 }, { action: 'click', x: 500, y: 400 }], settleMs: 0 })
const clicksAfter = driver.acts.filter(act => act.act === 'click').length
const capturesAfter = driver.acts.filter(act => act.act === 'capture').length
check('an intermediate screenshot never lends unseen pixels: a pixel step after it is refused before step 1 with the reason and nothing is clicked or captured', checkpoint.outcome === 'failed' && checkpoint.result.includes('click refused: the last screenshot was taken in this same message — you have not seen it; take the screenshot alone, then the region or the act') && clicksAfter === clicksBefore && capturesAfter === capturesBefore, `${checkpoint.result}; clicks ${clicksBefore} → ${clicksAfter}; captures ${capturesBefore} → ${capturesAfter}`)
check('the preflight-refused sequence returns no image and publishes no map', checkpoint.imagePath === undefined && checkpoint.screen === undefined && !checkpoint.result.includes('screenshot:'), checkpoint.result)
const failedAfterShot = await call({ action: 'sequence', steps: [{ action: 'screenshot', scale: 0.25 }, { action: 'click', target: { role: 'AXButton', name: 'Missing' } }], settleMs: 0 })
check("a mid-sequence failure after a shot returns no image and publishes no map: the step's screenshot line gives way to the not-returned words", failedAfterShot.outcome === 'failed' && failedAfterShot.imagePath === undefined && failedAfterShot.screen === undefined && !failedAfterShot.result.includes('screenshot:') && failedAfterShot.result.includes('screenshot taken by the step but not returned'), failedAfterShot.result)
const { createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
const unseenShot = await withScreenshot(ComputerTool as never, toolContext(), 'shapes-unseen-shot')
const sameMessage = createAssistantMessage({ content: [{ type: 'tool_use', id: unseenShot.toolUseId, name: 'Computer', input: { action: 'screenshot', full: true } }, { type: 'tool_use', id: 'shapes-unseen-act', name: 'Computer', input: { action: 'click', x: 10, y: 10 } }] as never })
const unseen = resultOf(await ComputerTool.call({ action: 'click', x: 10, y: 10, capture: false } as never, toolContext(), allowEverything, sameMessage as never))
check('a screenshot taken in this same message is not yet seen: the act is refused with the words that name the road', unseen.outcome === 'failed' && unseen.result.includes('taken in this same message — you have not seen it; take the screenshot alone, then the region or the act'), unseen.result)
const unseenRegion = resultOf(await ComputerTool.call({ action: 'screenshot', region: { x: 0, y: 0, width: 20, height: 20 } } as never, toolContext(), allowEverything, sameMessage as never))
check('a region of that unseen screenshot is refused with the same words', unseenRegion.outcome === 'failed' && unseenRegion.result.includes('taken in this same message'), unseenRegion.result)
const elsewhere = resultOf(await ComputerTool.call({ action: 'click', x: 10, y: 10, capture: false } as never, toolContext(), allowEverything, toolUseTurn('shapes-later-act', 'Computer', { action: 'click', x: 10, y: 10 }) as never))
check('a screenshot that left the conversation keeps its own words', elsewhere.outcome === 'failed' && elsewhere.result.includes('no longer in the conversation') && !elsewhere.result.includes('same message'), elsewhere.result)
section('E3: explicit pixels is accepted on capture-producing acts, focusApp and sequence while preserving terminal-text default and refusing non-capture paths')
{
  type ComputerInput = import('../../src/tools/computer/ComputerTool.ts').Input
  const runTyped = async (input: ComputerInput) => {
    const id = `shapes-e3-${++serial}`
    const parent = createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Computer', input }] })
    return resultOf(await ComputerTool.call(input, context, allowEverything, parent))
  }
  const caps = () => driver.acts.filter(a => a.act === 'capture').length
  const frontOrig = driver.frontmostApplication.bind(driver)
  const findOrig = driver.findApplication
  const activateOrig = driver.activateApplication
  const frontNow = await frontOrig()
  if (!frontNow.ok) throw new Error('missing fake frontmost')
  driver.findApplication = async () => ({ ok: true, value: { ...frontNow.value } })
  driver.activateApplication = async () => ({ ok: true, value: { ...frontNow.value } })

  const capBeforeClick = caps()
  const clickPixValid = await ComputerTool.validateInput!({ action: 'click', target, capture: true, pixels: true, settleMs: 0 }, context)
  const clickPix = await runTyped({ action: 'click', target, capture: true, pixels: true, settleMs: 0 })
  check('act with capture:true and pixels:true succeeds in one call with one capture', clickPixValid.result && clickPix.outcome === 'succeeded' && clickPix.imagePath !== undefined && caps() === capBeforeClick + 1, `${JSON.stringify(clickPixValid)} caps=${caps() - capBeforeClick}\n${clickPix.result}`)

  const capBeforeFocus = caps()
  const focusPixValid = await ComputerTool.validateInput!({ action: 'focusApp', focusApp: { name: 'TextEdit' }, capture: true, pixels: true, settleMs: 0 }, context)
  const focusPix = await runTyped({ action: 'focusApp', focusApp: { name: 'TextEdit' }, capture: true, pixels: true, settleMs: 0 })
  check('focusApp with capture:true and pixels:true succeeds in one call with one capture', focusPixValid.result && focusPix.outcome === 'succeeded' && focusPix.imagePath !== undefined && caps() === capBeforeFocus + 1, `${JSON.stringify(focusPixValid)} caps=${caps() - capBeforeFocus}\n${focusPix.result}`)

  const capBeforeSeq = caps()
  const seqPixValid = await ComputerTool.validateInput!({ action: 'sequence', steps: [{ action: 'key', key: 'Enter' }], pixels: true, settleMs: 0 }, context)
  const seqPix = await runTyped({ action: 'sequence', steps: [{ action: 'key', key: 'Enter' }], pixels: true, settleMs: 0 })
  check('sequence with implicit capture and pixels:true succeeds in one call with one capture', seqPixValid.result && seqPix.outcome === 'succeeded' && seqPix.imagePath !== undefined && caps() === capBeforeSeq + 1, `${JSON.stringify(seqPixValid)} caps=${caps() - capBeforeSeq}\n${seqPix.result}`)

  const rejectedInputs: ComputerInput[] = [
    { action: 'click', target, pixels: true },
    { action: 'click', target, capture: false, pixels: true },
    { action: 'focusApp', focusApp: { name: 'TextEdit' }, pixels: true },
    { action: 'focusApp', focusApp: { name: 'TextEdit' }, capture: false, pixels: true },
    { action: 'sequence', steps: [{ action: 'key', key: 'Enter' }], capture: false, pixels: true },
    { action: 'find', target, pixels: true },
    { action: 'read', target, pixels: true },
    { action: 'frontmost', pixels: true },
  ]
  const capBeforeRefused = caps()
  for (const input of rejectedInputs) {
    const verdict = await ComputerTool.validateInput!(input, context)
    check(`${input.action} refuses pixels when capture is absent or suppressed`, verdict.result === false && verdict.message.includes('pixels'), JSON.stringify(verdict))
  }
  check('no capture ran for refused pixels inputs', caps() === capBeforeRefused)

  if (process.platform === 'darwin') {
    const termApp = { ...frontNow.value, identity: 'com.apple.Terminal', name: 'Terminal' }
    let focusedTextReads = 0
    driver.frontmostApplication = async () => ({ ok: true, value: { ...termApp } })
    driver.findApplication = async () => ({ ok: true, value: { ...termApp } })
    driver.focusedText = async () => { focusedTextReads++; return { ok: true, value: { text: 'visible terminal text', title: 'shell', role: 'AXTextArea' } } }
    const termFocusDefault = await runTyped({ action: 'focusApp', focusApp: { name: 'Terminal' }, capture: true, settleMs: 0 })
    check('focusApp capture:true on a terminal preserves prior pixel output with zero terminal-text reads when pixels is omitted', termFocusDefault.outcome === 'succeeded' && termFocusDefault.imagePath !== undefined && focusedTextReads === 0, `focusedTextReads=${focusedTextReads}\n${termFocusDefault.result}`)
    const termFocusPixels = await runTyped({ action: 'focusApp', focusApp: { name: 'Terminal' }, capture: true, pixels: true, settleMs: 0 })
    check('focusApp capture:true with pixels:true on a terminal returns pixels with zero terminal-text reads', termFocusPixels.outcome === 'succeeded' && termFocusPixels.imagePath !== undefined && focusedTextReads === 0, `focusedTextReads=${focusedTextReads}\n${termFocusPixels.result}`)
    const termSeqDefault = await runTyped({ action: 'sequence', steps: [{ action: 'wait', durationMs: 0 }], settleMs: 0 })
    check('sequence implicit final capture on a terminal preserves prior pixel output with zero terminal-text reads when pixels is omitted', termSeqDefault.outcome === 'succeeded' && termSeqDefault.imagePath !== undefined && focusedTextReads === 0, `focusedTextReads=${focusedTextReads}\n${termSeqDefault.result}`)
    const termSeqPixels = await runTyped({ action: 'sequence', steps: [{ action: 'wait', durationMs: 0 }], pixels: true, settleMs: 0 })
    check('sequence implicit final capture with pixels:true on a terminal returns pixels with zero terminal-text reads', termSeqPixels.outcome === 'succeeded' && termSeqPixels.imagePath !== undefined && focusedTextReads === 0, `focusedTextReads=${focusedTextReads}\n${termSeqPixels.result}`)
    const standaloneTerm = await runTyped({ action: 'screenshot' })
    check('standalone screenshot preserves terminal-text default when pixels is omitted', standaloneTerm.outcome === 'succeeded' && standaloneTerm.imagePath === undefined && standaloneTerm.result.includes('visible terminal text') && focusedTextReads === 1, standaloneTerm.result)
    const terminal = await call({ action: 'sequence', steps: [{ action: 'screenshot' }] })
    check('explicit screenshot step preserves terminal-text default when pixels is omitted', terminal.outcome === 'succeeded' && !terminal.imagePath && terminal.result.includes('visible terminal text') && focusedTextReads === 2, terminal.result)
    const terminalPixels = await runTyped({ action: 'sequence', steps: [{ action: 'screenshot' }], pixels: true })
    check('sequence pixels:true overrides explicit screenshot step terminal-text default to return pixels', terminalPixels.outcome === 'succeeded' && terminalPixels.imagePath !== undefined && focusedTextReads === 2, terminalPixels.result)
  }
  driver.frontmostApplication = frontOrig
  driver.findApplication = findOrig
  driver.activateApplication = activateOrig
}
finish('prove-computer-shapes')
