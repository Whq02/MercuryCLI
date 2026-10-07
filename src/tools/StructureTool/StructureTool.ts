import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  structureEnabled,
  structurePolyglotEnabled,
  STRUCTURE_SELECTS,
  type StructurePreview,
  type StructureQuery,
  type StructureTransform,
} from '../../services/structure/contracts.js'
import { runStructureQuery } from '../../services/structure/query.js'
import { applyPreview, buildPreview } from '../../services/structure/transform.js'
import { resolveGrammarEngineDir } from '../../services/structure/grammarFacility.js'
import { getPreview, getQuery, rememberQuery } from '../../services/structure/store.js'
import {
  loadTs,
  parseSource,
  resolveStructureTypescript,
} from '../../services/structure/tsFacility.js'
import { forEachQueryMatch } from '../../services/structure/query.js'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

function lspMounted(offered: ReadonlySet<string> | null): boolean {
  if (offered !== null && !offered.has('LspRename')) return false
  try {
    const { isLspToolMounted } = require('../../services/lsp/manager.js') as typeof import('../../services/lsp/manager.js')
    return isLspToolMounted()
  } catch {
    return false
  }
}
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
    op: z.enum(OPS).describe('The structural operation'),
    select: z.enum(STRUCTURE_SELECTS).optional().describe('query: what to select (function · class · call · import · property · …)'),
    name: z.string().optional().describe('query: name filter — exact or glob with *'),
    callee: z.string().optional().describe('query select:call — dotted callee glob (console.log · fs.* · *.push)'),
    module: z.string().optional().describe('query select:import/export — module specifier glob'),
    value: z.string().optional().describe('query select:string — literal substring'),
    within: z.string().optional().describe("query: ancestor constraint ('class:Name' · 'function:name' · 'class')"),
    files: z.array(z.string()).optional().describe('query: file globs relative to the project root'),
    limit: z.number().optional().describe('query: match bound (default 50, max 200)'),
    queryId: z.string().optional().describe('preview/explain: the query record (sq-…); defaults to the latest'),
    matchIds: z.array(z.string()).optional().describe('preview: match subset (default: every match)'),
    replacement: z.string().optional().describe('preview replace · insert-before · insert-after: the new text ($TEXT, in replace, is the original node)'),
    to: z.string().optional().describe('preview rename/replace-callee: the new name/callee'),
    newModule: z.string().optional().describe('preview replace-import: the new module specifier'),
    newValue: z.string().optional().describe('preview set-value: the new property value text'),
    previewId: z.string().optional().describe('apply: the preview to apply (sp-…)'),
    matchId: z.string().optional().describe('explain: the match to explain (sm-…)'),
    action: z.enum(ACTIONS).optional().describe('preview: the transformation'),
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
import type { OwnerKey } from '../../services/run/ownerKey.js'
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
          `evidence: ${outcome.evidenceRefs.join(' · ')}`,
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

