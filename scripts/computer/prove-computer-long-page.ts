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
  const clicks: Array<{ x: number; y: number }> = []
  const press = resolution.driver.click.bind(resolution.driver)
  resolution.driver.click = async (point, button, count, signal) => {
    clicks.push({ x: point.x, y: point.y })
    return press(point, button, count, signal)
  }
  const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`long-page-${++serial}`, 'Computer', input) as never))
  return { call, walks, clicks }
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

section('a walk that stopped at its own bound says which bound, in the walk\'s numbers, and advises only what can work')
{
  const TAIL = ' — act on a row shown here by its ref, or use a screenshot for the rest'
  const COUNT = 'truncated: the tree goes on past the 2000 elements a walk reads at most, unlisted ones included · walk: 2000 elements, depth 16, N ms' + TAIL
  const DEPTH = 'truncated: the tree goes on past depth 32, the deepest a walk reads, unlisted levels included · walk: 34 elements, depth 32, N ms' + TAIL
  const last = (text: string): string => (text.split('\n').find(line => line.startsWith('truncated:')) ?? 'no truncated line').replace(/, \d+ ms/, ', N ms')
  check('the tree read at limit 500 and depth 32 names the 2000 elements the walk read, not the 500 it was asked to list, with the walk\'s three numbers', last(tree.result) === COUNT && /walk: 2000 elements, depth 16, \d+ ms/.test(tree.result), last(tree.result))
  const other = await long.call({ action: 'tree', limit: 400 })
  check('at limit 400 the sentence is the same: the number asked for was never the bound', last(other.result) === COUNT, last(other.result))
  const found = await long.call({ action: 'find', target: { role: 'AXLink' } })
  check('a find on that page says the same of its own listing', found.outcome === 'succeeded' && last(found.result) === COUNT, last(found.result))
  const fields = await long.call({ action: 'fields' })
  check('a fields read says the same with its own opening', last(fields.result) === COUNT.replace('the tree goes on past', 'more controls past'), last(fields.result))
  const deep = await stage(sceneFile('deep', [{ role: 'AXWindow', title: 'Feed - Browser', focused: true, frame: bounds, children: [
    { role: 'AXButton', title: 'Reload', frame: { x: 90, y: 46, width: 28, height: 28 } },
    wrapped({ role: 'AXButton', title: 'Far down', frame: { x: 300, y: 300, width: 80, height: 20 } }, 40),
  ] }]))
  const sunk = await deep.call({ action: 'tree' })
  check('a walk that met an element at depth 32 with more under it names the depth, and the row beneath is not listed', sunk.outcome === 'succeeded' && deep.walks.at(-1)!.elements < WALK_CAP && last(sunk.result) === DEPTH && !sunk.result.includes('Far down'), `${JSON.stringify(deep.walks.at(-1))} ${last(sunk.result)}`)
  const resolution = resolveDesktopDriver()
  if (resolution.state !== 'ok') throw new Error(resolution.note)
  const read = resolution.driver.accessibilityTree.bind(resolution.driver)
  resolution.driver.accessibilityTree = async (app, limits, signal) => {
    const answer = await read(app, limits, signal)
    return answer.ok ? { ok: true, value: { ...answer.value, truncated: true, reason: 'the walk stopped after 6000 ms' } } : answer
  }
  const slow = await deep.call({ action: 'tree' })
  check('a walk that ran out of time keeps its reason, gains its numbers and loses the advice to raise a limit', last(slow.result) === 'truncated: the tree goes on past the walk stopped after 6000 ms · walk: 34 elements, depth 32, N ms' + TAIL, last(slow.result))
  const whole = await stage(sceneFile('short', browserWindow(feed.slice(0, 12))))
  const cut = await whole.call({ action: 'tree', limit: 5 })
  const raised = await whole.call({ action: 'tree', limit: 500 })
  check('a listing cut by the limit asked for keeps its sentence byte for byte, and there the advice works: the same read at a higher limit is whole', whole.walks.at(-1)?.truncated === false && last(cut.result) === 'truncated: the tree goes on past the limit of 5 elements or depth 12 — narrow with root or find, raise limit or depth to read more, or act on what is shown' && !raised.result.includes('truncated:'), `${last(cut.result)} | ${last(raised.result)}`)
}

