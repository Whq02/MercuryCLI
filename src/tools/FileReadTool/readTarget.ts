// ============================================================================
//  FileReadTool/readTarget — the read-target contract at the ONE
//  read boundary. The router CLASSIFIES and DELEGATES; the current owners do
//  the work:
//
//    · file       → the existing FileRead paths (byte-identical — the router
//                    never touches them);
//    · directory  → a deterministic bounded listing rendered HERE (no other
//                    owner exists for directories; stable byte-order sort,
//                    hard cap, named omissions, precise next action);
//    · resource   → the existing resource registry (`resolveResource` — the
//                    same owner Inspect rides; consent-free local state);
//    · url        → a TYPED DELEGATION to the WebFetch owner. Read never
//                    fetches: URL consent belongs to WebFetch's permission
//                    surface, and serving http bytes under Read's blanket
//                    read-allow would bypass it. The result names the exact
//                    next call instead.
//
//  No second fetcher, no attachment cache, no resource store, no recursion:
//  none of the renderers here ever re-enter classification or resolve a
//  nested target. Gate: MERCURY_READ_TARGETS (default-ON; `=0` restores the
//  base Read surface byte-identically — the classifier is never consulted).
//
//  Every non-file result opens with one machine-readable header line:
//    (target: <kind> · owner: <owner> · …counts/state…)
//  Local text files keep their existing content shape exactly (anchors,
//    dedup, cat -n).
//
//  Proof: scripts/edit-tools/prove-read-front-door.ts (suite scripts/edit-tools/).
// ============================================================================

import { readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { resolveResource } from '../../services/resources/registry.js'
import type { ResourceContext } from '../../services/resources/contracts.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The S1 gate (MERCURY_READ_TARGETS, default-on; re-read live). */
export function readTargetsEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_READ_TARGETS'))
}

export type ReadTargetKind = 'file' | 'directory' | 'resource' | 'url'

export interface ReadTarget {
  kind: ReadTargetKind
  /** The caller's raw target string. */
  raw: string
}

/**
 * String-only classification — zero I/O, so validateInput can use it.
 * 'file' is the default: everything that is not a mercury:// ref or an
 * http(s) URL stays on the existing file paths ('directory' is decided at
 * call time by ONE stat on the expanded path — see isDirectoryTarget).
 */
export function classifyReadTarget(raw: string): ReadTarget {
  const s = raw.trim()
  if (s.startsWith('mercury://')) return { kind: 'resource', raw }
  if (/^https?:\/\//i.test(s)) return { kind: 'url', raw }
  return { kind: 'file', raw }
}

/** The ONE call-time stat that upgrades a 'file' target to 'directory'. */
export function isDirectoryTarget(fullPath: string): boolean {
  try {
    return statSync(fullPath).isDirectory()
  } catch {
    return false
  }
}

export interface RenderedTarget {
  /** Model-visible content. First line is the machine-readable header. */
  content: string
  numLines: number
}

/** Hard entry cap — overflow is NAMED and carries the precise next action. */
export const DIRECTORY_ENTRY_CAP = 200

/**
 * Deterministic bounded directory listing: entries sorted by raw byte
 * order (no locale), directories suffixed '/', names only (no sizes, no
 * mtimes — byte-stable for a fixed tree).
 */
export function renderDirectoryTarget(fullPath: string): RenderedTarget {
  let names: string[]
  try {
    const entries = readdirSync(fullPath, { withFileTypes: true })
    names = entries
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const content = `(target: directory · owner: Read · state: unavailable)\n${basename(fullPath)}: ${msg}`
    return { content, numLines: 2 }
  }
  const shown = names.slice(0, DIRECTORY_ENTRY_CAP)
  const omitted = names.length - shown.length
  const lines = [
    `(target: directory · owner: Read · entries: ${shown.length} shown of ${names.length})`,
    ...shown,
  ]
  if (omitted > 0) {
    lines.push(
      `… ${omitted} more entries omitted — next action: narrow with Glob(pattern: "${fullPath}/<pattern>")`,
    )
  }
  return { content: lines.join('\n'), numLines: lines.length }
}

/**
 * Resource targets ride the EXISTING registry. State is always explicit
 * (ok · absent · expired · unavailable) — never optimistic prose. The
 * renderer never resolves children or nested refs (no recursion).
 */
export async function renderResourceTarget(
  ref: string,
  ctx: ResourceContext,
): Promise<RenderedTarget> {
  const result = await resolveResource(ref, ctx)
  if (result.state !== 'ok') {
    const note = 'note' in result && result.note ? result.note : ''
    const lines = [
      `(target: resource · owner: resources · state: ${result.state})`,
      `${ref}: ${result.state}${note ? ` — ${note}` : ''}`,
    ]
    return { content: lines.join('\n'), numLines: lines.length }
  }
  const r = result.resource
  const lines: string[] = [
    `(target: resource · owner: resources · state: ok · kind: ${r.kind})`,
    `${r.title}${r.version ? ` [v ${r.version}]` : ''}`,
    r.summary,
  ]
  if (r.children?.length) {
    lines.push('', `children (${r.children.length}):`)
    for (const c of r.children) {
      lines.push(`  ${c.ref} — ${c.title} (${c.summary})`)
    }
  }
  if (r.text) lines.push('', r.text)
  if (r.page) {
    lines.push(
      '',
      `[page: cursor ${r.page.cursor}${r.page.total !== undefined ? ` of ${r.page.total} lines` : ''}${r.page.hasMore ? ' — more available' : ' — end'}]`,
    )
  }
  return { content: lines.join('\n'), numLines: lines.length }
}

/**
 * URL targets: a typed delegation, never a fetch. WebFetch owns http(s)
 * consent; Read hands over with the exact next call named.
 */
export function renderUrlDelegation(url: string): RenderedTarget {
  const lines = [
    '(target: url · owner: WebFetch · state: delegated)',
    `This target is an http(s) document — it is served by the WebFetch owner (URL consent stays there).`,
    `Next action: call WebFetch with url: ${url.trim()} and a prompt describing what to extract.`,
  ]
  return { content: lines.join('\n'), numLines: lines.length }
}

/** The conditional Read-prompt lines (flag ON). OFF ⇒ the caller keeps the
 *  base line set byte-identically. */
export function readTargetPromptLines(): string {
  return [
    '- This tool also reads directories: pass a directory path to get a deterministic bounded listing (sorted, capped, omissions named). Prefer Glob for pattern-scoped discovery.',
    '- This tool also reads mercury:// resource references (the same records Inspect serves), with explicit ok/absent/unavailable states.',
    '- An http(s) URL target returns a typed delegation naming the exact WebFetch call — Read never fetches the network itself.',
  ].join('\n')
}
