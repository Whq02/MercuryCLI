#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section, sourceText } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { readFakeScene } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
const driverModule = (await import('../../src/services/desktop/driver.ts')) as { TREE_UNANSWERED_REASON?: string }
const session = await import('../../src/services/desktop/desktopSession.ts')

const REASON = 'an element whose children could not be read (its application did not answer)'
const UNANSWERED_TREE = `truncated: the tree goes on past ${REASON} — read again, narrow with root or find, or act on what is shown`
const UNANSWERED_FIELDS = `truncated: more controls past ${REASON} — read again, or narrow with root`
const scratch = scratchDir('unanswered-tree')
const bounds = { x: 0, y: 0, width: 800, height: 600 }
const bundlePath = join(scratch, 'Reader.app')
mkdirSync(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
writeFileSync(join(bundlePath, 'Contents', 'MacOS', 'Reader'), '')

function sceneFile(name: string, view: Record<string, unknown>): string {
  const path = join(scratch, `${name}.json`)
  writeFileSync(path, JSON.stringify({
    displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 800, height: 600, scale: 1, primary: true }],
    frontmost: { identity: 'com.example.reader', name: 'Reader', pid: 700, windowId: 'draft', title: 'Draft', bounds, bundlePath },
    cursor: { x: 10, y: 10 },
    tree: [{ role: 'AXWindow', title: 'Draft', focused: true, frame: bounds, children: [
      { role: 'AXButton', title: 'Share', frame: { x: 20, y: 20, width: 80, height: 20 } },
      { role: 'AXTextField', title: 'Title', value: 'Draft', frame: { x: 120, y: 20, width: 200, height: 20 } },
      { role: 'AXTextField', title: 'Author', value: 'Proof', frame: { x: 340, y: 20, width: 200, height: 20 } },
      { role: 'AXGroup', title: 'Reader view', frame: { x: 0, y: 60, width: 800, height: 540 }, ...view },
    ] }],
  }))
  return path
}

let serial = 0
async function stage(scene: string) {
  process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
  resetDesktopDriverForTest()
  const resolution = resolveDesktopDriver()
  if (resolution.state !== 'ok') throw new Error(resolution.note)
  const context = toolContext()
  session.forgetDesktopOwner(ownerOf(context))
  return async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`unanswered-${++serial}`, 'Computer', input) as never))
}

const page = { children: [{ role: 'AXStaticText', value: 'Saving…', frame: { x: 20, y: 80, width: 200, height: 20 } }] }

section('an element whose children could not be read leaves the tree incomplete, and the tree says so')
{
  const call = await stage(sceneFile('unanswered', { unanswered: true, ...page }))
  const tree = await call({ action: 'tree' })
  const lines = tree.result.split('\n')
  check('the tree of a window with such an element ends on the line that names it, with a tail that can help', tree.outcome === 'succeeded' && lines.includes(UNANSWERED_TREE) && !tree.result.includes('Saving…'), tree.result)
  const found = await call({ action: 'find', target: { text: 'Saving' } })
  check('a find that matches nothing there says the tree is incomplete, never a plain nothing', found.outcome === 'succeeded' && found.result.split('\n').includes(UNANSWERED_TREE), found.result)
  const fields = await call({ action: 'fields' })
  check("the fields read carries the same reason with its own tail", fields.outcome === 'succeeded' && fields.result.split('\n').includes(UNANSWERED_FIELDS), fields.result)
  const waited = await call({ action: 'wait', until: { text: 'Uploading', gone: true }, durationMs: 300, capture: false })
  check('a gone wait is not met on it: a text the tree does not show may stand under the element that did not answer', waited.outcome === 'failed' && waited.result.includes('timed out') && waited.result.includes('gone'), waited.result)
  const dialog = await call({ action: 'wait', until: { dialog: true, gone: true }, durationMs: 200, capture: false })
  check('a dialog-gone wait is not met on it either', dialog.outcome === 'failed' && dialog.result.includes('timed out'), dialog.result)
  const clicked = await call({ action: 'click', target: { name: 'Share' }, capture: false })
  check('an act by target is refused there as on every incomplete tree, which is why only a message that failed counts', clicked.outcome === 'failed' && clicked.result.includes('the tree is truncated, so uniqueness is unknown'), clicked.result)
}

section('the same window once the element answers: the tree is whole and the wait is met')
{
  const call = await stage(sceneFile('answered', {}))
  const tree = await call({ action: 'tree' })
  check('a whole tree carries no truncated line', tree.outcome === 'succeeded' && !tree.result.includes('truncated:'), tree.result)
  const waited = await call({ action: 'wait', until: { text: 'Uploading', gone: true }, durationMs: 300, capture: false })
  check('the gone wait is met at once on the whole tree of a window that bears no page', waited.outcome === 'succeeded' && waited.result.includes('gone'), waited.result)
  const clicked = await call({ action: 'click', target: { name: 'Share' }, capture: false })
  check('the act by target lands', clicked.outcome === 'succeeded', clicked.result)
}

section('every other incomplete tree keeps its sentence byte for byte')
{
  const call = await stage(sceneFile('limited', page))
  const tree = await call({ action: 'tree', limit: 2 })
  check('a tree cut at its limit says so with the tail it had', tree.outcome === 'succeeded' && tree.result.split('\n').includes('truncated: the tree goes on past the limit of 2 elements or depth 12 — narrow with root or find, raise limit or depth to read more, or act on what is shown'), tree.result)
  const fields = await call({ action: 'fields', limit: 1 })
  check('a fields read cut at its limit says so with the tail it had', fields.outcome === 'succeeded' && fields.result.split('\n').some(line => line.startsWith('truncated: more controls past the limit of 1 ') && line.endsWith(' — raise limit, or narrow with root')), fields.result)
}

section('the scene, the reason and both native walks')
{
  const malformed = join(scratch, 'malformed.json')
  writeFileSync(malformed, JSON.stringify({ tree: [{ role: 'AXWindow', unanswered: 'yes' }] }))
  const read = readFakeScene(malformed)
  check('a scene whose element states unanswered as anything but true or false is refused by name', read.state === 'unavailable' && read.note.includes('tree[0].unanswered must be true or false'), JSON.stringify(read))
  const lib = sourceText('native/desktop/src/lib.rs')
  check('the native drivers and the tool hold one reason, word for word', driverModule.TREE_UNANSWERED_REASON === REASON && lib.includes(`pub const UNANSWERED_REASON: &str = "${REASON}";`), String(driverModule.TREE_UNANSWERED_REASON))
  const mac = sourceText('native/desktop/src/mac.rs')
  const win = sourceText('native/desktop/src/win.rs')
  check('the macOS walk reads the status of each child list and of each child count', mac.includes('return (list, ax_children_unanswered(status));') && mac.includes('if status == 0 { count > 0 } else { ax_children_unanswered(status) }') && mac.includes('reason.get_or_insert_with(|| UNANSWERED_REASON.to_string());'))
  check('the Windows walk reads the error that ends each child list', win.includes('Err(error) => return (list, uia_children_unanswered(error.code().0)),') && win.includes('else if walk.unanswered { Some(UNANSWERED_REASON.to_string()) }'))
}

finish('prove-computer-unanswered-tree')
