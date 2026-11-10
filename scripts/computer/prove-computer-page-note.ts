#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopApplication, DesktopDriver, DesktopTree } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const fastRoad = await import('../../src/tools/ComputerTool/fastRoad.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')

const ABSENT = 'this application exposes no page content to the tree — use a screenshot; a missing page element is not a confirmed absence'
const PENDING = 'web accessibility requested; page content is still starting — wait until the element appears with durationMs:5000, or take a screenshot'
const finder: DesktopApplication = { identity: 'com.apple.finder', name: 'Finder', pid: 77, windowId: 'downloads', title: 'Downloads', bounds: { x: 0, y: 0, width: 400, height: 300 }, webEngine: false }
const chrome: DesktopApplication = { identity: 'com.google.Chrome', name: 'Google Chrome', pid: 78, windowId: 'careers', title: 'Careers — Example', bounds: { x: 0, y: 0, width: 400, height: 300 }, webEngine: true }
const slate: DesktopApplication = { ...finder, identity: 'com.example.slate', name: 'Slate', pid: 79, webEngine: true }
const reader: DesktopApplication = { ...finder, identity: 'com.example.reader', name: 'Reader', pid: 80, webEngine: false }
const safari: DesktopApplication = { ...finder, identity: 'com.apple.Safari', name: 'Safari', pid: 81, webEngine: false }
const { webEngine: _unread, ...unread } = { ...finder, identity: 'com.example.unread', name: 'Unread', pid: 82 }
const scene = join(scratchDir('page-note'), 'scene.json')
writeFileSync(scene, JSON.stringify({ displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 400, height: 300, scale: 1, primary: true }], frontmost: finder, cursor: { x: 10, y: 10 }, tree: [
  { role: 'AXWindow', title: 'Downloads', focused: true, frame: finder.bounds, children: [
    { role: 'AXStaticText', title: 'Desktop', frame: { x: 20, y: 40, width: 80, height: 20 } },
    { role: 'AXImage', title: 'Calculator', frame: { x: 20, y: 80, width: 40, height: 40 } },
    { role: 'AXOutline', title: 'list view', focused: true, frame: { x: 120, y: 40, width: 260, height: 240 } },
  ] },
] }))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolution = resolveDesktopDriver()
if (resolution.state !== 'ok') throw new Error(resolution.note)
const driver = resolution.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
const context = toolContext()
session.forgetDesktopOwner(ownerOf(context))
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`page-note-${++serial}`, 'Computer', input) as never))
const linesOf = (result: string): string[] => result.split('\n')

let front: DesktopApplication = finder
let webContent: DesktopTree['webContent'] = 'absent'
let webSurface = false
const originalFront = driver.frontmostApplication.bind(driver)
const originalTree = driver.accessibilityTree.bind(driver)
driver.frontmostApplication = async () => ({ ok: true, value: { ...front } })
driver.accessibilityTree = async (...args) => {
  const tree = await originalTree(...args)
  return tree.ok ? { ok: true, value: { ...tree.value, webContent, ...(webSurface ? { webSurface } : {}) } } : tree
}

section("the fast road's browser list decides which windows show an address")
{
  const isBrowser = (fastRoad as { isBrowserApplication?: (app: DesktopApplication) => boolean }).isBrowserApplication
  const browsers = [chrome, { ...finder, identity: 'com.microsoft.edgemac', name: 'Microsoft Edge' }, { ...finder, identity: 'com.apple.Safari', name: 'Safari' }, { ...finder, identity: 'org.mozilla.firefox', name: 'Firefox' }, { ...finder, identity: 'company.thebrowser.Browser', name: 'Arc' }, { ...finder, identity: 'chrome.exe', name: 'chrome' }, { ...finder, identity: 'msedge.exe', name: 'msedge' }]
  const desktops = [finder, { ...finder, identity: 'com.apple.TextEdit', name: 'TextEdit' }, { ...finder, identity: 'com.apple.Terminal', name: 'Terminal' }, { ...finder, identity: 'com.example.Editor', name: 'Editor' }]
  check('isBrowserApplication says yes to Chrome, Edge on macOS, Safari, Firefox, Arc and the Windows browsers, no to Finder, TextEdit, Terminal and a plain editor', typeof isBrowser === 'function' && browsers.every(app => isBrowser(app)) && desktops.every(app => !isBrowser(app)), typeof isBrowser === 'function' ? JSON.stringify([browsers.map(app => isBrowser(app)), desktops.map(app => isBrowser(app))]) : 'fastRoad exports no isBrowserApplication')
}

