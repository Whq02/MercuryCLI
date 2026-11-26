#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolResultTurn } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/integrations/desktop/driver.ts'
import type { Input } from '../../src/tools/computer/ComputerTool.ts'
import { createAssistantMessage } from '../../src/engine/messages/messages.ts'

const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/integrations/desktop/resolveDriver.ts')
const session = await import('../../src/integrations/desktop/desktopSession.ts')
const { SCREENSHOT_KEEP_RECENT } = await import('../../src/integrations/desktop/screenshotRetention.ts')
const app = { identity: 'com.example.Editor', name: 'Editor', pid: 123, windowId: 'editor', title: 'Document', bounds: { x: 0, y: 0, width: 400, height: 300 } }
const scene = join(scratchDir('sequence-lines'), 'scene.json')
writeFileSync(scene, JSON.stringify({ displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 400, height: 300, scale: 2, primary: true }], frontmost: app, cursor: { x: 50, y: 50 }, lines: ['Editor proof'], tree: [{ role: 'AXButton', title: 'Save', frame: { x: 100, y: 80, width: 40, height: 20 } }] }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
let controller = new AbortController()
let context = toolContext({ controller })
session.forgetDesktopOwner(ownerOf(context))
let serial = 0
const call = async (input: Input) => {
  const id = `sequence-lines-${++serial}`
  const parent = createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Computer', input }] })
  const answer = await ComputerTool.call(input, context, allowEverything, parent)
  const block = ComputerTool.mapToolResultToToolResultBlockParam(answer.data, id)
  return { ...resultOf(answer), block, parent, id }
}
const seedShot = async (input: Input = { action: 'screenshot', full: true }) => {
  const shot = await call(input)
  context = { ...context, messages: [...context.messages, shot.parent, toolResultTurn(shot.block)] }
}
const imageBlocksOf = (block: { content?: unknown }) => (Array.isArray(block.content) ? (block.content as Array<{ type?: string; source?: { data?: string } }>).filter(part => part.type === 'image') : [])
const target = { role: 'AXButton', name: 'Save' }
const keyTaps = () => driver.acts.filter(a => a.act === 'keyTap').length
const clicks = () => driver.acts.filter(a => a.act === 'click').length
const captures = () => driver.acts.filter(a => a.act === 'capture').length

section('D1(a): capture:false suppresses only the implicit final capture; explicit screenshot steps still capture')
{
  const keysBefore = keyTaps()
  const capturesBefore = captures()
  const explicit = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'screenshot', pixels: true, label: 'mid' }, { action: 'key', key: 'Enter' }], capture: false })
  const lines = explicit.result.split('\n')
  const clickAt = lines.findIndex(line => line.startsWith('click AXButton "Save"'))
  const shotAt = lines.findIndex(line => line.startsWith('screenshot: '))
  const keyAt = lines.findIndex(line => line.startsWith('key Enter'))
  const blocks = imageBlocksOf(explicit.block)
  check('explicit pixel screenshot inside capture:false captures and returns its image', explicit.outcome === 'succeeded' && explicit.result.includes('sequence 3/3 completed') && explicit.imagePath !== undefined && blocks.length === 1 && keyTaps() === keysBefore + 1 && !explicit.result.includes('screenshot step skipped'), explicit.result)
  check('the screenshot line stands between click and key, and no implicit final capture ran', clickAt >= 0 && shotAt > clickAt && keyAt > shotAt && captures() === capturesBefore + 1, `click ${clickAt} · shot ${shotAt} · key ${keyAt} · captures ${captures() - capturesBefore}\n${explicit.result}`)
  const silentBefore = captures()
  const silent = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'key', key: 'Enter' }], capture: false })
  check('capture:false with no screenshot steps still suppresses the implicit final capture', silent.outcome === 'succeeded' && silent.imagePath === undefined && imageBlocksOf(silent.block).length === 0 && captures() === silentBefore, silent.result)
  const bothBefore = captures()
  const both = await call({ action: 'sequence', steps: [{ action: 'screenshot', pixels: true, label: 'before-key' }, { action: 'key', key: 'Enter' }], capture: true })
  check('capture:true keeps both the explicit step shot and the implicit final capture in order', both.outcome === 'succeeded' && imageBlocksOf(both.block).length === 2 && captures() === bothBefore + 2, `images=${imageBlocksOf(both.block).length} captures=${captures() - bothBefore}\n${both.result}`)
}

