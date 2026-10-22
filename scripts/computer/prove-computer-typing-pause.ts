import { check, finish } from './computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { markTypingActivity, __typingActivityResetForTest } = await import('../../src/utils/cockpit/typingActivity.ts')
resetDesktopDriverForTest()
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & { keyboardIdleMs?: () => Promise<number | null>; acts: { act: string }[] }
let context = toolContext()
let calls = 0
const input = { action: 'type', text: 'test', capture: false }
const call = async () => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`typing-${++calls}`, 'Computer', input)))
let idleReads = 0
driver.keyboardIdleMs = async () => ++idleReads < 3 ? 0 : 5000
const before = driver.acts.filter(a => a.act === 'typeText').length
const resumed = await call()
check('an act waits for native keyboard idle before typing', resumed.outcome === 'succeeded' && idleReads >= 3 && driver.acts.filter(a => a.act === 'typeText').length === before + 1, `${resumed.result}; idle reads ${idleReads}`)

process.env.MERCURY_COMPUTER_ACCESS = 'full'
driver.keyboardIdleMs = async () => 0
const beforeRefusal = driver.acts.filter(a => a.act === 'typeText').length
const refused = await call()
check('continuous typing refuses in full access too', refused.outcome === 'failed' && refused.result.includes('the operator is typing — nothing done; try again in a moment'), refused.result)
check('typing refusal sends no input', driver.acts.filter(a => a.act === 'typeText').length === beforeRefusal)

driver.keyboardIdleMs = async () => null
markTypingActivity()
let localWasActiveAtAct = false
const originalType = driver.typeText.bind(driver)
driver.typeText = async (...args) => {
  const { isTypingActive } = await import('../../src/utils/cockpit/typingActivity.ts')
  localWasActiveAtAct = isTypingActive()
  return originalType(...args)
}
const local = await call()
check('unknown native activity falls back to the local composer signal', local.outcome === 'succeeded' && !localWasActiveAtAct, local.result)
driver.typeText = originalType
__typingActivityResetForTest()
delete driver.keyboardIdleMs
const older = await call()
check('older drivers without idle reporting remain usable', older.outcome === 'succeeded', older.result)

const controller = new AbortController()
context = toolContext({ controller })
driver.keyboardIdleMs = async () => { controller.abort(); return 0 }
const aborted = await call()
check('interrupt ends the typing pause without input', aborted.outcome === 'failed' && /interrupted/.test(aborted.result), aborted.result)
delete process.env.MERCURY_COMPUTER_ACCESS

context = toolContext()
driver.keyboardIdleMs = async () => null
const originalTree = driver.accessibilityTree.bind(driver)
driver.accessibilityTree = async (...args) => {
  const result = await originalTree(...args)
  markTypingActivity()
  return result
}
const lateCount = driver.acts.filter(a => a.act === 'typeText').length
const late = await call()
check('typing that resumes during target checking is refused before input', late.outcome === 'failed' && late.result.includes('the operator is typing') && driver.acts.filter(a => a.act === 'typeText').length === lateCount, late.result)
driver.accessibilityTree = originalTree
__typingActivityResetForTest()

const { DESKTOP_ADDON_EXPORTS, loadDesktopAddon } = await import('../../src/services/desktop/pack.ts')
const { resolveNativeDesktopDriver } = await import('../../src/services/desktop/nativeDriver.ts')
const addon = loadDesktopAddon()
if (addon.state !== 'ok') {
  console.log(`  [SKIP] the rebuilt-pack rows drive the real desktop driver and this host has none (${addon.note}) — the hosted gate builds no desktop pack; the Mac pool and the release road read them`)
  finish('prove-computer-typing-pause')
}
const originalIdle = addon.addon.keyboardIdleMs
check('the rebuilt pack exposes idle without making it mandatory for older packs', typeof originalIdle === 'function' && !(DESKTOP_ADDON_EXPORTS as readonly string[]).includes('keyboardIdleMs'))
const native = resolveNativeDesktopDriver()
if (native.state !== 'ok') throw new Error(native.note)
try {
  addon.addon.keyboardIdleMs = () => 123
  check('native adapter carries the optional idle milliseconds', await native.driver.keyboardIdleMs?.() === 123)
  addon.addon.keyboardIdleMs = () => Number.NaN
  check('invalid native activity is unknown, not false typing', await native.driver.keyboardIdleMs?.() === null)
  addon.addon.keyboardIdleMs = () => { throw new Error('fixture unavailable') }
  check('unavailable native activity is unknown', await native.driver.keyboardIdleMs?.() === null)
  delete addon.addon.keyboardIdleMs
  check('an older addon without the optional export still resolves and answers unknown', resolveNativeDesktopDriver().state === 'ok' && await native.driver.keyboardIdleMs?.() === null)
} finally {
  if (originalIdle) addon.addon.keyboardIdleMs = originalIdle
}
finish('prove-computer-typing-pause')
