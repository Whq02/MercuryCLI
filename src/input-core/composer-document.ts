
import { randomUUID } from 'crypto'
import stripAnsi from 'strip-ansi'
import type { PastedContent } from '../utils/config.js'
import { hashPastedText } from '../utils/pasteStore.js'

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

export const SHELF_ITEM_TOO_LARGE_BYTES = 1_048_576

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

export function conversationScope(conversationId: string, base = 'dispatch'): string {
  return `conv:${conversationId}:${base}`
}

export function normalizePastedInput(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n?/g, '\n')
    .replaceAll('\t', '    ')
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function addLargePaste(doc: ComposerDocument, content: string): ComposerDocument {
  const bytes = content.length
  const lines = content.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length
  const item: ShelfItem = {
    id: mintItemId(),
    kind: 'large-paste',
    ref: hashPastedText(content),
    label: `Large paste · ${lines} lines · ${fmtBytes(bytes)}`,
    state: bytes > SHELF_ITEM_TOO_LARGE_BYTES ? 'too-large' : 'ready',
    bytes,
    lines,
  }
  return { ...doc, items: [...doc.items, item] }
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

export function removeShelfItem(
  doc: ComposerDocument,
  id: string,
): { doc: ComposerDocument; removed: ShelfItem | null } {
  const removed = doc.items.find(i => i.id === id) ?? null
  if (!removed) return { doc, removed: null }
  return { doc: { ...doc, items: doc.items.filter(i => i.id !== id) }, removed }
}

export function reorderShelfItem(
  doc: ComposerDocument,
  id: string,
  dir: -1 | 1,
): ComposerDocument {
  const ix = doc.items.findIndex(i => i.id === id)
  if (ix < 0) return doc
  const to = ix + dir
  if (to < 0 || to >= doc.items.length) return doc
  const items = [...doc.items]
  const [moved] = items.splice(ix, 1)
  items.splice(to, 0, moved!)
  return { ...doc, items }
}

export function migrateDraft(
  scope: string,
  draft: string,
  pastedContents: Record<number, PastedContent> | undefined,
): ComposerDocument & {
  bodies: Map<string, string>
} {
  const doc = Object.assign(createComposerDocument(scope), { bodies: new Map<string, string>() })
  doc.body = draft
  if (!pastedContents) return doc
  const seen = new Set<number>()
  const re = /\[(Pasted text|Image) #(\d+)[^\]]*\]/g
  for (const m of draft.matchAll(re)) {
    const n = Number(m[2])
    if (seen.has(n)) continue
    seen.add(n)
    const pc = pastedContents[n]
    if (!pc) {
      doc.items.push({
        id: mintItemId(),
        kind: m[1] === 'Image' ? 'image' : 'large-paste',
        ref: `#${n}`,
        label: `${m[1]} #${n}`,
        state: 'missing',
      })
      continue
    }
    if (pc.type === 'image') {
      doc.items.push({
        id: mintItemId(),
        kind: 'image',
        ref: `image:${pc.id}`,
        label: pc.filename ?? `Image #${pc.id}${pc.mediaType ? ` · ${pc.mediaType}` : ''}`,
        state: 'ready',
        bytes: pc.content.length,
      })
    } else {
      const bytes = pc.content.length
      const lines = pc.content.split('\n').length
      const hash = hashPastedText(pc.content)
      doc.bodies.set(hash, pc.content)
      doc.items.push({
        id: mintItemId(),
        kind: 'large-paste',
        ref: hash,
        label: `Large paste · ${lines} lines · ${fmtBytes(bytes)}`,
        state: bytes > SHELF_ITEM_TOO_LARGE_BYTES ? 'too-large' : 'ready',
        bytes,
        lines,
      })
    }
  }
  return doc
}
