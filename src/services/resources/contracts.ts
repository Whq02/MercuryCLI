// ============================================================================
//  resources/contracts — ONE typed reference vocabulary for Mercury's work
//  graph.
//
//  Ref grammar:   mercury://<kind>/<id-or-path>[?selector&selector…]
//    · <id-or-path> may contain slashes (file paths, scoped ids) — everything
//      between the kind and the '?' belongs to the id.
//    · selectors are bounded reads, never storage coordinates:
//        lines=A-B     (text ranges)     q=<substring>   (search within text)
//        cursor=<n>    (pagination)      limit=<n>        (page size)
//        child=<name>  (a named sub-resource)
//
//  Model-visible refs NEVER encode storage layout: the adapter owns the
//  mapping from id → wherever the object actually lives. A missing object is
//  NEVER an empty object: adapters answer with an explicit state —
//  absent (id never existed) · expired (retention dropped it) ·
//  unavailable (subsystem off/gated) · busy (temporarily locked).
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const MERCURY_REF_SCHEME = 'mercury://'

export interface ParsedRef {
  kind: string
  id: string
  selectors: {
    lines?: { start: number; end: number }
    q?: string
    cursor?: number
    limit?: number
    child?: string
  }
  /** The canonical printable form (selector-free). */
  canonical: string
  /** The original string as given. */
  raw: string
}

export interface ResourceContext {
  owner: OwnerKey
  cwd: string
  /** Present when resolved from a tool call / UI pane; adapters needing
   *  session state (background agents) answer 'unavailable' without it. */
  getAppState?: () => unknown
}

export interface ResourceChild {
  ref: string
  title: string
  summary: string
}

export interface Resource {
  ref: string
  kind: string
  title: string
  summary: string
  /** Revision/digest for staleness reporting on resume (durable kinds). */
  version?: string
  mutable: boolean
  children?: ResourceChild[]
  /** Bounded text view (never a full dump — page with cursor/limit). */
  text?: string
  /** Bounded structured view. */
  structured?: unknown
  sourceRefs?: string[]
  page?: { cursor: number; hasMore: boolean; total?: number }
}

export type ResourceResult =
  | { state: 'ok'; resource: Resource }
  | { state: 'absent'; note: string }
  | { state: 'expired'; note: string }
  | { state: 'unavailable'; note: string }
  | { state: 'busy'; note: string }

export interface ResourceAdapter {
  kind: string
  /** One line for the Inspect prompt + /capabilities. */
  describe: string
  resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult>
  /** Kind-level listing (`mercury://<kind>` with no id), when meaningful. */
  list?(ctx: ResourceContext): Promise<ResourceChild[]>
}

/** The resource-plane gate (MERCURY_REFS in flagRegistry.ts, default-on). */
export function mercuryRefsEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_REFS'))
}

export function formatRef(kind: string, id: string): string {
  return `${MERCURY_REF_SCHEME}${kind}${id ? `/${id}` : ''}`
}

export function isMercuryRef(value: string): boolean {
  return value.startsWith(MERCURY_REF_SCHEME)
}

const KIND_RE = /^[a-z][a-z0-9-]*$/

export function parseMercuryRef(raw: string): ParsedRef | null {
  if (!isMercuryRef(raw)) return null
  const body = raw.slice(MERCURY_REF_SCHEME.length)
  const qIdx = body.indexOf('?')
  const pathPart = qIdx === -1 ? body : body.slice(0, qIdx)
  const queryPart = qIdx === -1 ? '' : body.slice(qIdx + 1)
  const slash = pathPart.indexOf('/')
  const kind = slash === -1 ? pathPart : pathPart.slice(0, slash)
  const id = slash === -1 ? '' : pathPart.slice(slash + 1)
  if (!KIND_RE.test(kind)) return null

  const selectors: ParsedRef['selectors'] = {}
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const key = pair.slice(0, eq)
      const value = decodeURIComponent(pair.slice(eq + 1))
      switch (key) {
        case 'lines': {
          const m = value.match(/^(\d+)-(\d+)$/)
          if (m) {
            const start = Number(m[1])
            const end = Number(m[2])
            if (start >= 1 && end >= start) selectors.lines = { start, end }
          }
          break
        }
        case 'q':
          if (value.length > 0) selectors.q = value.slice(0, 200)
          break
        case 'cursor': {
          const n = Number(value)
          if (Number.isInteger(n) && n >= 0) selectors.cursor = n
          break
        }
        case 'limit': {
          const n = Number(value)
          if (Number.isInteger(n) && n >= 1) selectors.limit = Math.min(n, 500)
          break
        }
        case 'child':
          if (value.length > 0) selectors.child = value.slice(0, 100)
          break
        default:
          break
      }
    }
  }
  return {
    kind,
    id,
    selectors,
    canonical: formatRef(kind, id),
    raw,
  }
}

/** Bounded text view: apply lines/q/cursor/limit selectors deterministically. */
export function boundedTextView(
  fullText: string,
  selectors: ParsedRef['selectors'],
  defaultLimit = 200,
  opts?: {
    /** With no explicit cursor/lines selector, serve the LAST window instead
     *  of the first — for streams whose verdict lives at the end (agent
     *  transcripts; the HEAD-ONLY-PREVIEW law, Q11). An explicit
     *  cursor/lines selector keeps head-anchored deterministic paging. */
    defaultToTail?: boolean
  },
): { text: string; page: { cursor: number; hasMore: boolean; total: number } } {
  let lines = fullText.split('\n')
  if (selectors.lines) {
    lines = lines.slice(selectors.lines.start - 1, selectors.lines.end)
  }
  if (selectors.q) {
    const needle = selectors.q.toLowerCase()
    lines = lines.filter(l => l.toLowerCase().includes(needle))
  }
  const total = lines.length
  const limit = selectors.limit ?? defaultLimit
  const cursor =
    selectors.cursor ??
    (opts?.defaultToTail && !selectors.lines ? Math.max(0, total - limit) : 0)
  const pageLines = lines.slice(cursor, cursor + limit)
  return {
    text: pageLines.join('\n'),
    page: { cursor, hasMore: cursor + limit < total, total },
  }
}

/** The explicit paging line a clipped view appends so a reader can REACH the
 *  rest. */
export function pageHint(
  page: { cursor: number; hasMore: boolean; total: number },
  shown: number,
): string | undefined {
  if (page.cursor === 0 && !page.hasMore) return undefined
  return `[lines ${page.cursor + 1}–${page.cursor + shown} of ${page.total} — page with ?cursor=<n>&limit=<n>]`
}
