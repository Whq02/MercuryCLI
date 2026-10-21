import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { forgetDesktopOwner } = await import('../../src/services/desktop/desktopSession.ts')
const { getImageProcessor } = await import('../../src/tools/FileReadTool/imageProcessor.ts')
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
await measure('click-settle', { action: 'click', target: { name: 'Save' }, settleMs: 300 })

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
const result = await call({ action: 'click', target: { name: 'Save' }, settleMs: 1000 })
const elapsed = performance.now() - started
check('settle identifies a stable target region', result.outcome === 'succeeded' && result.result.includes('target region stable'), result.result)
check('target settle uses two captures instead of the animation cap', reads === 2 && elapsed < 900, `${reads} captures, ${elapsed.toFixed(2)} ms`)
check('local settling keeps the full final screenshot', result.screen?.imageWidth === 400 && result.screen?.imageHeight === 300, JSON.stringify(result.screen))
rows.push({ operation: 'animated-target-settle', medianMs: +elapsed.toFixed(2), minMs: +elapsed.toFixed(2), maxMs: +elapsed.toFixed(2), samples: 1 })
driver.capture = original
const { desktopPackDirFor, readDesktopPackManifest } = await import('../../src/services/desktop/pack.ts')
const packDir = desktopPackDirFor(new URL('../..', import.meta.url).pathname)
const manifest = readDesktopPackManifest(packDir)
if (!manifest) throw new Error('build the desktop pack before measuring it')
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
