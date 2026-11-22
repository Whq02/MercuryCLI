import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { controlCharacterPathRefusal } from '../../utils/path.js'
import {
  structureEnabled,
  STRUCTURE_SELECTS,
  type StructurePreview,
  type StructureQuery,
  type StructureTransform,
} from '../../services/structure/contracts.js'
import { runStructureQuery } from '../../services/structure/query.js'
import { applyPreview, buildPreview } from '../../services/structure/transform.js'
import { getPreview, getQuery, rememberQuery } from '../../services/structure/store.js'
import {
  loadTs,
  parseSource,
  resolveStructureTypescript,
} from '../../services/structure/tsFacility.js'
import { forEachQueryMatch } from '../../services/structure/query.js'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const OPS = ['query', 'preview', 'apply', 'explain'] as const
const ACTIONS = ['replace', 'rename', 'remove', 'replace-import', 'replace-callee', 'set-value', 'insert-before', 'insert-after'] as const
const SELECT_LANE_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx']

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS),
    select: z.enum(STRUCTURE_SELECTS).optional().describe('query: node kind'),
    name: z.string().optional().describe('query: exact name or * glob'),
    callee: z.string().optional().describe('query call: dotted callee glob'),
    module: z.string().optional().describe('query import/export: module glob'),
    value: z.string().optional().describe('query string: literal substring'),
    within: z.string().optional().describe('query: ancestor kind or kind:name'),
    files: z.array(z.string()).optional().describe('query: project-relative globs (.js/.jsx/.mjs/.cjs/.ts/.mts/.cts/.tsx only)'),
    limit: z.number().optional().describe('query: max matches (default 50, max 200)'),
    queryId: z.string().optional().describe('preview/explain: sq-… id (default latest)'),
    matchIds: z.array(z.string()).optional().describe('preview: match subset (default all)'),
    replacement: z.string().optional().describe('preview replace/insert-before/insert-after: new text ($TEXT in replace is the original node; inserts land on their own line at the node boundary)'),
    to: z.string().optional().describe('preview rename/replace-callee: new name/callee (rename changes the token, not every symbol reference)'),
    newModule: z.string().optional().describe('preview replace-import: module specifier'),
    newValue: z.string().optional().describe('preview set-value: property value text'),
    previewId: z.string().optional().describe('apply: sp-… preview id'),
    matchId: z.string().optional().describe('explain: sm-… match id for AST ancestry'),
    action: z.enum(ACTIONS).optional().describe('preview: transform'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type ChangeViewData = {
  state: 'proposed' | 'applied'
  action: string
  files: {
    file: string
    hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
    omittedHunks?: number
    changedLines: number
  }[]
  matchCount?: number
  diagnostics?: { planned: number } | { clean: number; failed: number }
  refs: string[]
}

export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  changedPaths?: string[]
  changeView?: ChangeViewData
}

export function changeViewSearchText(view: ChangeViewData): string {
  const parts: string[] = []
  for (const f of view.files) {
    parts.push(f.file)
    for (const hunk of f.hunks) {
      for (const line of hunk.lines) {
        parts.push(/^[+\- ]/.test(line) ? line.slice(1) : line)
      }
    }
  }
  return parts.join('\n')
}

function changeViewFromPreview(preview: StructurePreview, state: 'proposed' | 'applied'): ChangeViewData {
  return {
    state,
    action: preview.transform.action,
    files: preview.files.map(f => ({
      file: f.file,
      hunks: f.hunks ?? [],
      ...(f.omittedHunks ? { omittedHunks: f.omittedHunks } : {}),
      changedLines: f.changedLines,
    })),
    matchCount: preview.matchCount,
    diagnostics: { planned: preview.diagnosticsPlanned.length },
    refs: [`mercury://structure/preview/${preview.id}`],
  }
}

