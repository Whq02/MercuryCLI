import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/integrations/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/integrations/desktop/resolveDriver.ts')
const { forgetDesktopOwner } = await import('../../src/integrations/desktop/desktopSession.ts')
const { getImageProcessor } = await import('../../src/platform/images/imageProcessor.ts')
const sharp = await getImageProcessor()
const scratch = scratchDir('latency')
const scene = join(scratch, 'scene.json')
writeFileSync(scene, JSON.stringify({ displays: [{ index: 0, id: 'latency', originX: 0, originY: 0, width: 400, height: 300, scale: 1, primary: true }], frontmost: { identity: 'com.example.Browser', name: 'Browser', pid: 456, title: 'Page', windowId: 'page', bounds: { x: 0, y: 0, width: 400, height: 300 } }, tree: [{ role: 'AXButton', title: 'Save', frame: { x: 180, y: 150, width: 40, height: 20 } }] }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolution = resolveDesktopDriver()
if (resolution.state !== 'ok') throw new Error(resolution.note)
const driver = resolution.driver as DesktopDriver
const context = toolContext()
forgetDesktopOwner(ownerOf(context))
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`latency-${++serial}`, 'Computer', input) as never))
const rows: { operation: string; medianMs: number; minMs: number; maxMs: number; samples: number }[] = []
async function measure(operation: string, input: Record<string, unknown>) {
  await call(input)
  const ms: number[] = []
  for (let n = 0; n < 5; n++) {
    const started = performance.now()
    const result = await call(input)
    check(`${operation} sample ${n + 1} succeeds`, result.outcome === 'succeeded', result.result)
    ms.push(performance.now() - started)
  }
  ms.sort((a, b) => a - b)
  rows.push({ operation, medianMs: +ms[2]!.toFixed(2), minMs: +ms[0]!.toFixed(2), maxMs: +ms[4]!.toFixed(2), samples: 5 })
  check(`${operation} completes below the five-second ceiling`, ms[4]! < 5000, JSON.stringify(ms))
}
section('isolated fake-driver round trips, warm median of five')
await measure('screenshot', { action: 'screenshot' })
await measure('tree', { action: 'tree' })
await measure('click-no-capture', { action: 'click', target: { name: 'Save' }, capture: false })
await measure('click-settle', { action: 'click', target: { name: 'Save' }, capture: true, settleMs: 300 })

section('animation outside the target does not consume the settle cap')
const original = driver.capture.bind(driver)
const captured = await original(0, context.abortController.signal)
if (!captured.ok) throw new Error(captured.error.note)
const frames = await Promise.all([20, 220].map(async value => {
  const rgba = Buffer.alloc(400 * 300 * 4, 255)
  for (let y = 0; y < 30; y++) for (let x = 0; x < 400; x++) rgba[(y * 400 + x) * 4] = value
  return sharp(rgba, { raw: { width: 400, height: 300, channels: 4 } }).png().toBuffer()
}))
let reads = 0
driver.capture = async () => ({ ok: true, value: { ...captured.value, png: frames[reads++ % 2]!, capturedAt: Date.now() } })
const started = performance.now()
const result = await call({ action: 'click', target: { name: 'Save' }, capture: true, settleMs: 1000 })
const elapsed = performance.now() - started
check('settle reports the after-state without target-stability prose', result.outcome === 'succeeded' && result.result.includes('unchanged · now: window "Page"') && !result.result.includes('target region stable'), result.result)
check('target settle uses two captures instead of the animation cap', reads === 2 && elapsed < 900, `${reads} captures, ${elapsed.toFixed(2)} ms`)
check('local settling keeps the whole window at its default half scale', result.screen?.pointWidth === 400 && result.screen?.pointHeight === 300 && result.screen?.imageWidth === 200 && result.screen?.imageHeight === 150, JSON.stringify(result.screen))
rows.push({ operation: 'animated-target-settle', medianMs: +elapsed.toFixed(2), minMs: +elapsed.toFixed(2), maxMs: +elapsed.toFixed(2), samples: 1 })
driver.capture = original

