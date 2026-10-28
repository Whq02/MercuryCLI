import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir } from '../computer/computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from '../computer/computerToolKit.ts'
import type { DesktopBounds, DesktopTree, DesktopTreeElement } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resetDesktopDriverForTest, resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const { outlineTree, interactiveRole } = await import('../../src/tools/ComputerTool/screenMap.ts')
const fixtures: Array<{ name: string; rows: string[]; scope: 'window' | 'app'; truncated: boolean; reason: string | null }> = JSON.parse(readFileSync(new URL('fixtures/outline-trees.json', import.meta.url), 'utf8'))
function parseRow(line: string): DesktopTreeElement {
  const match = /^( *)(AX\w+(?: \([^)]+\))?)(.*)$/.exec(line)
  if (!match) throw new Error('unreadable fixture row')
  const rest = match[3]!.trim()
  const title = /^("(?:[^"\\]|\\.)*")/.exec(rest)
  const value = /value=("(?:[^"\\]|\\.)*")/.exec(rest)
  const box = /@(-?\d+),(-?\d+) (\d+)×(\d+)/.exec(rest)
  return { depth: match[1]!.length / 2, role: match[2]!, title: title ? JSON.parse(title[1]!) : null, value: value ? JSON.parse(value[1]!) : null, frame: box ? { x: Number(box[1]), y: Number(box[2]), width: Number(box[3]), height: Number(box[4]) } : null }
}
let serial = 0
const context = toolContext()
async function call(input: Record<string, unknown>) {
  return resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`outline-size-${++serial}`, 'Computer', input) as never))
}
const recordedSizes = [[172, 13228], [82, 6722], [546, 30323], [438, 42432]] as const
check('the replay contains exactly four recorded trees', fixtures.length === recordedSizes.length)
const ratios: Array<{ name: string; rawBytes: number; outlineBytes: number; ratio: number }> = []
for (const [index, fixture] of fixtures.entries()) {
  const elements = fixture.rows.map(parseRow)
  const bounds = elements.find(element => element.role.startsWith('AXWindow'))!.frame as DesktopBounds
  const tree: DesktopTree = { elements, truncated: fixture.truncated, reason: fixture.reason, scope: fixture.scope }
  const path = join(scratchDir('outline-size'), `${fixture.name}.json`)
  writeFileSync(path, JSON.stringify({ frontmost: { identity: 'com.example.Browser', name: 'Browser', pid: 4200, title: 'Window', windowId: fixture.name, bounds } }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = path
  resetDesktopDriverForTest()
  const resolution = resolveDesktopDriver()
  if (resolution.state !== 'ok') throw new Error(resolution.note)
  resolution.driver.accessibilityTree = async () => ({ ok: true, value: tree })
  const result = await call({ action: 'tree', scope: tree.scope })
  const rawBytes = Buffer.byteLength(fixture.rows.join('\n'))
  check(`${fixture.name}: raw row count and byte baseline are pinned`, fixture.rows.length === recordedSizes[index]?.[0] && rawBytes === recordedSizes[index]?.[1])
  const outlineBytes = Buffer.byteLength(result.result)
  ratios.push({ name: fixture.name, rawBytes, outlineBytes, ratio: outlineBytes / rawBytes })
  check(`${fixture.name}: outline is under 33% of recorded raw row bytes`, result.outcome === 'succeeded' && outlineBytes / rawBytes < 0.33, JSON.stringify(ratios.at(-1)))
  check(`${fixture.name}: original truncation is preserved without another cut`, result.result.includes('truncated:') === fixture.truncated && (!fixture.truncated || result.result.includes(fixture.reason!)), result.result.slice(-300))
  const outlined = outlineTree(tree, bounds)
  const dialog = outlined.elements.find(element => element.role.includes('Dialog'))
  if (dialog) {
    const named = result.result.split('\n').find(line => line.includes(dialog.role) && line.includes(JSON.stringify(dialog.title)))!
    const ref = Number(/\[(\d+)\]/.exec(named)?.[1])
    const scoped = await call({ action: 'tree', root: ref })
    const expected = outlineTree(tree, bounds, { root: elements[dialog.sourceIndices[0]!] }).elements
    check(`${fixture.name}: all ${expected.length} kept dialog rows survive root scoping`, scoped.outcome === 'succeeded' && scoped.result.split('\n').filter(line => /^\s*\[\d+\]/.test(line)).length === expected.length && !scoped.result.includes('AXWindow'), scoped.result.slice(0, 500))
  }
  const menu = elements.findIndex(element => element.role === 'AXMenuBar')
  if (menu >= 0) check(`${fixture.name}: zero-size menu entries never reach the model`, outlined.elements.every(row => row.sourceIndices.every(index => index < menu || (elements[index]!.frame !== null && elements[index]!.frame!.width > 0 && elements[index]!.frame!.height > 0))), result.result.slice(-300))
  const reread = await call({ action: 'tree', scope: tree.scope })
  const firstControl = outlined.elements.find(element => interactiveRole(element.role) && element.frame && element.frame.width > 0 && element.frame.height > 0)
  check(`${fixture.name}: a visible actionable control is present`, firstControl !== undefined)
  if (firstControl) {
    const row = reread.result.split('\n').find(line => line.includes(firstControl.role) && (!firstControl.title || line.includes(JSON.stringify(firstControl.title))))!
    const ref = Number(/\[(\d+)\]/.exec(row)?.[1])
    const click = await call({ action: 'click', ref })
    check(`${fixture.name}: ref uses the same uniqueness check without pixels`, fixture.truncated ? click.outcome === 'failed' && click.result.includes('uniqueness is unknown') : click.outcome === 'succeeded', click.result)
  }
  check(`${fixture.name}: every recorded title/value is a placeholder`, elements.every(element => [element.title, element.value].every(text => text === null || /^[x\s]*[a-zA-Z0-9]{0,2}\s*$/.test(text))))
}
console.log(JSON.stringify(ratios, null, 2))
finish('prove-computer-outline-size')
