import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import {
  type DesktopApplication,
  type DesktopDriver,
  type DesktopTree,
  type DesktopTreeElement,
  type DesktopTreeLimits,
  TREE_UNANSWERED_REASON,
} from '../../../integrations/desktop/driver.js'
import { type DesktopOutline, type ScreenMap, addTreeRef, outlineRowWords, pixelOfPoint, pixelOnScreen, resolveTreeRef, treeRefChanged } from '../screenMap.js'
import { type ElementTarget, type HeldTarget, type TreeWalk, candidateWords, pageContentNote, targetElement, targetWords, walkStopWords } from '../fastRoad.js'
import {
  FIELD_VALUE_CHARS,
  type Input,
  TREE_DEPTH_CAP,
  TREE_DEPTH_DEFAULT,
  TREE_LIMIT_CAP,
  TREE_LIMIT_DEFAULT,
  TREE_READS,
} from './schema.js'

export const REF_CHANGED = 'its row or the rows around it changed since the tree was read — read the tree again'

export function interruptedText(action: string): string {
  return `${action} interrupted by the operator — the act in flight ended, held keys and buttons were released, nothing further was done`
}

export function interruptedAfterActText(action: string): string {
  return `${action} interrupted by the operator after the act — no screenshot was taken; held keys and buttons were released, nothing further was done`
}

export function applicationWords(app: DesktopApplication): string {
  return `${app.name}${app.title ? ` — ${app.title}` : ''}`
}

async function cursorWords(driver: DesktopDriver, map: ScreenMap | null): Promise<string> {
  const cursor = await driver.cursor()
  if (!cursor.ok) return `cursor unknown (${cursor.error.note})`
  const at = cursor.value
  if (map !== null && (at.display === null || at.display === map.display)) {
    const pixel = pixelOfPoint(map, at)
    if (pixelOnScreen(map, pixel)) return `cursor (${pixel.x}, ${pixel.y})`
  }
  if (map !== null) return `cursor on display ${at.display ?? '?'}`
  return `cursor (${at.x}, ${at.y}) pt${at.display !== null ? ` on display ${at.display}` : ''}`
}

async function frontmostWords(driver: DesktopDriver): Promise<string> {
  const front = await driver.frontmostApplication()
  if (!front.ok) return `frontmost unknown (${front.error.note})`
  return `frontmost ${applicationWords(front.value)}`
}

export function readRefElement(owner: OwnerKey, app: DesktopApplication, tree: DesktopTree, ref: number, map: ScreenMap | null): DesktopTreeElement | { refusal: string } {
  const elements = resolveTreeRef(owner, app, tree, ref)
  if (!elements.length) return { refusal: treeRefChanged(owner, app, tree, ref) ? `read ref ${ref}: ${REF_CHANGED}` : `read ref ${ref}: unavailable or stale — read tree and use its current ref` }
  return targetElement({ ...tree, elements }, {}, map)
}

function heldWords(tree: DesktopTree, target: ElementTarget, held: HeldTarget, walk: TreeWalk): string {
  const past = `(the tree goes on past ${walkStopWords(tree, walk)})`
  return `${targetWords(target)}: ${target.nth === undefined ? `1 match in the part walked ${past}, so a second match further on is not ruled out` : `match ${target.nth} of ${held.of} in the part walked ${past}; the part not walked may hold others`}`
}

export function heldTargetWords(action: string, owner: OwnerKey, app: DesktopApplication, tree: DesktopTree, target: ElementTarget, held: HeldTarget, walk: TreeWalk, map: ScreenMap | null): string {
  const ref = addTreeRef(owner, app, tree, held.element)
  return ref === null ? `${action} refused: ${heldWords(tree, target, held, walk)} — read the tree and act on its row by ref` : `${action} not done: ${heldWords(tree, target, held, walk)} — act on it by ref\n${candidateWords([held.element], map, ref)}`
}