section('D1(b): known unsatisfiable unseen-screenshot coordinate sequences refuse before touching anything; legal steps still run')
{
  await seedShot()
  const mapBefore = session.screenOf(ownerOf(context))
  const keysBefore = keyTaps()
  const capturesBefore = captures()
  const staticInput: Input = { action: 'sequence', steps: [{ action: 'key', key: 'Enter' }, { action: 'screenshot', pixels: true }, { action: 'scroll', x: 50, y: 50, dy: 5 }] }
  const validated = await ComputerTool.validateInput!(staticInput, context)
  const preflighted = await call(staticInput)
  check('static unseen-screenshot coordinate sequence refuses at validateInput and call before executing earlier steps or taking a shot', validated.result === false && preflighted.outcome === 'failed' && preflighted.result.includes('taken in this same message') && keyTaps() === keysBefore && captures() === capturesBefore && preflighted.imagePath === undefined && imageBlocksOf(preflighted.block).length === 0, `validated=${JSON.stringify(validated)} keys=${keyTaps() - keysBefore} captures=${captures() - capturesBefore}\n${preflighted.result}`)
  check('previous screen map stays intact after preflight refusal', JSON.stringify(session.screenOf(ownerOf(context))) === JSON.stringify(mapBefore), JSON.stringify(session.screenOf(ownerOf(context))))
  const bareCapturesBefore = captures()
  const bareClicksBefore = clicks()
  const bareRefused = await call({ action: 'sequence', steps: [{ action: 'screenshot', scale: 0.5 }, { action: 'click', x: 50, y: 50 }], capture: false })
  check('non-terminal bare screenshot followed by coordinate click refuses before step 1 with zero captures and zero clicks', bareRefused.outcome === 'failed' && bareRefused.result.includes('sequence 0/2 completed') && bareRefused.result.includes('taken in this same message') && captures() === bareCapturesBefore && clicks() === bareClicksBefore && JSON.stringify(session.screenOf(ownerOf(context))) === JSON.stringify(mapBefore), bareRefused.result)
  const legal = await call({ action: 'sequence', steps: [{ action: 'screenshot', pixels: true }, { action: 'key', key: 'Enter' }, { action: 'click', target }, { action: 'find', target }], capture: false })
  check('key, named target and read remain legal after an explicit screenshot step', legal.outcome === 'succeeded' && legal.result.includes('sequence 4/4 completed') && imageBlocksOf(legal.block).length === 1, legal.result)
}

