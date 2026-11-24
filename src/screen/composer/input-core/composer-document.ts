
import { randomUUID } from 'crypto'
import stripAnsi from 'strip-ansi'

export const SHELF_ITEM_KINDS = [
  'file',
  'image',
  'selection',
  'large-paste',
  'artifact',
  'session-ref',
  'resource',
] as const
export type ShelfItemKind = (typeof SHELF_ITEM_KINDS)[number]

export interface ShelfItem {
  id: string
  kind: ShelfItemKind
  ref: string
  label: string
  state: 'ready' | 'missing' | 'too-large'
  bytes?: number
  lines?: number
}

export interface ComposerDocument {
  v: 1
  scope: string
  body: string
  items: ShelfItem[]
}

const mintItemId = (): string => `csi-${randomUUID().replace(/-/g, '').slice(0, 12)}`

export function createComposerDocument(scope: string): ComposerDocument {
  return { v: 1, scope, body: '', items: [] }
}

export function normalizePastedLines(raw: string): string {
  return stripAnsi(raw).replace(/\r\n?/g, '\n')
}

export function normalizePastedInput(raw: string): string {
  return normalizePastedLines(raw).replaceAll('\t', '    ')
}

export function addShelfItem(
  doc: ComposerDocument,
  item: Pick<ShelfItem, 'kind' | 'ref' | 'label'> & Partial<Pick<ShelfItem, 'state' | 'bytes' | 'lines'>>,
): ComposerDocument {
  const pureRefKinds: ShelfItemKind[] = ['file', 'artifact', 'session-ref', 'resource']
  if (pureRefKinds.includes(item.kind) && doc.items.some(i => i.kind === item.kind && i.ref === item.ref)) {
    return doc
  }
  return {
    ...doc,
    items: [
      ...doc.items,
      { id: mintItemId(), state: 'ready', ...item },
    ],
  }
}