export function heldFarEndWords(tree: DesktopTree, target: ElementTarget, held: HeldTarget, walk: TreeWalk): string {
  return `drag refused: ${heldWords(tree, target, held, walk)} — the far end of a drag takes no ref: give it as toX/toY from a screenshot`
}

export function readWords(label: string, text: string, truncated = false): string {
  return `read ${label}: ${JSON.stringify(text.slice(0, 20000))}${truncated || text.length > 20000 ? '\ntruncated: read stops at 20000 characters' : ''}`
}

export function treeLimitsOf(input: Input): DesktopTreeLimits {
  if (TREE_READS.has(input.action)) return { depth: TREE_DEPTH_CAP, count: TREE_LIMIT_CAP, scope: input.scope ?? 'window' }
  const targeted = input.action === 'read' || input.until !== undefined
  return { depth: Math.min(input.depth ?? (targeted ? TREE_DEPTH_CAP : TREE_DEPTH_DEFAULT), TREE_DEPTH_CAP), count: Math.min(input.limit ?? (targeted ? TREE_LIMIT_CAP : TREE_LIMIT_DEFAULT), TREE_LIMIT_CAP), scope: input.scope ?? 'window' }
}

function cutWords(tree: DesktopOutline, walk: TreeWalk, tails: { raise: string; again: string }): string {
  if (tree.cut !== null) return `${tree.cut} — ${tails.raise}`
  if (tree.reason === TREE_UNANSWERED_REASON) return `${tree.reason} — ${tails.again}`
  return `${walkStopWords(tree, walk)} — act on a row shown here by its ref, or use a screenshot for the rest`
}

export function treeWords(app: DesktopApplication, tree: DesktopOutline, walk: TreeWalk, map: ScreenMap | null, points: boolean): string {
  const deepest = tree.elements.reduce((most, element) => Math.max(most, element.depth), 0)
  const lines = [
    `tree: ${app.name} — ${tree.elements.length} element${tree.elements.length === 1 ? '' : 's'} to depth ${deepest}`,
    ...tree.elements.map(element => outlineRowWords(element, map, points)),
  ]
  lines.push(tree.scope === undefined ? 'scope not reported by this driver' : `scope ${tree.scope}`)
  const pageNote = pageContentNote(app, tree)
  if (pageNote) lines.push(pageNote)
  if (tree.truncated) lines.push(`truncated: the tree goes on past ${cutWords(tree, walk, { raise: 'narrow with root or find, raise limit or depth to read more, or act on what is shown', again: 'read again, narrow with root or find, or act on what is shown' })}`)
  return lines.join('\n')
}

export function fieldsWords(app: DesktopApplication, tree: DesktopOutline, walk: TreeWalk, map: ScreenMap | null, points: boolean): string {
  const rows = tree.elements.map(element => {
    const secure = element.role.includes('Secure')
    const value = element.value ?? ''
    const parts = [`[${element.ref}]`, element.role]
    if (element.title !== null && element.title.trim() !== '') parts.push(JSON.stringify(element.title))
    parts.push(secure ? '(secure)' : JSON.stringify(value.length > FIELD_VALUE_CHARS ? `${value.slice(0, FIELD_VALUE_CHARS)}…` : value))
    if (points && element.frame && map) {
      const pixel = pixelOfPoint(map, { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 })
      if (pixelOnScreen(map, pixel)) parts.push(`(${pixel.x},${pixel.y})px`)
    }
    return parts.join(' ')
  })
  const lines = [`fields: ${app.name} — ${rows.length} control${rows.length === 1 ? '' : 's'}`, ...rows]
  if (tree.truncated) lines.push(`truncated: more controls past ${cutWords(tree, walk, { raise: 'raise limit, or narrow with root', again: 'read again, or narrow with root' })}`)
  return lines.join('\n')
}

export async function factsLine(driver: DesktopDriver, map: ScreenMap | null): Promise<string> {
  return `${await cursorWords(driver, map)} · ${await frontmostWords(driver)}`
}
