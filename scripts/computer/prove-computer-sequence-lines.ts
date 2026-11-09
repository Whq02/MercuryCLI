#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
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
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`sequence-lines-${++serial}`, 'Computer', input) as never))
const target = { role: 'AXButton', name: 'Save' }
const keyTaps = () => driver.acts.filter(a => a.act === 'keyTap').length
const SKIPPED = 'screenshot step skipped (capture: false)'

section('a screenshot step under the sequence\'s capture: false leaves a line saying it was skipped, where the step stood')
{
  const keysBefore = keyTaps()
  const skipped = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'screenshot' }, { action: 'key', key: 'Enter' }], capture: false })
  const lines = skipped.result.split('\n')
  const clickAt = lines.findIndex(line => line.startsWith('click AXButton "Save"'))
  const skippedAt = lines.indexOf(SKIPPED)
  const keyAt = lines.findIndex(line => line.startsWith('key Enter'))
  check('the sequence completes image-free, the key step ran, and the skipped step says so', skipped.outcome === 'succeeded' && skipped.result.includes('sequence 3/3 completed') && skipped.imagePath === undefined && lines.includes(SKIPPED) && keyTaps() === keysBefore + 1, skipped.result)
  check("the skipped line stands between the click's line and the key's, where the step stood", clickAt >= 0 && skippedAt > clickAt && keyAt > skippedAt, `click ${clickAt} · skipped ${skippedAt} · key ${keyAt}\n${skipped.result}`)
  check('no capture was taken for the skipped step', !driver.acts.some(a => a.act === 'capture'), driver.acts.map(a => a.act).join(','))
  const taken = await call({ action: 'sequence', steps: [{ action: 'click', target }, { action: 'screenshot' }], capture: true })
  check('with capture on, the step takes its screenshot and no skipped line appears', taken.outcome === 'succeeded' && taken.imagePath !== undefined && !taken.result.includes(SKIPPED) && taken.result.includes('screenshot: '), taken.result)
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
  check('a succeeded sequence attaches no image after the terminal text replaced it, and no line names a saved image', good.outcome === 'succeeded' && good.imagePath === undefined && imageLines(good.result).length === 0, good.result)
  const supersededAt = good.result.indexOf(SUPERSEDED)
  const terminalAt = good.result.indexOf('terminal text')
  check("the earlier image step's line says the terminal text superseded it, and the terminal text follows", good.result.split('\n').includes(SUPERSEDED) && supersededAt >= 0 && terminalAt >= 0 && supersededAt < terminalAt, good.result)
  front = app
  const bad = await call({ action: 'sequence', steps: [{ action: 'screenshot' }, { action: 'focusApp', focusApp: { name: 'Terminal' } }, { action: 'screenshot' }, { action: 'click', x: 20, y: 20 }] })
  check('a failed sequence of the same shape names no saved image either', bad.outcome === 'failed' && bad.imagePath === undefined && imageLines(bad.result).length === 0, bad.result)
  driver.frontmostApplication = frontBefore
  driver.accessibilityTree = treeBefore
  mutable.findApplication = findBefore
  mutable.activateApplication = activateBefore
}

session.forgetDesktopOwner(ownerOf(context))
finish('prove-computer-sequence-lines')