section('a Finder-shaped window, no engine in its bundle: the tree is the truth there, so no page-content note from tree, find or a refusal')
{
  const found = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('a find that matches nothing on Finder ends without the browser note', found.outcome === 'succeeded' && found.result.includes('0 elements') && !found.result.includes(ABSENT), found.result)
  const tree = await call({ action: 'tree' })
  check('a tree of Finder carries no page-content note', tree.outcome === 'succeeded' && tree.result.includes('AXOutline "list view"') && !tree.result.includes(ABSENT), tree.result)
  const clicksBefore = driver.acts.filter(a => a.act === 'click').length
  const missing = await call({ action: 'click', target: { name: 'Nowhere' }, capture: false })
  check('a click whose target is missing on Finder is refused with the nearest candidates and no page-content note, nothing clicked', missing.outcome === 'failed' && missing.result.includes('0 matches') && missing.result.includes('nearest 3 by text') && !missing.result.includes(ABSENT) && driver.acts.filter(a => a.act === 'click').length === clicksBefore, missing.result)
  const rooted = await call({ action: 'tree', root: { name: 'Nowhere' } })
  check('a tree whose root is missing on Finder is refused without the note', rooted.outcome === 'failed' && rooted.result.includes('0 matches') && !rooted.result.includes(ABSENT), rooted.result)
  webContent = 'pending'
  const pending = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('the starting-page note is for a window that bears a page: Finder never gets it', pending.outcome === 'succeeded' && !pending.result.includes(PENDING), pending.result)
  webContent = 'absent'
}

section('a Chrome-shaped window whose page content is absent keeps the note, and a refusal gives it its own line')
{
  front = chrome
  const found = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('a find on Chrome with no page content still ends with the note, on its own line', found.outcome === 'succeeded' && linesOf(found.result).includes(ABSENT), found.result)
  const tree = await call({ action: 'tree' })
  check('a tree of Chrome with no page content carries the note', tree.outcome === 'succeeded' && linesOf(tree.result).includes(ABSENT), tree.result)
  const missing = await call({ action: 'click', target: { name: 'Nowhere' }, capture: false })
  const lines = linesOf(missing.result)
  check('a missing-target refusal on Chrome lists the nearest candidates whole and puts the note on its own line after them, never glued with "; "', missing.outcome === 'failed' && lines.includes(ABSENT) && !missing.result.includes(`; ${ABSENT}`) && lines.some(line => /^\[\d\] AX\w+ "[^"]+" \(\d+,\d+\)pt$/.test(line)) && lines.indexOf(ABSENT) > lines.findIndex(line => line.startsWith('[1] ')), missing.result)
  const rooted = await call({ action: 'tree', root: { name: 'Nowhere' } })
  check('a missing-root refusal on Chrome puts the note on its own line', rooted.outcome === 'failed' && linesOf(rooted.result).includes(ABSENT) && !rooted.result.includes(`; ${ABSENT}`), rooted.result)
  webContent = 'pending'
  const pending = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('Chrome with page content still starting gets the starting-page note', pending.outcome === 'succeeded' && linesOf(pending.result).includes(PENDING), pending.result)
  webContent = 'available'
  const available = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('Chrome with page content available gets no note', available.outcome === 'succeeded' && !available.result.includes(ABSENT) && !available.result.includes(PENDING), available.result)
}

section('a Chromium-shell application no list names carries an engine in its bundle: it gets the same two notes')
{
  front = slate
  webContent = 'absent'
  const found = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('a find on the shell with no page content ends with the note, on its own line', found.outcome === 'succeeded' && linesOf(found.result).includes(ABSENT), found.result)
  const missing = await call({ action: 'click', target: { name: 'Nowhere' }, capture: false })
  check('a missing-target refusal on the shell puts the note on its own line', missing.outcome === 'failed' && linesOf(missing.result).includes(ABSENT), missing.result)
  webContent = 'pending'
  const pending = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('the shell with page content still starting gets the starting-page note', pending.outcome === 'succeeded' && linesOf(pending.result).includes(PENDING), pending.result)
  webContent = 'available'
  const available = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('the shell with page content available gets no note', available.outcome === 'succeeded' && !available.result.includes(ABSENT) && !available.result.includes(PENDING), available.result)
}

section("what the window's own tree has shown, and a bundle with no engine under a browser's name")
{
  front = reader
  webContent = 'absent'
  const plain = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('a native shell whose window has shown no page surface gets no note', plain.outcome === 'succeeded' && !plain.result.includes(ABSENT), plain.result)
  webSurface = true
  const dropped = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('the same shell once its window has shown a page surface gets the note while the tree carries no page', dropped.outcome === 'succeeded' && linesOf(dropped.result).includes(ABSENT), dropped.result)
  webSurface = false
  front = safari
  const startPage = await call({ action: 'find', target: { text: 'Nowhere' } })
  webContent = 'pending'
  const starting = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('a browser whose bundle carries no engine and whose window shows no page gets neither note: its page, when it has one, is in the tree', startPage.outcome === 'succeeded' && !startPage.result.includes(ABSENT) && starting.outcome === 'succeeded' && !starting.result.includes(PENDING), `${startPage.result}\n${starting.result}`)
  front = unread as DesktopApplication
  webContent = 'absent'
  const unknown = await call({ action: 'find', target: { text: 'Nowhere' } })
  check('an application whose bundle the driver could not read keeps the caution: a missing element is not a confirmed absence there', unknown.outcome === 'succeeded' && linesOf(unknown.result).includes(ABSENT), unknown.result)
}

driver.frontmostApplication = originalFront
driver.accessibilityTree = originalTree
session.forgetDesktopOwner(ownerOf(context))
finish('prove-computer-page-note')
