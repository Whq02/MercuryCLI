
import { readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { resolveResource } from '../../services/resources/registry.js'
import type { ResourceContext } from '../../services/resources/contracts.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function readTargetsEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_READ_TARGETS'))
}

export type ReadTargetKind = 'file' | 'directory' | 'resource' | 'url'

export interface ReadTarget {
  kind: ReadTargetKind
  raw: string
}

export function classifyReadTarget(raw: string): ReadTarget {
  const s = raw.trim()
  if (s.startsWith('mercury://')) return { kind: 'resource', raw }
  if (/^https?:\/\//i.test(s)) return { kind: 'url', raw }
  return { kind: 'file', raw }
}

export function isDirectoryTarget(fullPath: string): boolean {
  try {
    return statSync(fullPath).isDirectory()
  } catch {
    return false
  }
}

export interface RenderedTarget {
  content: string
  numLines: number
}

export const DIRECTORY_ENTRY_CAP = 200

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

export function renderUrlDelegation(url: string): RenderedTarget {
  const lines = [
    '(target: url · owner: WebFetch · state: delegated)',
    `This target is an http(s) document — it is served by the WebFetch owner (URL consent stays there).`,
    `Next action: call WebFetch with url: ${url.trim()} and a prompt describing what to extract.`,
  ]
  return { content: lines.join('\n'), numLines: lines.length }
}

export function readTargetPromptLines(): string {
  return [
    '- This tool also reads directories: pass a directory path to get a deterministic bounded listing (sorted, capped, omissions named). Prefer Glob for pattern-scoped discovery.',
    '- This tool also reads mercury:// resource references (the same records Inspect serves), with explicit ok/absent/unavailable states.',
    '- An http(s) URL target returns a typed delegation naming the exact WebFetch call — Read never fetches the network itself.',
  ].join('\n')
}