section('by name on a cut walk: nothing is done on one match, and its ref is handed over; two matches and no match are refused as before')
{
  const CUT = '(the tree goes on past the 2000 elements a walk reads at most, unlisted ones included · walk: 2000 elements, depth 16, N ms)'
  const timed = (text: string): string => text.replace(/, \d+ ms/, ', N ms')
  const page = await stage(sceneFile('feed-by-name', browserWindow(feed)))
  const listing = await page.call({ action: 'tree', depth: 32, limit: 500 })
  const earlier = refOf(listing.result, '"Like post 2"')
  const named = await page.call({ action: 'click', target: { role: 'AXButton', name: 'Like post 3' }, capture: false })
  const handed = Number(/\n\[(\d+)\] AXButton "Like post 3" \(340,483\)pt$/.exec(named.result)?.[1])
  check('a click by a name that one row answers is not done, says why with the walk\'s numbers, and gives that row its ref', named.outcome === 'failed' && page.clicks.length === 0 && timed(named.result).startsWith(`click not done: AXButton "Like post 3": 1 match in the part walked ${CUT}, so a second match further on is not ruled out — act on it by ref\n[`) && Number.isInteger(handed), named.result)
  const byRef = await page.call({ action: 'click', ref: handed, capture: false })
  check('the next call acts on it by that ref', byRef.outcome === 'succeeded' && JSON.stringify(page.clicks) === JSON.stringify([{ x: 340, y: 483 }]), `${byRef.result} ${JSON.stringify(page.clicks)}`)
  const old = await page.call({ action: 'click', ref: earlier, capture: false })
  check('a ref the tree gave before that answer still stands', old.outcome === 'succeeded' && JSON.stringify(page.clicks.at(-1)) === JSON.stringify({ x: 340, y: 393 }), `${old.result} ${JSON.stringify(page.clicks)}`)
  const second = await page.call({ action: 'click', target: { role: 'AXLink', text: 'Author 1', nth: 2 }, capture: false })
  check('an nth that names one of the matches found is answered the same way, with that match', second.outcome === 'failed' && page.clicks.length === 2 && timed(second.result).startsWith(`click not done: AXLink text="Author 1" nth=2: 1 match in the part walked ${CUT}`) && /\n\[\d+\] AXLink "Author 10" /.test(second.result), second.result)
  const many = await page.call({ action: 'click', target: { role: 'AXLink', text: 'Author 1' }, capture: false })
  check('two or more matches are refused as on a whole walk, the candidates listed', many.outcome === 'failed' && page.clicks.length === 2 && many.result.startsWith('click refused: AXLink text="Author 1": 11 matches (ambiguous) — choose target.nth (1-based)\n[1] AXLink "Author 1" ') && many.result.includes('[8] AXLink "Author 16"'), many.result)
  const none = await page.call({ action: 'click', target: { role: 'AXLink', text: 'Release day' }, capture: false })
  check('a name that nothing in the part walked answers is refused with the bound that cut the walk', none.outcome === 'failed' && page.clicks.length === 2 && timed(none.result).startsWith(`click refused: AXLink text="Release day": 0 matches in the part walked ${CUT} — nearest 3 by text\n`), none.result)
  const rooted = await page.call({ action: 'tree', root: { role: 'AXWebArea' } })
  const area = Number(/\n\[(\d+)\] AXWebArea "Feed" /.exec(rooted.result)?.[1])
  const under = await page.call({ action: 'tree', root: area, limit: 500 })
  check('a root given by name is answered the same way, and the tree under its ref lists the page', rooted.outcome === 'failed' && timed(rooted.result).startsWith(`tree not done: AXWebArea: 1 match in the part walked ${CUT}, so a second match further on is not ruled out — act on it by ref\n[`) && under.outcome === 'succeeded' && rowsOf(under.result).some(row => row.includes('"Like post 3"')), `${rooted.result} | ${under.result.slice(0, 200)}`)
  const short = await stage(sceneFile('short-by-name', browserWindow(feed.slice(0, 12))))
  const direct = await short.call({ action: 'click', target: { role: 'AXButton', name: 'Like post 3' }, capture: false })
  check('on a walk that is whole a click by name acts at once, as before', short.walks.find(walk => walk.count === WALK_CAP)?.truncated === false && direct.outcome === 'succeeded' && JSON.stringify(short.clicks) === JSON.stringify([{ x: 340, y: 483 }]), `${direct.result} ${JSON.stringify(short.clicks)}`)
}

finish('prove-computer-long-page')
