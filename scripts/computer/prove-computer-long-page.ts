#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/integrations/desktop/resolveDriver.ts')
const session = await import('../../src/integrations/desktop/desktopSession.ts')

type Frame = { x: number; y: number; width: number; height: number }
type Node = { role: string; title?: string; value?: string; frame?: Frame; focused?: boolean; children?: Node[] }

const scratch = scratchDir('long-page')
const bounds: Frame = { x: 0, y: 0, width: 1200, height: 800 }
const POSTS = 100
const WALK_CAP = 2000

const wrapped = (node: Node, levels: number): Node => (levels === 0 ? node : { role: 'AXGroup', frame: node.frame, children: [wrapped(node, levels - 1)] })
const filler = (frame: Frame, count: number): Node[] => Array.from({ length: count }, () => ({ role: 'AXGroup', frame }))

function post(index: number): Node {
  const y = 140 + index * 90
  const frame = { x: 300, y, width: 600, height: 86 }
  return wrapped({ role: 'AXGroup (AXArticle)', frame, children: [
    { role: 'AXLink', title: `Author ${index}`, frame: { x: 310, y: y + 4, width: 120, height: 18 } },
    wrapped({ role: 'AXStaticText', value: `Post ${index} tells its news`, frame: { x: 310, y: y + 26, width: 560, height: 36 } }, 6),
    wrapped({ role: 'AXButton', title: `Like post ${index}`, frame: { x: 310, y: y + 64, width: 60, height: 18 } }, 6),
    ...filler(frame, 11),
  ] }, 3)
}

function browserWindow(page: Node[]): Node[] {
  return [{ role: 'AXWindow', title: 'Feed - Browser', focused: true, frame: bounds, children: [
    { role: 'AXGroup', frame: { x: 0, y: 0, width: 1200, height: 40 }, children: [
      { role: 'AXRadioButton (AXTabButton)', title: 'Feed', frame: { x: 80, y: 6, width: 200, height: 28 } },
      { role: 'AXRadioButton (AXTabButton)', title: 'Inbox - your sign-in code is 000000', frame: { x: 290, y: 6, width: 200, height: 28 } },
    ] },
    { role: 'AXToolbar', frame: { x: 0, y: 40, width: 1200, height: 40 }, children: [
      { role: 'AXButton', title: 'Reload', frame: { x: 90, y: 46, width: 28, height: 28 } },
      { role: 'AXTextField', title: 'Address and search bar', value: 'feed.example/home', frame: { x: 130, y: 46, width: 800, height: 28 } },
    ] },
    wrapped({ role: 'AXWebArea', title: 'Feed', frame: { x: 0, y: 80, width: 1200, height: 720 }, children: page }, 3),
  ] }]
}

const feed: Node[] = [
  { role: 'AXLink', title: 'Home', frame: { x: 40, y: 140, width: 120, height: 24 } },
  { role: 'AXLink', title: 'Explore', frame: { x: 40, y: 180, width: 120, height: 24 } },
  ...Array.from({ length: POSTS }, (_, index) => post(index)),
  { role: 'AXLink', title: 'Release day draws a crowd', frame: { x: 950, y: 200, width: 220, height: 24 } },
]

function sceneFile(name: string, tree: Node[]): string {
  const path = join(scratch, `${name}.json`)
  writeFileSync(path, JSON.stringify({
    displays: [{ index: 0, id: 'proof', originX: 0, originY: 0, width: 1200, height: 800, scale: 1, primary: true }],
    frontmost: { identity: 'com.example.Browser', name: 'Browser', pid: 700, windowId: 'feed', title: 'Feed - Browser', bounds },
    cursor: { x: 10, y: 10 },
    tree,
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
  const walks: Array<{ count: number; depth: number; elements: number; truncated: boolean }> = []
  const whole = resolution.driver.accessibilityTree.bind(resolution.driver)
  resolution.driver.accessibilityTree = async (app, limits, signal) => {
    const tree = await whole(app, limits, signal)
    if (tree.ok) walks.push({ count: limits.count, depth: limits.depth, elements: tree.value.elements.length, truncated: tree.value.truncated })
    return tree
  }
  const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`long-page-${++serial}`, 'Computer', input) as never))
  return { call, walks }
}

const refOf = (listing: string, words: string): number => Number(/\[(\d+)\]/.exec(listing.split('\n').find(line => line.includes(words)) ?? '')?.[1])
const rowsOf = (listing: string): string[] => listing.split('\n').filter(line => /^\s*\[\d+\]/.test(line))

section('a browser window on a long feed: the walk reads its 2000 elements and stops, and the listing shows the rows in view')
const long = await stage(sceneFile('feed', browserWindow(feed)))
const tree = await long.call({ action: 'tree', depth: 32, limit: 500 })
const listed = rowsOf(tree.result)
check('the scene is the one meant: the walk was asked for its caps, came back cut at 2000 elements, and far fewer rows than the limit of 500 are listed', tree.outcome === 'succeeded' && long.walks.at(-1)?.count === WALK_CAP && long.walks.at(-1)?.elements === WALK_CAP && long.walks.at(-1)?.truncated === true && listed.length > 20 && listed.length < 100 && tree.result.includes('truncated:'), JSON.stringify([long.walks.at(-1), listed.length, tree.result.slice(0, 200)]))

section('a ref names one element: an act by ref is not refused because the tree was cut')
{
  const ref = refOf(tree.result, '"Like post 3"')
  const clicked = await long.call({ action: 'click', ref, capture: false })
  check('click by the ref of a row the tree listed lands on that row', Number.isInteger(ref) && clicked.outcome === 'succeeded' && clicked.result.includes('(340, 483) pt') && !clicked.result.includes('truncated'), `ref ${ref}: ${clicked.result}`)
  const again = await long.call({ action: 'tree', depth: 32, limit: 500 })
  const under = await long.call({ action: 'tree', root: refOf(again.result, 'AXWebArea "Feed"'), depth: 32, limit: 500 })
  check('tree under a root given by ref lists that part, and only that part', under.outcome === 'succeeded' && rowsOf(under.result).some(row => row.includes('"Like post 3"')) && !rowsOf(under.result).some(row => row.includes('"Reload"')), under.result.slice(0, 300))
  const found = await long.call({ action: 'find', root: refOf(under.result, 'AXWebArea "Feed"'), target: { role: 'AXButton' }, limit: 500 })
  check('find under a root given by ref answers the matches of that part', found.outcome === 'succeeded' && rowsOf(found.result).some(row => row.includes('"Like post 0"')) && !rowsOf(found.result).some(row => row.includes('"Reload"')), found.result.slice(0, 300))
  const stale = await long.call({ action: 'click', ref: 9999, capture: false })
  check('a ref the latest tree never gave is still refused, by its own sentence', stale.outcome === 'failed' && stale.result.includes('ref:9999: no element of the latest tree matches it now'), stale.result)
  const gone = await long.call({ action: 'tree', root: refOf(again.result, 'AXWebArea "Feed"') })
  check('a root ref an earlier listing gave and the latest one replaced keeps its sentence, word for word', gone.outcome === 'failed' && /^tree refused: ref:\d+: 0 matches in a truncated tree — read tree or take a screenshot$/.test(gone.result), gone.result)
}

finish('prove-computer-long-page')
