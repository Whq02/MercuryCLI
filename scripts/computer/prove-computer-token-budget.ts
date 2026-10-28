import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, toolContext, toolResultTurn, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver, DesktopTree } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { forgetDesktopOwner } = await import('../../src/services/desktop/desktopSession.ts')
const { imageDimensionsFromHeader } = await import('../../src/tools/FileReadTool/imageProcessorJs.ts')
const scratch = scratchDir('token-budget')
const scene = join(scratch, 'scene.json')
writeFileSync(scene, JSON.stringify({
  displays: [{ index: 0, id: 'tokens', originX: -100, originY: 0, width: 1000, height: 800, scale: 2, primary: true }],
  frontmost: { identity: 'com.example.Editor', name: 'Terminal', pid: 42, title: 'Proof', windowId: 'proof', bounds: { x: 100, y: 80, width: 400, height: 300 } },
  tree: [{ role: 'AXWindow', frame: { x: 100, y: 80, width: 400, height: 300 }, children: [{ role: 'AXButton', title: 'Save', focused: true, frame: { x: 180, y: 140, width: 40, height: 20 } }] }],
}))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver
const context = toolContext()
forgetDesktopOwner(ownerOf(context))
let serial = 0
let captures = 0
const capture = driver.capture.bind(driver)
driver.capture = async (...args) => { captures++; return capture(...args) }
const rows: { shape: string; imageBytes: number; imagePixels: number; textChars: number; textTokenEstimate: number }[] = []
async function call(input: Record<string, unknown>) {
  const id = `tokens-${++serial}`
  const parent = toolUseTurn(id, 'Computer', input)
  const answer = await ComputerTool.call(input as never, context, allowEverything, parent as never)
  const output = answer.data
  context.messages.push(parent, toolResultTurn(ComputerTool.mapToolResultToToolResultBlockParam(output, id)))
  const bytes = output.imagePath ? readFileSync(output.inlinePath ?? output.imagePath) : Buffer.alloc(0)
  const header = imageDimensionsFromHeader(bytes)
  rows.push({ shape: input.action as string, imageBytes: bytes.length, imagePixels: header ? header.width * header.height : 0, textChars: output.result.length, textTokenEstimate: Math.ceil(output.result.length / 4) })
  return output
}
section('acts spend no image bytes unless asked; a sequence spends once')
const baseline = await call({ action: 'screenshot', display: 0 })
check('explicit display still captures the whole display', baseline.screen?.pointWidth === 1000 && baseline.screen?.originX === -100, baseline.result)
const acts = [
  { action: 'click', target: { name: 'Save' } }, { action: 'doubleClick', target: { name: 'Save' } },
  { action: 'rightClick', target: { name: 'Save' } }, { action: 'move', target: { name: 'Save' } },
  { action: 'drag', target: { name: 'Save' }, toTarget: { name: 'Save' } },
  { action: 'scroll', target: { name: 'Save' }, dy: 1 }, { action: 'type', text: 'proof' },
  { action: 'key', key: 'ArrowLeft' }, { action: 'hold', key: 'shift', durationMs: 50 },
]
for (const act of acts) {
  const before = captures
  const out = await call({ ...act, settleMs: 0 })
  check(`${act.action}: default returns words and focus, no image or capture`, out.outcome === 'succeeded' && !out.imagePath && captures === before && out.result.includes('now: window "Proof" · focus AXButton "Save"'), out.result)
}
const requested = await call({ action: 'click', target: { name: 'Save' }, capture: true, settleMs: 0 })
check('capture:true attaches an image', requested.outcome === 'succeeded' && !!requested.imagePath, requested.result)
let before = captures
const sequence = await call({ action: 'sequence', steps: [{ action: 'click', target: { name: 'Save' } }, { action: 'wait', until: { name: 'Save' }, durationMs: 1000 }, { action: 'type', text: 'proof' }], settleMs: 0 })
check('sequence has exactly one final capture, including its wait-until', sequence.outcome === 'succeeded' && !!sequence.imagePath && captures === before + 1, `${captures - before}: ${sequence.result}`)
before = captures
const silentSequence = await call({ action: 'sequence', steps: [{ action: 'type', text: 'proof' }], capture: false })
check('sequence capture:false suppresses its final image', silentSequence.outcome === 'succeeded' && !silentSequence.imagePath && captures === before)
const wait = await call({ action: 'wait', durationMs: 0 })
check('plain wait returns words', wait.outcome === 'succeeded' && !wait.imagePath, wait.result)
const until = await call({ action: 'wait', durationMs: 1000, until: { name: 'Save' } })
check('matched wait-until returns an image', until.outcome === 'succeeded' && !!until.imagePath, until.result)
const timeout = await call({ action: 'wait', durationMs: 1, until: { name: 'Missing' } })
check('unmatched wait returns no image', timeout.outcome === 'failed' && !timeout.imagePath)