function transformFrom(input: Input): StructureTransform | { error: string } {
  switch (input.action) {
    case 'replace':
      return input.replacement !== undefined
        ? { action: 'replace', replacement: input.replacement }
        : { error: 'replace needs replacement' }
    case 'insert-before':
    case 'insert-after':
      return input.replacement !== undefined
        ? { action: input.action, text: input.replacement }
        : { error: `${input.action} needs replacement (the inserted text — lands on its own line at the symbol boundary)` }
    case 'rename':
      return input.to ? { action: 'rename', to: input.to } : { error: 'rename needs to' }
    case 'remove':
      return { action: 'remove' }
    case 'replace-import':
      return input.newModule
        ? { action: 'replace-import', module: input.newModule }
        : { error: 'replace-import needs newModule' }
    case 'replace-callee':
      return input.to ? { action: 'replace-callee', to: input.to } : { error: 'replace-callee needs to' }
    case 'set-value':
      return input.newValue !== undefined
        ? { action: 'set-value', value: input.newValue }
        : { error: 'set-value needs newValue' }
    default:
      return { error: 'preview needs action (replace · rename · remove · replace-import · replace-callee · set-value)' }
  }
}

import { listQueries } from '../../services/structure/store.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'
function latestQueryId(owner: OwnerKey): string | null {
  const all = listQueries(owner)
  return all.length > 0 ? all[all.length - 1]!.id : null
}

function describeQueryResult(r: NonNullable<ReturnType<typeof getQuery>>): string {
  const head =
    `${r.id}: ${r.matches.length} match(es) · parsed ${r.parsed}/${r.scanned} scanned · ${r.elapsedMs}ms` +
    `${r.truncated ? ' · TRUNCATED (narrow with files/limit)' : ''}`
  const rows = r.matches
    .slice(0, 30)
    .map(m => `  ${m.id} ${m.file}:${m.range.startLine}:${m.range.startCol} [${m.kind}] ${m.context}`)
  const failures = r.parseFailures.map(f => `  PARSE-FAIL ${f.file}: ${f.message}`)
  return [
    head,
    ...rows,
    ...(r.matches.length > 30 ? [`  … +${r.matches.length - 30} more (mercury://structure/query/${r.id})`] : []),
    ...failures,
    `record: mercury://structure/query/${r.id}`,
  ].join('\n')
}

