// ============================================================================
//  input-core/composer-document — B1: the ONE scoped composer
//  document (ComposerDocumentV2).
//
//  A document is a VALUE — {scope, body, items} — where every shelf item is
//  an OWNER REFERENCE, never a body copy: large pastes reference the
//  pasteStore's content hash (the persistent single-body store that already
//  existed), images reference their pasted id/media, files their path,
//  artifacts and sessions their mercury:// refs. The clone-on-enqueue law is
//  satisfied by construction (documents are plain values; cloning one never
//  duplicates a body). Scopes: 'main' · 'dispatch' · 'reply' · 'comment' ·
//  'change-next' — per-scope drafts stop sharing one mutable string (the
//  Wave A review's finding 12).
//
//  THE ONE NORMALIZATION RULE lives here (normalizePastedInput) — extracted
//  verbatim from PromptInput, which now consumes it: strip ANSI, CRLF/CR →
//  LF, tab → 4 spaces. Nothing truncates silently: an oversize paste keeps
//  its honest byte count and reads 'too-large' explicitly.
//
//  Proved by scripts/attention/prove-composer-document.ts; the module +
//  export shape is also repro-journey-f's pin.
// ============================================================================

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
  // a mercury:// resource reference — large content stored
  // once in the resource/artifact plane and carried by ref, never copied.
  'resource',
] as const
export type ShelfItemKind = (typeof SHELF_ITEM_KINDS)[number]

/** Above this, a paste chip reads 'too-large' (the body still stores — the
 *  state is a WARNING about downstream consumers, never a truncation). */
export const SHELF_ITEM_TOO_LARGE_BYTES = 1_048_576

export interface ShelfItem {
  /** Minted here — stable across reorder/undo within the document's life. */
  id: string
  kind: ShelfItemKind
  /** The OWNER reference: pasteStore hash (large-paste) · pasted image id ·
   *  file path · selection descriptor · mercury:// ref. Never a body. */
  ref: string
  /** Human chip label ('Large paste · 200 lines · 2.4 KB', 'x.ts', …). */
  label: string
  state: 'ready' | 'missing' | 'too-large'
  bytes?: number
  lines?: number
}

export interface ComposerDocument {
  v: 1
  scope: string
  /** The typed text, placeholders inline — the refs ARE the truth; chips
   *  project them. */
  body: string
  items: ShelfItem[]
}

const mintItemId = (): string => `csi-${randomUUID().replace(/-/g, '').slice(0, 12)}`

export function createComposerDocument(scope: string): ComposerDocument {
  return { v: 1, scope, body: '', items: [] }
}

/**
 * the per-CONVERSATION draft identity. Cockpit, Console
 * and Minerva share THIS document owner, but each conversation keeps its own
 * draft + shelf: the scope embeds the stable ConversationId, so three
 * surfaces composing into three threads can never share one mutable shelf.
 * `base` distinguishes the composer family within the conversation
 * ('dispatch' · 'reply' · …) — same vocabulary as the surface scopes.
 */
export function conversationScope(conversationId: string, base = 'dispatch'): string {
  return `conv:${conversationId}:${base}`
}

/** THE one paste-normalization rule (extracted from PromptInput verbatim). */
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

/** Add a large paste: the body lives in the pasteStore (by content hash —
 *  the caller persists via storePastedText); the document carries the ref. */
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

/** Add any owner-referenced item (file/selection/artifact/session-ref/image). */
export function addShelfItem(
  doc: ComposerDocument,
  item: Pick<ShelfItem, 'kind' | 'ref' | 'label'> & Partial<Pick<ShelfItem, 'state' | 'bytes' | 'lines'>>,
): ComposerDocument {
  // For the PURE by-reference kinds an identical (kind, ref) IS the same
  // content — re-attach would dispatch the same part twice (the matrix
  // arena observed triple chips from repeated attach presses on one row), so
  // it is a no-op. Body-carrying kinds stay appendable: a selection's ref
  // (its file URI) does not identify its text, an image's ref is mime-derived,
  // and the ACP mapper keys bodies to the JUST-APPENDED item.
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

/** Remove by id — returns the removed item as the undo material. */
export function removeShelfItem(
  doc: ComposerDocument,
  id: string,
): { doc: ComposerDocument; removed: ShelfItem | null } {
  const removed = doc.items.find(i => i.id === id) ?? null
  if (!removed) return { doc, removed: null }
  return { doc: { ...doc, items: doc.items.filter(i => i.id !== id) }, removed }
}

/** Reorder by one step — a pure permutation (same ids, new order). */
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

/**
 * DETERMINISTIC migration of a current-owner draft: walk the draft's
 * placeholders in FIRST-REFERENCE order ([Pasted text #N …] · [Image #N …])
 * and mirror each as an owner-referenced chip. The body keeps the
 * placeholder text verbatim — the submit-time expansion machinery is
 * untouched; the chips are the projection.
 */
export function migrateDraft(
  scope: string,
  draft: string,
  pastedContents: Record<number, PastedContent> | undefined,
): ComposerDocument & {
  /** Bodies the CALLER must persist to the pasteStore — migration itself is
   *  pure and stores nothing (review: hashed refs with never-stored bodies
   *  would dangle). */
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