section('D1(c): multiple explicit screenshots travel in order within retention bounds and account honestly past the bound')
{
  const three = await call({
    action: 'sequence',
    steps: [
      { action: 'screenshot', pixels: true, label: 'shot-one' },
      { action: 'key', key: 'PageDown' },
      { action: 'screenshot', pixels: true, label: 'shot-two' },
      { action: 'key', key: 'PageDown' },
      { action: 'screenshot', pixels: true, label: 'shot-three' },
    ],
    capture: false,
  })
  const threeBlocks = imageBlocksOf(three.block)
  const threePaths = [...three.result.matchAll(/^screenshot: (.+?\.png) — display/gm)].map(m => m[1]!)
  const frameChangedCount = (three.result.match(/frame changed:/g) ?? []).length
  check('three explicit screenshots return all three images in order in the model-facing tool_result', three.outcome === 'succeeded' && three.result.includes('sequence 5/5 completed') && threePaths.length === 3 && new Set(threePaths).size === 3 && threeBlocks.length === 3 && threePaths.every(p => existsSync(p)), `paths=${threePaths.length} blocks=${threeBlocks.length}\n${three.result}`)
  check('image block order matches the three step files and imagePath/screen point to the third', threeBlocks.length === 3 && threePaths.length === 3 && three.imagePath === threePaths[2] && threePaths.every((p, idx) => Buffer.from(threeBlocks[idx]!.source!.data!, 'base64').equals(readFileSync(existsSync(`${p}.inline`) ? `${p}.inline` : p))), `imagePath=${three.imagePath} paths=${JSON.stringify(threePaths)}`)
  check('identical consecutive window shots do not emit bogus frame-changed warnings and accounting names the coordinate image', frameChangedCount === 0 && three.result.includes('images: 3 of 3 returned in order') && three.result.includes(threePaths[2]!), `frameChanged=${frameChangedCount}\n${three.result}`)

  const four = await call({
    action: 'sequence',
    steps: [
      { action: 'screenshot', pixels: true, label: 'cap-one' },
      { action: 'screenshot', pixels: true, label: 'cap-two' },
      { action: 'screenshot', pixels: true, label: 'cap-three' },
      { action: 'screenshot', pixels: true, label: 'cap-four' },
    ],
    capture: false,
  })
  const fourBlocks = imageBlocksOf(four.block)
  const keptPaths = [...four.result.matchAll(/^screenshot: (.+?\.png) — display/gm)].map(m => m[1]!)
  const savedOnlyPaths = [...four.result.matchAll(/^screenshot saved at (.+?\.png) \(not returned in this answer/gm)].map(m => m[1]!)
  check(`four explicit screenshots cap at SCREENSHOT_KEEP_RECENT (${SCREENSHOT_KEEP_RECENT}), keep the last three in order, and report the omitted first with its disk path and Read remedy`, four.outcome === 'succeeded' && fourBlocks.length === SCREENSHOT_KEEP_RECENT && keptPaths.length === SCREENSHOT_KEEP_RECENT && savedOnlyPaths.length === 1 && existsSync(savedOnlyPaths[0]!) && four.result.includes('use Read on that path') && four.result.includes(`images: ${SCREENSHOT_KEEP_RECENT} of 4 returned in order`) && four.imagePath === keptPaths.at(-1) && !four.result.includes('4 of 4 returned'), `blocks=${fourBlocks.length} kept=${keptPaths.length} savedOnly=${savedOnlyPaths.length}\n${four.result}`)

  const mapBeforeFail = session.screenOf(ownerOf(context))
  const failedAfterTwo = await call({
    action: 'sequence',
    steps: [
      { action: 'screenshot', pixels: true, label: 'fail-one' },
      { action: 'screenshot', pixels: true, label: 'fail-two' },
      { action: 'click', target: { role: 'AXButton', name: 'NoSuchButton' } },
    ],
    capture: false,
  })
  const notReturnedLines = failedAfterTwo.result.split('\n').filter(line => line.startsWith('screenshot taken by the step but not returned:'))
  check('a failed sequence after two screenshots withholds all images, replaces both lines, and preserves the previous screen map', failedAfterTwo.outcome === 'failed' && failedAfterTwo.imagePath === undefined && imageBlocksOf(failedAfterTwo.block).length === 0 && notReturnedLines.length === 2 && !failedAfterTwo.result.includes('screenshot: ') && JSON.stringify(session.screenOf(ownerOf(context))) === JSON.stringify(mapBeforeFail), failedAfterTwo.result)
}

section("the operator's interrupt met between two steps keeps the lines of the steps that ran")
{
  let cursorReads = 0
  const originalCursor = driver.cursor.bind(driver)
  driver.cursor = async () => {
    const answer = await originalCursor()
    if (++cursorReads === 2) controller.abort()
    return answer
  }
  const keysBefore = keyTaps()
  const interrupted = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'wait', durationMs: 10 }, { action: 'key', key: 'Enter' }], capture: false })
  driver.cursor = originalCursor
  const lines = interrupted.result.split('\n')
  check('an interrupt met at the head of step 3 refuses with the interruption words after "2/3 completed", and the third step never runs', interrupted.outcome === 'failed' && interrupted.result.startsWith('sequence 2/3 completed · sequence interrupted by the operator') && keyTaps() === keysBefore && cursorReads === 2, `${interrupted.result} · cursor reads ${cursorReads}`)
  check("the lines of the two steps that ran stay in the answer: the click's and the wait's", lines.some(line => line.startsWith('click AXButton "Save"')) && lines.some(line => line.startsWith('wait 10ms')), interrupted.result)
  controller = new AbortController()
  context = toolContext({ controller })
}

