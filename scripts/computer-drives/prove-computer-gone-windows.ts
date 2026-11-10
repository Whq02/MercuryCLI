#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { check, finish, scratchDir, section } from '../computer/computerProofKit.ts'
import { ownerOf, resultOf, toolContext } from '../computer/computerToolKit.ts'
import type { DesktopApplication, DesktopTree, DesktopTreeElement } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { waitConditionPassed } = await import('../../src/tools/ComputerTool/waitCondition.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')

const scratch = scratchDir('gone-windows')
const TEXT = 'Saving…'
const BOUNDS = { x: 0, y: 0, width: 800, height: 600 }

function bundle(name: string, files: string[]): string {
  const root = join(scratch, 'bundles', name)
  mkdirSync(root, { recursive: true })
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

type Page = 'none' | 'unread' | 'read'
interface Read {
  page: Page
  webContent: DesktopTree['webContent']
  webSurface?: boolean
}
interface Window {
  label: string
  identity: string
  name: string
  bundlePath: string
  engine: boolean
  leavesAtMs: number
  read: (ms: number) => Read
}

const enginePage = (ms: number): Read => (ms < 100 ? { page: 'unread', webContent: 'pending' } : ms < 200 ? { page: 'unread', webContent: 'absent' } : { page: 'read', webContent: 'available' })

const windows: Window[] = [
  {
    label: 'a native window',
    identity: 'com.example.notes',
    name: 'Notes',
    bundlePath: bundle('Notes.app', ['Contents/MacOS/Notes', 'Contents/Frameworks/Updater.framework/Resources/Info.plist']),
    engine: false,
    leavesAtMs: 300,
    read: ms => ({ page: 'none', webContent: ms < 100 ? 'pending' : 'absent' }),
  },
  {
    label: 'a browser no list names',
    identity: 'com.example.voyager',
    name: 'Voyager',
    bundlePath: bundle('Voyager.app', ['Contents/MacOS/Voyager', 'Contents/Frameworks/Voyager Framework.framework/Resources/icudtl.dat', 'Contents/Frameworks/Voyager Framework.framework/Resources/resources.pak']),
    engine: true,
    leavesAtMs: 400,
    read: enginePage,
  },
  {
    label: 'a Chromium-shell application',
    identity: 'com.example.slate',
    name: 'Slate',
    bundlePath: bundle('Slate.app', ['Contents/MacOS/Slate', 'Contents/Frameworks/Slate Helper (Renderer).app/Contents/MacOS/Slate Helper (Renderer)', 'Contents/Frameworks/Shell Framework.framework/Resources/icudtl.dat', 'Contents/Frameworks/Shell Framework.framework/Resources/resources.pak']),
    engine: true,
    leavesAtMs: 400,
    read: enginePage,
  },
  {
    label: 'a native shell with a system web view whose page drops out of the tree',
    identity: 'com.example.reader',
    name: 'Reader',
    bundlePath: bundle('Reader.app', ['Contents/MacOS/Reader']),
    engine: false,
    leavesAtMs: 450,
    read: ms => (ms >= 150 && ms < 300 ? { page: 'unread', webContent: 'absent', webSurface: true } : { page: 'read', webContent: 'available', webSurface: true }),
  },
  {
    label: "the same shell on UI Automation, the engine's element in the tree before its page",
    identity: 'reader.exe',
    name: 'Reader',
    bundlePath: bundle('Reader', ['Reader.exe', 'Reader.dll']),
    engine: false,
    leavesAtMs: 400,
    read: ms => (ms < 200 ? { page: 'unread', webContent: 'absent', webSurface: true } : { page: 'read', webContent: 'available', webSurface: true }),
  },
  {
    label: 'a native shell whose system web view has shown no page yet, its first read still starting',
    identity: 'com.example.reader.cold',
    name: 'Reader',
    bundlePath: bundle('Cold Reader.app', ['Contents/MacOS/Reader']),
    engine: false,
    leavesAtMs: 700,
    read: ms => (ms < 300 ? { page: 'unread', webContent: 'pending' } : { page: 'read', webContent: 'available', webSurface: true }),
  },
]

const row = (depth: number, role: string, title: string | null, value: string | null = null): DesktopTreeElement => ({ depth, role, title, value, frame: { x: 20, y: 20 + depth * 24, width: 240, height: 20 } })

function treeOf(window: Window, ms: number): DesktopTree {
  const read = window.read(ms)
  const shown = ms < window.leavesAtMs
  const elements = [row(0, 'AXApplication', window.name), row(1, 'AXWindow', 'Draft'), row(2, 'AXButton', 'Share')]
  if (read.page === 'none' && shown) elements.push(row(2, 'AXStaticText', null, TEXT))
  if (read.page === 'read') {
    elements.push(row(2, 'AXWebArea', 'Draft'))
    if (shown) elements.push(row(3, 'AXStaticText', null, TEXT))
  }
  return { elements, truncated: false, reason: null, scope: 'window', webContent: read.webContent, ...(read.webSurface ? { webSurface: true } : {}) }
}

async function stage(window: Window, index: number) {
  const scene = join(scratch, `scene-${index}.json`)
  writeFileSync(scene, JSON.stringify({
    displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 800, height: 600, scale: 1, primary: true }],
    frontmost: { identity: window.identity, name: window.name, pid: 500 + index, windowId: `draft-${index}`, title: 'Draft', bounds: BOUNDS, bundlePath: window.bundlePath },
    cursor: { x: 10, y: 10 },
    tree: [{ role: 'AXWindow', title: 'Draft', focused: true, frame: BOUNDS, children: [{ role: 'AXButton', title: 'Share', frame: { x: 20, y: 68, width: 240, height: 20 } }] }],
  }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
  resetDesktopDriverForTest()
  const resolution = resolveDesktopDriver()
  if (resolution.state !== 'ok') throw new Error(resolution.note)
  const context = toolContext()
  session.forgetDesktopOwner(ownerOf(context))
  return { driver: resolution.driver, context }
}

section("six windows, each with a text that leaves after a delay: the wait is met only once it has left")
for (const [index, window] of windows.entries()) {
  const { driver, context } = await stage(window, index)
  const front = await driver.frontmostApplication()
  check(`${window.label}: the driver states what its bundle carries (${window.engine ? 'an engine' : 'no engine'})`, front.ok && front.value.webEngine === window.engine, JSON.stringify(front))
  const started = Date.now()
  driver.accessibilityTree = async () => ({ ok: true, value: treeOf(window, Date.now() - started) })
  const waited = resultOf(await ComputerTool.call({ action: 'wait', until: { text: TEXT, gone: true }, durationMs: 3000, capture: false } as never, context))
  const answeredMs = Date.now() - started
  check(`${window.label}: gone is met, and only after the text left`, waited.outcome === 'succeeded' && answeredMs >= window.leavesAtMs, `${waited.outcome} after ${answeredMs} ms; the text left at ${window.leavesAtMs} ms · ${waited.result}`)
}

section('a text that stays keeps the wait waiting, on the native window too')
{
  const native = windows[0]!
  const { driver, context } = await stage(native, windows.length)
  driver.accessibilityTree = async () => ({ ok: true, value: treeOf(native, 150) })
  const stays = resultOf(await ComputerTool.call({ action: 'wait', until: { text: TEXT, gone: true }, durationMs: 250, capture: false } as never, context))
  check('gone times out while the text stands in a native window', stays.outcome === 'failed' && stays.result.includes('timed out') && stays.result.includes('gone'), stays.result)
}

section('the rule state by state: what the application carries, what its window has shown, what the tree says')
{
  const carries: Array<[string, boolean | undefined]> = [['an engine in its bundle', true], ['no engine in its bundle', false], ['a bundle the driver could not read', undefined]]
  const states: Array<DesktopTree['webContent']> = [undefined, 'available', 'pending', 'absent']
  for (const [words, webEngine] of carries) {
    for (const webSurface of [true, undefined]) {
      const app: DesktopApplication = { identity: 'com.example.matrix', name: 'Matrix', pid: 900, title: 'Draft', bounds: BOUNDS, ...(webEngine === undefined ? {} : { webEngine }) }
      const wrong: string[] = []
      for (const webContent of states) {
        for (const truncated of [false, true]) {
          const plain: DesktopTree = { elements: [row(0, 'AXWindow', 'Draft')], truncated, reason: null, ...(webContent ? { webContent } : {}), ...(webSurface ? { webSurface } : {}) }
          const expected = !truncated && (webContent === undefined || webContent === 'available' || (webContent === 'absent' && webEngine === false && webSurface !== true))
          const gone = waitConditionPassed({ text: TEXT, gone: true }, app, plain)
          const dialogGone = waitConditionPassed({ dialog: true, gone: true }, app, plain)
          if (gone !== expected || dialogGone !== expected) wrong.push(`${webContent ?? 'unstated'}${truncated ? ' truncated' : ''}: gone ${gone}, dialog gone ${dialogGone}, expected ${expected}`)
        }
      }
      check(`${words}, ${webSurface ? 'a window that has shown a page surface' : 'a window that has shown none'}: a tree establishes absence only when it is whole and carries the page, or is past its starting state with nothing saying the window bears one`, wrong.length === 0, wrong.join(' · '))
    }
  }
}

finish('prove-computer-gone-windows')
