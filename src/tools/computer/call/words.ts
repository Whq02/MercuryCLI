import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import {
  type DesktopApplication,
  type DesktopDriver,
  type DesktopTree,
  type DesktopTreeElement,
  type DesktopTreeLimits,
  TREE_UNANSWERED_REASON,
} from '../../../integrations/desktop/driver.js'
import { type DesktopOutline, type ScreenMap, outlineRowWords, pixelOfPoint, pixelOnScreen, resolveTreeRef } from '../screenMap.js'
import { pageContentNote, targetElement } from '../fastRoad.js'
import {
  FIELD_VALUE_CHARS,
  type Input,
  TREE_DEPTH_CAP,
  TREE_DEPTH_DEFAULT,
  TREE_LIMIT_CAP,
  TREE_LIMIT_DEFAULT,
  TREE_READS,
} from './schema.js'

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
  if (!elements.length) return { refusal: `read ref ${ref}: unavailable or stale — read tree and use its current ref` }
  return targetElement({ ...tree, elements }, {}, map)
}

export function readWords(label: string, text: string, truncated = false): string {
  return `read ${label}: ${JSON.stringify(text.slice(0, 20000))}${truncated || text.length > 20000 ? '\ntruncated: read stops at 20000 characters' : ''}`
}

export function treeLimitsOf(input: Input): DesktopTreeLimits {
  if (TREE_READS.has(input.action)) return { depth: TREE_DEPTH_CAP, count: TREE_LIMIT_CAP, scope: input.scope ?? 'window' }
  const targeted = input.action === 'read' || input.until !== undefined
  return { depth: Math.min(input.depth ?? (targeted ? TREE_DEPTH_CAP : TREE_DEPTH_DEFAULT), TREE_DEPTH_CAP), count: Math.min(input.limit ?? (targeted ? TREE_LIMIT_CAP : TREE_LIMIT_DEFAULT), TREE_LIMIT_CAP), scope: input.scope ?? 'window' }
}

export function treeWords(app: DesktopApplication, tree: DesktopOutline, limits: { depth: number; count: number }, map: ScreenMap | null, points: boolean): string {
  const deepest = tree.elements.reduce((most, element) => Math.max(most, element.depth), 0)
  const lines = [
    `tree: ${app.name} — ${tree.elements.length} element${tree.elements.length === 1 ? '' : 's'} to depth ${deepest}`,
    ...tree.elements.map(element => outlineRowWords(element, map, points)),
  ]
  lines.push(tree.scope === undefined ? 'scope not reported by this driver' : `scope ${tree.scope}`)
  const pageNote = pageContentNote(app, tree)
  if (pageNote) lines.push(pageNote)
  if (tree.truncated) {
    lines.push(`truncated: the tree goes on past ${tree.reason !== null ? tree.reason : `the limit of ${limits.count} elements or depth ${limits.depth}`} — ${tree.reason === TREE_UNANSWERED_REASON ? 'read again, narrow with root or find, or act on what is shown' : 'narrow with root or find, raise limit or depth to read more, or act on what is shown'}`)
  }
  return lines.join('\n')
}

export function fieldsWords(app: DesktopApplication, tree: DesktopOutline, limits: { count: number }, map: ScreenMap | null, points: boolean): string {
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
  if (tree.truncated) lines.push(`truncated: more controls past ${tree.reason ?? `the limit of ${limits.count} controls`} — ${tree.reason === TREE_UNANSWERED_REASON ? 'read again, or narrow with root' : 'raise limit, or narrow with root'}`)
  return lines.join('\n')
}

export async function factsLine(driver: DesktopDriver, map: ScreenMap | null): Promise<string> {
  return `${await cursorWords(driver, map)} · ${await frontmostWords(driver)}`
}