if (process.platform === 'darwin') {
  section('an image step followed by a terminal-text step: the image never travels, so its line says so instead of naming a saved file')
  const terminal = { identity: 'com.apple.Terminal', name: 'Terminal', pid: 321, windowId: 'term', title: 'build — zsh', bounds: { x: 0, y: 0, width: 400, height: 300 } }
  const SUPERSEDED = "screenshot taken by an earlier step but not returned: the terminal text below is this answer's content, so the previous screenshot's coordinates still apply — take the screenshot alone to see it"
  let front: typeof app | typeof terminal = app
  const treeBefore = driver.accessibilityTree.bind(driver)
  const frontBefore = driver.frontmostApplication.bind(driver)
  const mutable = driver as unknown as Record<string, unknown>
  const findBefore = mutable.findApplication
  const activateBefore = mutable.activateApplication
  driver.frontmostApplication = async () => ({ ok: true, value: { ...front } })
  driver.accessibilityTree = async (...args: Parameters<typeof treeBefore>) => (args[0].identity === terminal.identity ? { ok: true, value: { elements: [{ depth: 1, role: 'AXTextArea', title: 'shell', value: '$ make ui-check\nall green\n', frame: { x: 0, y: 20, width: 400, height: 280 }, focused: true }], truncated: false, root: { role: 'AXWindow', title: terminal.title }, webContent: 'absent' } } as never : treeBefore(...args))
  mutable.findApplication = async () => ({ ok: true, value: { ...terminal } })
  mutable.activateApplication = async () => { front = terminal; return { ok: true, value: { ...terminal } } }
  const imageLines = (text: string) => text.split('\n').filter(line => /^screenshot: \/.*\.png — display/.test(line))
  const good = await call({ action: 'sequence', steps: [{ action: 'screenshot' }, { action: 'focusApp', focusApp: { name: 'Terminal' } }, { action: 'screenshot' }] })
  check('a succeeded sequence attaches no image after the terminal text replaced it, and no line names a saved image', good.outcome === 'succeeded' && good.imagePath === undefined && imageBlocksOf(good.block).length === 0 && imageLines(good.result).length === 0, good.result)
  const supersededAt = good.result.indexOf(SUPERSEDED)
  const terminalAt = good.result.indexOf('terminal text')
  check("the earlier image step's line says the terminal text superseded it, and the terminal text follows", good.result.split('\n').includes(SUPERSEDED) && supersededAt >= 0 && terminalAt >= 0 && supersededAt < terminalAt, good.result)
  front = app
  const bad = await call({ action: 'sequence', steps: [{ action: 'screenshot' }, { action: 'focusApp', focusApp: { name: 'Terminal' } }, { action: 'screenshot' }, { action: 'click', x: 20, y: 20 }] })
  check('a failed sequence of the same shape names no saved image either', bad.outcome === 'failed' && bad.imagePath === undefined && imageBlocksOf(bad.block).length === 0 && imageLines(bad.result).length === 0, bad.result)
  front = terminal
  await seedShot({ action: 'screenshot', pixels: true })
  const clicksBeforeTerm = clicks()
  const terminalNotImage = await call({ action: 'sequence', steps: [{ action: 'screenshot' }, { action: 'click', x: 20, y: 20 }], capture: false })
  check('explicit terminal text is not a new coordinate map: a following coordinate click is not refused as unseen', terminalNotImage.outcome === 'succeeded' && terminalNotImage.result.includes('terminal text') && clicks() === clicksBeforeTerm + 1, terminalNotImage.result)
  driver.frontmostApplication = frontBefore
  driver.accessibilityTree = treeBefore
  mutable.findApplication = findBefore
  mutable.activateApplication = activateBefore
}

session.forgetDesktopOwner(ownerOf(context))
finish('prove-computer-sequence-lines')