section('window, scaling and nested region coordinates are the real image coordinates')
const window = await call({ action: 'screenshot' })
check('window crop records its origin and half-native image', window.screen?.originX === 100 && window.screen.originY === 80 && window.screen.pointWidth === 400 && window.screen.pointHeight === 300 && window.screen.imageWidth === 400 && window.screen.imageHeight === 300, window.result)
const clicked = await call({ action: 'click', x: 100, y: 70 })
const cursor = await driver.cursor()
check('cropped screenshot pixel (100,70) lands at display point (200,150)', clicked.outcome === 'succeeded' && cursor.ok && cursor.value.x === 200 && cursor.value.y === 150, clicked.result)
const scaled = await call({ action: 'screenshot', scale: 0.25 })
const scaledHeader = scaled.imagePath ? imageDimensionsFromHeader(readFileSync(scaled.inlinePath ?? scaled.imagePath)) : null
check('scale is honoured in the image header and px/pt words', scaledHeader?.width === 200 && scaledHeader.height === 150 && scaled.screen?.imageWidth === 200 && scaled.result.includes('scale 0.500 px/pt'), scaled.result)
const region = await call({ action: 'screenshot', region: { x: 10, y: 20, width: 40, height: 30 } })
check('region keeps its origin and defaults to native pixels', region.screen?.originX === 120 && region.screen.originY === 120 && region.screen.pointWidth === 80 && region.screen.pointHeight === 60 && region.screen.imageWidth === 160 && region.screen.imageHeight === 120, region.result)
const full = await call({ action: 'screenshot', full: true })
check('full:true restores the display frame', full.screen?.originX === -100 && full.screen.pointWidth === 1000, full.result)
for (const scale of [0, 0.24, 1.01, Number.NaN]) {
  const verdict = await ComputerTool.validateInput!({ action: 'screenshot', scale } as never, context)
  check(`scale ${scale} refuses`, !verdict.result)
}
const stepScale = await ComputerTool.validateInput!({ action: 'sequence', steps: [{ action: 'wait', scale: 0.5 }] } as never, context)
check('sequence steps cannot change the image scale', !stepScale.result)

if (process.platform === 'darwin') {
section('terminal bundle identity and AX text, never the display name')
const front = driver.frontmostApplication.bind(driver)
const tree = driver.accessibilityTree.bind(driver)
const text = 'terminal proof\n' + 'visible row\n'.repeat(2000)
const terminalTree: DesktopTree = { elements: [{ depth: 0, role: 'AXTextArea', title: 'shell', value: text, frame: { x: 100, y: 80, width: 400, height: 300 }, focused: true }], truncated: false, reason: null, scope: 'window' }
driver.accessibilityTree = async () => ({ ok: true, value: terminalTree })
for (const identity of ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'org.alacritty', 'net.kovidgoyal.kitty', 'com.github.wez.wezterm', 'dev.warp.Warp-Stable']) {
  driver.frontmostApplication = async () => {
    const app = await front()
    return app.ok ? { ok: true, value: { ...app.value, identity, name: 'Renamed application' } } : app
  }
  for (const action of ['screenshot', 'tree']) {
    before = captures
    const out = await call({ action })
    check(`${identity} ${action}: AX text bounded with a cut notice and focus, no image`, out.outcome === 'succeeded' && !out.imagePath && captures === before && out.result.includes('terminal text') && out.result.includes('terminal proof') && out.result.includes('cut at 15000') && out.result.includes('AXTextArea') && out.result.length < 16000, out.result.slice(0, 250))
  }
}
driver.focusedText = async () => ({ ok: true, value: { role: 'AXTextArea', title: 'shell', text: 'hidden scrollback\nVISIBLE\nnext', visibleRange: { location: 'hidden scrollback\n'.length, length: 7 } } })
const visible = await call({ action: 'screenshot' })
check('native focused-text visible range excludes scrollback', visible.result.endsWith('VISIBLE') && visible.result.includes('visible range') && !visible.result.includes('hidden scrollback'), visible.result)
driver.focusedText = async () => ({ ok: true, value: { role: 'AXTextArea', title: 'shell', text: '', visibleRange: { location: 0, length: 0 } } })
const empty = await call({ action: 'screenshot' })
check('empty visible terminal is an empty text reading, not a pixel fallback', !empty.imagePath && empty.result.includes('terminal text:') && empty.result.includes('visible range'), empty.result)
delete driver.focusedText
const pixels = await call({ action: 'screenshot', pixels: true })
check('pixels:true asks for a terminal image', pixels.outcome === 'succeeded' && !!pixels.imagePath, pixels.result)
driver.frontmostApplication = front
const impostor = await call({ action: 'screenshot' })
check('a display name Terminal without its bundle identity stays an image', !!impostor.imagePath, impostor.result)
driver.accessibilityTree = tree
}
const verified = await call({ action: 'click', target: { name: 'Save' }, verify: true })
check('verify:true retains the tree change check without an image', verified.outcome === 'succeeded' && !verified.imagePath && verified.result.includes('no observed change in the tree'), verified.result)
console.log(JSON.stringify({ estimate: 'text chars/4; image pixels and bytes measured, no provider billing claim', rows }, null, 2))
forgetDesktopOwner(ownerOf(context))
finish('prove-computer-token-budget')