async function runOp(
  input: Input,
  context: ToolUseContext,
): Promise<{ result: string; outcome: ToolEffectOutcome; changedPaths?: string[]; previewId?: string; changeView?: ChangeViewData }> {
  const owner = ownerFromToolUseContext(context)
  const root = getCwd()

  switch (input.op) {
    case 'query': {
      const query: StructureQuery = {
        select: input.select,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.callee !== undefined && { callee: input.callee }),
        ...(input.module !== undefined && { module: input.module }),
        ...(input.value !== undefined && { value: input.value }),
        ...(input.within !== undefined && { within: input.within }),
        ...(input.files !== undefined && { files: input.files }),
        ...(input.limit !== undefined && { limit: input.limit }),
      }
      const result = runStructureQuery(root, query, {
        signal: context.abortController?.signal,
      })
      if ('state' in result) return { result: result.note, outcome: 'failed' }
      rememberQuery(owner, result)
      return {
        result: describeQueryResult(result),
        outcome: result.matches.length > 0 ? 'succeeded' : 'no-change',
      }
    }
    case 'preview': {
      const queryId = input.queryId ?? latestQueryId(owner)
      if (!queryId) return { result: 'no query recorded — op:"query" first', outcome: 'failed' }
      const queryResult = getQuery(owner, queryId)
      if (!queryResult) return { result: `no query '${queryId}' in this conversation — re-query`, outcome: 'failed' }
      const transform = transformFrom(input)
      if ('error' in transform) return { result: transform.error, outcome: 'failed' }
      const preview = buildPreview(owner, queryResult, input.matchIds, transform)
      if ('reason' in preview) return { result: `preview refused: ${preview.reason}`, outcome: 'failed' }
      const fileRows = preview.files.map(
        f =>
          `  ${f.file}: ${f.edits.length} edit(s), ~${f.changedLines} line(s)\n` +
          f.before.map((b, i) => `    - ${b}\n    + ${f.after[i] ?? ''}`).join('\n') +
          (f.edits.length > f.before.length ? `\n    … +${f.edits.length - f.before.length} more edit(s) in this file, not shown — apply writes all ${f.edits.length}` : ''),
      )
      return {
        result: [
          `${preview.id} [proposed] ${preview.transform.action} — ${preview.matchCount} match(es) · ${preview.files.length} file(s) · ~${preview.totalChangedLines} changed line(s)`,
          ...fileRows,
          `diagnostics planned post-apply: ${preview.diagnosticsPlanned.join(', ')}`,
          `NOTHING written — apply with op:"apply" previewId:"${preview.id}" (stale-safe: refuses if files change first)`,
          `record: mercury://structure/preview/${preview.id}`,
        ].join('\n'),
        outcome: 'succeeded',
        previewId: preview.id,
        changeView: changeViewFromPreview(preview, 'proposed'),
      }
    }
    case 'apply': {
      if (!input.previewId) return { result: 'apply needs previewId (sp-…)', outcome: 'failed' }
      const target = getPreview(owner, input.previewId)
      const outcome = await applyPreview(owner, input.previewId, {
        signal: context.abortController?.signal,
      })
      if (outcome.state === 'refused') {
        return { result: `apply refused [${outcome.code}]: ${outcome.reason}`, outcome: 'failed' }
      }
      const diagRows = outcome.diagnostics.map(
        d => `  ${d.ok ? 'clean' : 'FAIL '} ${d.file}${d.message ? ` — ${d.message}` : ''}`,
      )
      return {
        result: [
          `${input.previewId} APPLIED — ${outcome.changedPaths.length} file(s) written, re-read verified`,
          `post-apply parse diagnostics:`,
          ...diagRows,
          `evidence: ${outcome.evidenceRefs.join(' · ') || 'none'}${outcome.preview.note !== undefined ? ` — ${outcome.preview.note}` : ''}`,
          `record: mercury://structure/preview/${input.previewId} (receipt + transaction refs attach at the exactly-once seam)`,
        ].join('\n'),
        outcome: 'succeeded',
        changedPaths: outcome.changedPaths,
        previewId: input.previewId,
        ...(target
          ? {
              changeView: {
                ...changeViewFromPreview(target, 'applied'),
                diagnostics: {
                  clean: outcome.diagnostics.filter(d => d.ok).length,
                  failed: outcome.diagnostics.filter(d => !d.ok).length,
                },
              },
            }
          : {}),
      }
    }
    case 'explain': {
      const queryId = input.queryId ?? latestQueryId(owner)
      const queryResult = queryId ? getQuery(owner, queryId) : undefined
      if (!queryResult) return { result: 'explain needs a recorded query (op:"query" first)', outcome: 'failed' }
      const match = queryResult.matches.find(m => m.id === input.matchId)
      if (!match) return { result: `no match '${input.matchId ?? ''}' in ${queryResult.id}`, outcome: 'failed' }
      const resolution = resolveStructureTypescript(queryResult.root)
      if (resolution.state === 'unavailable') return { result: resolution.note, outcome: 'failed' }
      const ts = loadTs(resolution.modulePath)
      const full = path.join(queryResult.root, match.file)
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch (err) {
        return { result: `${match.file}: unreadable — ${(err as Error).message}`, outcome: 'failed' }
      }
      const { sourceFile, parseErrors } = parseSource(ts, full, text)
      if (parseErrors.length > 0) {
        return { result: `${match.file}: no longer parses (${parseErrors[0]}) — re-query`, outcome: 'failed' }
      }
      let ancestry: string[] | null = null
      forEachQueryMatch(ts, sourceFile, text, match.file, queryResult.query, (m, node) => {
        if (m.id !== match.id || ancestry) return
        const chain: string[] = []
        let cur: import('typescript').Node | undefined = node
        while (cur && !ts.isSourceFile(cur)) {
          chain.unshift(ts.SyntaxKind[cur.kind]!)
          cur = cur.parent
        }
        ancestry = chain
      })
      if (!ancestry) {
        return { result: `${match.id} no longer reproduces — the file changed since the query; re-query`, outcome: 'failed' }
      }
      return {
        result: [
          `${match.id} ${match.file}:${match.range.startLine}:${match.range.startCol}`,
          `kind: ${match.kind}`,
          `ancestry: ${(ancestry as string[]).join(' → ')}`,
          `text: ${match.text.split('\n').slice(0, 6).join('\n      ')}`,
        ].join('\n'),
        outcome: 'no-change',
      }
    }
  }
}

export const StructureTool: Unbuilt = unbuilt('src/tools/StructureTool/StructureTool.ts:307')