section('E1: sequence skips discarded per-step observation/report work while preserving fresh per-step guards')
{
  const { createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
  type ComputerInput = import('../../src/tools/computer/ComputerTool.ts').Input
  const runTyped = async (input: ComputerInput, ctx = context) => {
    const id = `latency-e1-${++serial}`
    const parent = createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Computer', input }] })
    return resultOf(await ComputerTool.call(input, ctx, allowEverything, parent))
  }
  const origFront = driver.frontmostApplication.bind(driver)
  const origTree = driver.accessibilityTree.bind(driver)
  const origDisplays = driver.displays.bind(driver)
  const origOwn = driver.ownTerminalApplication.bind(driver)
  const origPerms = driver.permissions.bind(driver)
  const origKeyTap = driver.keyTap.bind(driver)
  const counts = { front: 0, tree: 0, displays: 0, own: 0, perms: 0, keyTaps: 0 }
  let injectChallengeOnKey = 0
  driver.frontmostApplication = async () => { counts.front++; return origFront() }
  driver.accessibilityTree = async (...args) => {
    counts.tree++
    const res = await origTree(...args)
    if (res.ok && injectChallengeOnKey > 0 && counts.keyTaps >= injectChallengeOnKey) {
      return {
        ok: true,
        value: {
          ...res.value,
          elements: [...res.value.elements, { depth: 1, role: 'AXCheckBox', title: "I'm not a robot", value: null, frame: { x: 40, y: 40, width: 200, height: 60 } }],
        },
      }
    }
    return res
  }
  driver.displays = async () => { counts.displays++; return origDisplays() }
  driver.ownTerminalApplication = async (...args) => { counts.own++; return origOwn(...args) }
  driver.permissions = async () => { counts.perms++; return origPerms() }
  driver.keyTap = async (...args) => { counts.keyTaps++; return origKeyTap(...args) }

  const seqInput: ComputerInput = {
    action: 'sequence',
    steps: [
      { action: 'key', key: 'cmd+l' },
      { action: 'type', text: 'hello' },
      { action: 'key', key: 'Enter' },
      { action: 'key', key: 'Tab' },
      { action: 'key', key: 'PageDown' },
    ],
    capture: false,
    settleMs: 0,
  }
  const seq = await runTyped(seqInput)
  check('5-step simple sequence succeeds without discarded per-step observations, displays or duplicate checks', seq.outcome === 'succeeded' && seq.result.includes('sequence 5/5 completed') && counts.tree === 7 && counts.displays === 0 && counts.own === 15 && counts.perms === 1 && counts.front <= 36, JSON.stringify(counts))

  for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0
  const verified = await runTyped({
    action: 'sequence',
    steps: [{ action: 'key', key: 'Enter', verify: true }, { action: 'key', key: 'Tab' }],
    capture: false,
    settleMs: 0,
  })
  check('explicit step verify:true inside sequence still runs its post-act observation and tree diff', verified.outcome === 'succeeded' && verified.result.includes('no observed change in the tree') && counts.tree === 5, `counts=${JSON.stringify(counts)}\n${verified.result}`)

  for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0
  injectChallengeOnKey = 1
  const denyCaptcha = toolContext({ deny: ['Computer(captcha)'] })
  const challenged = await runTyped({
    action: 'sequence',
    steps: [{ action: 'key', key: 'Enter' }, { action: 'key', key: 'Tab' }],
    capture: false,
    settleMs: 0,
  }, denyCaptcha)
  injectChallengeOnKey = 0
  check('challenge appearing mid-sequence under an unchanged title is still caught before the next step acts', challenged.outcome === 'failed' && challenged.result.includes('Computer(captcha)') && counts.keyTaps === 1, `keyTaps=${counts.keyTaps}\n${challenged.result}`)
  forgetDesktopOwner(ownerOf(denyCaptcha))

  driver.frontmostApplication = origFront
  driver.accessibilityTree = origTree
  driver.displays = origDisplays
  driver.ownTerminalApplication = origOwn
  driver.permissions = origPerms
  driver.keyTap = origKeyTap
}

section('E2: focusApp skips activation for a proven already-front no-op while preserving switches, grants, capture and cancellation')
{
  const { createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
  const { appApproved } = await import('../../src/integrations/desktop/desktopSession.ts')
  const { WEB_CONTENT_NOTICE } = await import('../../src/tools/shell/webContent.ts')
  type ComputerInput = import('../../src/tools/computer/ComputerTool.ts').Input
  const origFront = driver.frontmostApplication.bind(driver)
  const origFind = driver.findApplication
  const origActivate = driver.activateApplication
  const browser = { identity: 'com.example.Browser', name: 'Browser', pid: 456, title: 'Page', windowId: 'page', bounds: { x: 0, y: 0, width: 400, height: 300 } }
  const editor = { identity: 'com.example.Editor', name: 'Editor', pid: 789, title: 'Doc', windowId: 'doc', bounds: { x: 0, y: 0, width: 400, height: 300 } }
  type DesktopApp = import('../../src/integrations/desktop/driver.ts').DesktopApplication
  let frontApp: DesktopApp = { ...browser }
  let foundApp: DesktopApp = { ...browser }
  let frontCalls = 0
  let activateCalls = 0
  driver.frontmostApplication = async () => { frontCalls++; return { ok: true, value: { ...frontApp } } }
  driver.findApplication = async () => ({ ok: true, value: { ...foundApp } })
  driver.activateApplication = async target => {
    activateCalls++
    frontApp = { ...target }
    return { ok: true, value: { ...target } }
  }
  const runFocus = async (input: ComputerInput, ctx = context) => {
    const id = `latency-e2-${++serial}`
    const parent = createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Computer', input }] })
    return resultOf(await ComputerTool.call(input, ctx, allowEverything, parent))
  }

  forgetDesktopOwner(ownerOf(context))
  frontCalls = 0
  activateCalls = 0
  const noop = await runFocus({ action: 'focusApp', focusApp: { name: 'Browser' } })
  check('already-front focusApp (same identity, pid, windowId) skips activation and redundant frontmost checks while granting the destination', noop.outcome === 'succeeded' && noop.result === 'focusApp: Browser — Page' && activateCalls === 0 && frontCalls === 1 && appApproved(ownerOf(context), browser.identity), `activate=${activateCalls} front=${frontCalls} result=${noop.result}`)

  frontCalls = 0
  activateCalls = 0
  const noopCaptureStart = performance.now()
  const noopCap = await runFocus({ action: 'focusApp', focusApp: { name: 'Browser' }, capture: true })
  const noopCapMs = performance.now() - noopCaptureStart
  check('already-front focusApp with capture:true skips activation and default switch settle while returning screenshot and untrusted notice', noopCap.outcome === 'succeeded' && noopCap.imagePath !== undefined && noopCap.result.startsWith(WEB_CONTENT_NOTICE) && activateCalls === 0 && noopCapMs < 250, `activate=${activateCalls} ms=${noopCapMs.toFixed(1)} result=${noopCap.result.slice(0, 120)}`)

  frontCalls = 0
  activateCalls = 0
  foundApp = { ...browser, pid: 999 }
  const swappedPid = await runFocus({ action: 'focusApp', focusApp: { name: 'Browser' } })
  check('swapped pid takes the full activation path', swappedPid.outcome === 'succeeded' && activateCalls === 1, `activate=${activateCalls} ${swappedPid.result}`)

  frontCalls = 0
  activateCalls = 0
  frontApp = { ...browser, windowId: 'win-a' }
  foundApp = { ...browser, windowId: 'win-b' }
  const swappedWin = await runFocus({ action: 'focusApp', focusApp: { name: 'Browser' } })
  check('swapped windowId takes the full activation path', swappedWin.outcome === 'succeeded' && activateCalls === 1, `activate=${activateCalls} ${swappedWin.result}`)

  frontCalls = 0
  activateCalls = 0
  frontApp = { ...browser }
  foundApp = { ...editor }
  const realSwitch = await runFocus({ action: 'focusApp', focusApp: { name: 'Editor' } })
  check('switching to another app activates it', realSwitch.outcome === 'succeeded' && activateCalls === 1 && realSwitch.result === 'focusApp: Editor — Doc', `activate=${activateCalls} ${realSwitch.result}`)

  const cancelController = new AbortController()
  cancelController.abort()
  const cancelCtx = toolContext({ controller: cancelController })
  frontApp = { ...browser }
  foundApp = { ...browser }
  activateCalls = 0
  const cancelled = await runFocus({ action: 'focusApp', focusApp: { name: 'Browser' } }, cancelCtx)
  check('cancelled already-front focusApp still fails as interrupted', cancelled.outcome === 'failed' && cancelled.result.includes('interrupted by the operator') && activateCalls === 0, cancelled.result)

  const checkCtx = toolContext()
  frontApp = { ...browser }
  foundApp = { ...browser }
  await ComputerTool.checkPermissions({ action: 'focusApp', focusApp: { name: 'Browser' } }, checkCtx)
  foundApp = { ...editor }
  activateCalls = 0
  const driftedDest = await runFocus({ action: 'focusApp', focusApp: { name: 'Browser' } }, checkCtx)
  check('destination identity drift since checkPermissions still refuses', driftedDest.outcome === 'failed' && driftedDest.result.includes('destination application changed') && activateCalls === 0, driftedDest.result)
  forgetDesktopOwner(ownerOf(checkCtx))

  driver.frontmostApplication = origFront
  driver.findApplication = origFind
  driver.activateApplication = origActivate
}

const { desktopPackDirFor, readDesktopPackManifest } = await import('../../src/integrations/desktop/pack.ts')
const packDir = desktopPackDirFor(fileURLToPath(new URL('../..', import.meta.url)))
const manifest = readDesktopPackManifest(packDir)
if (!manifest) {
  console.log(`  [SKIP] the pack-load rows measure the real desktop pack and this host has none (${packDir}) — the hosted gate builds no desktop pack; the Mac pool and the release road read them`)
  finish('prove-computer-latency')
}
const loads: number[] = []
for (let n = 0; n < 5; n++) {
  const measured = spawnSync('node', ['-e', 'const t=performance.now();const a=require(process.argv[1]);a.packVersion();console.log(performance.now()-t)', join(packDir, manifest.addon)], { encoding: 'utf8', env: process.env })
  const ms = Number(measured.stdout.trim())
  check(`native load/version sample ${n + 1} is measured without desktop input`, measured.status === 0 && Number.isFinite(ms) && ms < 5000, measured.stderr)
  loads.push(ms)
}
loads.sort((a, b) => a - b)
console.log(JSON.stringify({ fakeDriver: rows, nativePack: { sourceTreeDigest: manifest.sourceTreeDigest, loadAndVersionMedianMs: +loads[2]!.toFixed(2), minMs: +loads[0]!.toFixed(2), maxMs: +loads[4]!.toFixed(2) }, realDesktop: 'not run: no live desktop driving authorized' }, null, 2))
forgetDesktopOwner(ownerOf(context))
finish('prove-computer-latency')