export const StructureTool = buildTool({
  name: 'Structure',
  searchHint: 'JS/TS AST query by node kind, previewed codemod: imports, calls, declarations, renames, import swaps',
  capability: {
    intents: [
      'find JS/TS calls by dotted callee',
      'query declarations imports or exports by shape',
      'transform matching call expressions',
      'rewrite an import specifier everywhere',
      'rename a syntactic construct where lsp rename is unsuitable',
      'set a property value across JS/TS files',
    ],
    units: ['structural-mutation', 'code-intelligence'],
    class: 'mutation',
    operations: ['query', 'preview', 'apply', 'explain'],
    transaction: { kind: 'structure.apply', receipts: true },
    evidence: ['change', 'check'],
    resources: ['structure', 'receipt'],
    preview: true,
    cancellation: 'cooperative',
    latency: 'interactive',
    gate: 'MERCURY_STRUCTURE',
    conditions: ['a typescript compiler facility (workspace package or the vendored copy)'],
    proof: 'scripts/builtin-tools/prove-structure-transform.ts',
  },
  maxResultSizeChars: 60_000,
  async description() {
    return 'Structural source queries and previewed multi-file codemods over JS/TS/JSX/TSX'
  },
  async prompt(options) {
    const offered = options?.tools === undefined ? null : new Set(options.tools.map(tool => tool.name))
    const astAvailable = () => structurePolyglotEnabled() && resolveGrammarEngineDir().state === 'ok'
    const search = offered?.has('AstSearch') ?? astAvailable()
    const edit = offered?.has('AstEdit') ?? astAvailable()
    const shape = search
      ? `To find code by its shape in any language use AstSearch${edit ? ', and AstEdit to rewrite every match' : ''}; use this tool for`
      : edit
        ? 'To rewrite every match of a code shape in any language use AstEdit; use this tool for'
        : 'Use it for'
    return `Structural queries by node kind, and previewed, stale-safe codemods, over JS/TS/JSX/TSX only, on the TypeScript compiler's syntax tree. ${shape} JS/TS questions by node kind — imports by module, calls by dotted callee, declarations by kind and name, a node inside a named class or function — and for a rename, import swap, callee swap or property value that must land as one previewed change.${lspMounted(offered) ? ' For a true symbol rename, a file move or a language-server fix, prefer LspRename, LspMoveFile or LspCodeAction.' : ''}

1. op:"query" (select, filters…) — a bounded AST query. Selects: ${STRUCTURE_SELECTS.join(' · ')}. Filters: name (exact or glob with *), callee ('fs.*'), module, value, within ('class:Name'), files (globs relative to the project root), limit (default 50, max 200). Only .js .jsx .mjs .cjs .ts .mts .cts .tsx files are read. Returns stable match ids (sm-…) and the record mercury://structure/query/<id>.
2. op:"preview" (action, queryId?, matchIds?) — writes nothing; shows the files, the match count and each edit's first line before and after (8 per file, the rest counted). Actions: replace (replacement; $TEXT is the original node) · rename (to — the name token only) · remove · insert-before/insert-after (replacement — new text on its own line at the node's boundary) · replace-import (newModule) · replace-callee (to) · set-value (newValue).
3. op:"apply" (previewId) — refuses if a file changed since the preview or the result would not parse; writes atomically with rollback, verifies by re-reading, reruns parse diagnostics, and reports a partial application as a failure.
4. op:"explain" (matchId, queryId?) — the AST ancestry of one match.

Records: mercury://structure/query/<id> · mercury://structure/preview/<id> (Inspect).`
  },
  userFacingName,
  shouldDefer: true,
  straightQuoteInputs: ['name', 'callee', 'module', 'within', 'files', 'to', 'newModule'],
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isEnabled() {
    return structureEnabled()
  },
  isConcurrencySafe(input: Input) {
    return input?.op === 'query' || input?.op === 'explain'
  },
  isReadOnly(input: Input) {
    return input?.op !== 'apply'
  },
  async checkPermissions(input: Input) {
    if (input.op !== 'apply') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `Structure apply${input.previewId ? ` ${input.previewId}` : ''} (writes the previewed multi-file transformation)`,
    }
  },
  async validateInput(input: Input, context: ToolUseContext) {
    if (!structureEnabled()) {
      return { result: false as const, message: 'the structural plane is disabled (MERCURY_STRUCTURE=0)', errorCode: 1 }
    }
    if (input.op === 'query' && !input.select) {
      return { result: false as const, message: `query requires select: ${STRUCTURE_SELECTS.join(' · ')}`, errorCode: 1 }
    }
    if (input.op === 'query' && input.files?.length && input.files.every(glob => {
      const extension = /(\.[A-Za-z0-9]+)$/.exec(glob)?.[1]?.toLowerCase()
      return extension !== undefined && !SELECT_LANE_EXTS.includes(extension)
    })) {
      const searchOffered = context.options.tools.some(tool => tool.name === 'AstSearch')
      return {
        result: false as const,
        message: `Structure reads only .js .jsx .mjs .cjs .ts .mts .cts .tsx files, and every files glob here ends in another extension (${input.files.join(', ')})${searchOffered ? '. For another language call AstSearch with lang; a symbol by name is its declaration: {"pattern": "def process_order($$$ARGS): $$$BODY", "lang": "python"}.' : '; this session offers no structural search for other languages.'}`,
        errorCode: 1,
      }
    }
    if (input.op === 'preview' && !input.action) {
      return { result: false as const, message: 'preview requires action: replace · rename · remove · insert-before · insert-after · replace-import · replace-callee · set-value', errorCode: 1 }
    }
    if (input.op === 'apply' && !input.previewId) {
      return { result: false as const, message: 'apply requires previewId — the sp-… id a preview returned', errorCode: 1 }
    }
    if (input.op === 'explain' && !input.matchId) {
      return { result: false as const, message: 'explain requires matchId — an sm-… id from a query result', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    let op: { result: string; outcome: ToolEffectOutcome; changedPaths?: string[]; previewId?: string; changeView?: ChangeViewData }
    try {
      op = await runOp(input, context)
    } catch (err) {
      op = { result: `${input.op} failed: ${(err as Error).message}`, outcome: 'failed' }
    }
    const output: Output = {
      op: input.op,
      result: op.result,
      outcome: op.outcome,
      ...(op.changedPaths !== undefined && { changedPaths: op.changedPaths }),
      ...(op.changeView !== undefined && { changeView: op.changeView }),
    }
    return {
      data: output,
      effect: {
        outcome: op.outcome,
        operation: `structure.${input.op}`,
        changedPaths: op.changedPaths ?? [],
        evidence: op.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
        ...(op.previewId !== undefined && { details: { previewId: op.previewId } }),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText({ result, changeView }) {
    return changeView ? `${result}\n${changeViewSearchText(changeView)}` : result
  },
})

export { structureEnabled as isStructureToolCatalogEnabled }
