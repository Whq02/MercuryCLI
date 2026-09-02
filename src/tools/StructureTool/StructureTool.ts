// ============================================================================
//  Structure tool — bounded structural source queries + previewed,
//  transactional codemods over JS/TS/JSX/TSX.
//
//  query    — deterministic bounded AST query (stable match ids);
//  preview  — a write-nothing proposed transformation (exact files, exact
//             matches, before/after, digests + anchors);
//  apply    — stale-safe transactional apply: digest revalidation, parse
//             guard, atomic writes with rollback, re-read verification,
//             parse-diagnostics rerun; the mutation settles through the
//             EXISTING exactly-once effect→receipt→transaction seam;
//  explain  — the AST ancestry of one match.
//
//  Complements the LSP owners: true symbol rename = lsp.rename, file moves
//  = lsp.pathRename, server fixes = code actions. This tool owns
//  SYNTAX-SHAPED work (pattern queries, call rewrites, import rewrites,
//  template codemods) where no language server is required.
//
//  Gate: MERCURY_STRUCTURE (default-on, registered).
//  Proofs: scripts/builtin-tools/prove-structure-query.ts ·
//          prove-structure-transform.ts · the artifact circuit.
// ============================================================================

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
import { runPolyglotQuery, relocatePatternMatches } from '../../services/structure/polyglotQuery.js'
import { runPolyglotSymbolQuery } from '../../services/structure/polyglotSymbols.js'
import {
  applyPolyglotPreview,
  buildPolyglotPreview,
} from '../../services/structure/polyglotTransform.js'
import { POLYGLOT_LANGUAGES } from '../../services/structure/grammarFacility.js'
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
// insert-before/insert-after are first-class boundary actions
// (zero-width, line-oriented) in BOTH lanes — the old idiom (replace with a
// $TEXT template) still works but is not required.
const ACTIONS = ['replace', 'rename', 'remove', 'replace-import', 'replace-callee', 'set-value', 'insert-before', 'insert-after'] as const
const POLYGLOT_ACTIONS = [...ACTIONS, 'rewrite'] as const

/** symbol-lane routing: a select of these kinds with a
 *  polyglot lang pin (or file globs that cannot mean the JS/TS select
 *  lane) rides document-symbol addressing over the grammar engine. */
const SYMBOL_KINDS = ['function', 'class', 'method'] as const
const SELECT_LANE_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx']
function routesToSymbolLane(input: Input): boolean {
  if (!input.select || !(SYMBOL_KINDS as readonly string[]).includes(input.select)) return false
  if (input.lang !== undefined) return !['javascript', 'typescript', 'tsx'].includes(input.lang)
  if (input.files && input.files.length > 0) {
    // Every glob names an extension outside the select lane ⇒ polyglot.
    return input.files.every(g => {
      const m = /(\.[A-Za-z0-9]+)$/.exec(g)
      return m ? !SELECT_LANE_EXTS.includes(m[1]!.toLowerCase()) : false
    })
  }
  return false
}

const baseFields = () => ({
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
  replacement: z.string().optional().describe('preview replace: new node text ($TEXT interpolates the original)'),
  to: z.string().optional().describe('preview rename/replace-callee: the new name/callee'),
  newModule: z.string().optional().describe('preview replace-import: the new module specifier'),
  newValue: z.string().optional().describe('preview set-value: the new property value text'),
  previewId: z.string().optional().describe('apply: the preview to apply (sp-…)'),
  matchId: z.string().optional().describe('explain: the match to explain (sm-…)'),
})

// Family 1: the polyglot pattern lane (MERCURY_STRUCTURE_POLYGLOT,
// default-ON). =0 restores exactly the baseline schema below.
const polyglotInputSchema = () =>
  z.strictObject({
    ...baseFields(),
    pattern: z
      .string()
      .optional()
      .describe(
        "query: an ast-grep-style metavariable pattern ($NAME = one node · $_ = one unbound · $$$NAME = zero-or-more · $$$) matched structurally with per-file language inference — mixed-language scopes welcome; mutually exclusive with select",
      ),
    lang: z
      .string()
      .optional()
      .describe(`query pattern: pin one engine language instead of inference (${POLYGLOT_LANGUAGES.map(l => l.name).join(' · ')})`),
    out: z
      .string()
      .optional()
      .describe('preview rewrite: the output template — $NAME/$$$NAME substitute the captured source; "" deletes the matched node'),
    action: z.enum(POLYGLOT_ACTIONS).optional().describe('preview: the transformation (rewrite = pattern-lane template; insert-before/insert-after = boundary insertion via replacement)'),
    select: z.enum(STRUCTURE_SELECTS).optional().describe('query: what to select (function · class · call · import · property · …). function/class/method with lang python/go/rust (or non-JS/TS files globs) = polyglot symbol addressing'),
  })

const baseInputSchema = () =>
  z.strictObject({
    ...baseFields(),
    action: z.enum(ACTIONS).optional().describe('preview: the transformation'),
  })

const inputSchema = lazySchema(
  () =>
    (structurePolyglotEnabled()
      ? polyglotInputSchema()
      : baseInputSchema()) as ReturnType<typeof polyglotInputSchema>,
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
/** the structured payload behind the ONE inline change view —
 *  semantic-edit results (Structure preview/apply, LSP rename/code-action)
 *  share this shape so the transcript renders syntax-aware hunks, file
 *  headers, counts, diagnostics deltas and resolvable refs from ONE
 *  renderer. Additive beside the text result the model reads. */
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

/** The searchable text of a painted inline change view (HZ7 projection):
 *  the file paths and the hunk lines the operator actually sees, with the
 *  ±/context markers stripped. Shared by every changeView renderer
 *  (Structure, ChangeSet, LSP) so their search text cannot drift from the
 *  one view they all paint. */
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

/** map a preview record to the inline change view payload. */
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
    case 'rewrite':
      return input.out !== undefined
        ? { action: 'rewrite', out: input.out }
        : { error: 'rewrite needs out (the substitution template; "" deletes the match)' }
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

// Latest query per owner (a convenience default, never a substitute for
// explicit ids in multi-query flows).
import { listQueries } from '../../services/structure/store.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
function latestQueryId(owner: OwnerKey): string | null {
  const all = listQueries(owner)
  return all.length > 0 ? all[all.length - 1]!.id : null
}

function describeQueryResult(r: NonNullable<ReturnType<typeof getQuery>>): string {
  // Pattern queries annotate the head; select queries keep the exact
  // baseline format (the =0 byte-parity contract).
  const what = r.query.pattern ? ` (pattern ${JSON.stringify(r.query.pattern.slice(0, 60))})` : ''
  const head =
    `${r.id}${what}: ${r.matches.length} match(es) · parsed ${r.parsed}/${r.scanned} scanned · ${r.elapsedMs}ms` +
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
      if (input.pattern !== undefined && input.select !== undefined) {
        return { result: 'query takes select OR pattern, never both', outcome: 'failed' }
      }
      // the polyglot pattern lane.
      if (input.pattern !== undefined) {
        if (!structurePolyglotEnabled()) {
          return { result: 'pattern queries are disabled (MERCURY_STRUCTURE_POLYGLOT=0) — use select', outcome: 'failed' }
        }
        const query: StructureQuery = {
          pattern: input.pattern,
          ...(input.lang !== undefined && { lang: input.lang }),
          ...(input.files !== undefined && { files: input.files }),
          ...(input.limit !== undefined && { limit: input.limit }),
        }
        const result = await runPolyglotQuery(root, query, {
          signal: context.abortController?.signal,
        })
        if ('state' in result) return { result: result.note, outcome: 'failed' }
        rememberQuery(owner, result)
        return {
          result: describeQueryResult(result),
          outcome: result.matches.length > 0 ? 'succeeded' : 'no-change',
        }
      }
      if (!input.select) return { result: 'query needs select or pattern', outcome: 'failed' }
      // the polyglot SYMBOL lane: document-symbol addressing by
      // (kind, name) for non-JS/TS languages (python · go · rust v1).
      if (routesToSymbolLane(input)) {
        if (!structurePolyglotEnabled()) {
          return { result: 'symbol queries over non-JS/TS need the polyglot lane (MERCURY_STRUCTURE_POLYGLOT=0)', outcome: 'failed' }
        }
        const query: StructureQuery = {
          symbol: { kind: input.select as (typeof SYMBOL_KINDS)[number], name: input.name ?? '*' },
          ...(input.lang !== undefined && { lang: input.lang }),
          ...(input.files !== undefined && { files: input.files }),
          ...(input.limit !== undefined && { limit: input.limit }),
        }
        const result = await runPolyglotSymbolQuery(root, query, {
          signal: context.abortController?.signal,
        })
        if ('state' in result) return { result: result.note, outcome: 'failed' }
        rememberQuery(owner, result)
        return {
          result: describeQueryResult(result),
          outcome: result.matches.length > 0 ? 'succeeded' : 'no-change',
        }
      }
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
      // routing: pattern queries take rewrite; symbol queries take the
      // boundary actions; select queries take the select
      // vocabulary. Cross-lane requests refuse by name.
      if (queryResult.query.pattern !== undefined && transform.action !== 'rewrite') {
        return { result: `${queryId} is a pattern query — preview it with action:"rewrite" (out template)`, outcome: 'failed' }
      }
      if (queryResult.query.symbol !== undefined) {
        if (!structurePolyglotEnabled()) {
          return { result: 'symbol previews are disabled (MERCURY_STRUCTURE_POLYGLOT=0)', outcome: 'failed' }
        }
        const plan =
          transform.action === 'replace'
            ? ({ kind: 'replace', text: transform.replacement } as const)
            : transform.action === 'remove'
              ? ({ kind: 'remove' } as const)
              : transform.action === 'insert-before' || transform.action === 'insert-after'
                ? ({ kind: transform.action, text: transform.text } as const)
                : null
        if (!plan) {
          return { result: `${queryId} is a symbol query — preview it with replace ($TEXT interpolates), remove, insert-before or insert-after`, outcome: 'failed' }
        }
        const preview = await buildPolyglotPreview(owner, queryResult, input.matchIds, plan)
        if ('reason' in preview) return { result: `preview refused: ${preview.reason}`, outcome: 'failed' }
        const fileRows = preview.files.map(
          f =>
            `  ${f.file}: ${f.edits.length} edit(s), ~${f.changedLines} line(s)\n` +
            f.before.map((b, i) => `    - ${b}\n    + ${f.after[i] ?? ''}`).join('\n'),
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
      if (transform.action === 'rewrite') {
        if (!structurePolyglotEnabled()) {
          return { result: 'rewrite previews are disabled (MERCURY_STRUCTURE_POLYGLOT=0)', outcome: 'failed' }
        }
        const preview = await buildPolyglotPreview(owner, queryResult, input.matchIds, { kind: 'rewrite', out: transform.out })
        if ('reason' in preview) return { result: `preview refused: ${preview.reason}`, outcome: 'failed' }
        const fileRows = preview.files.map(
          f =>
            `  ${f.file}: ${f.edits.length} edit(s), ~${f.changedLines} line(s)\n` +
            f.before.map((b, i) => `    - ${b}\n    + ${f.after[i] ?? ''}`).join('\n'),
        )
        return {
          result: [
            `${preview.id} [proposed] rewrite — ${preview.matchCount} match(es) · ${preview.files.length} file(s) · ~${preview.totalChangedLines} changed line(s)`,
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
      const preview = buildPreview(owner, queryResult, input.matchIds, transform)
      if ('reason' in preview) return { result: `preview refused: ${preview.reason}`, outcome: 'failed' }
      const fileRows = preview.files.map(
        f =>
          `  ${f.file}: ${f.edits.length} edit(s), ~${f.changedLines} line(s)\n` +
          f.before.map((b, i) => `    - ${b}\n    + ${f.after[i] ?? ''}`).join('\n'),
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
      // routing: rewrite previews settle through the polyglot lane
      // (same store, same digest law, same receipt seam). F2:
      // symbol-lane previews (any action) ride the same polyglot apply —
      // route by the QUERY behind the preview, not the action name.
      const target = getPreview(owner, input.previewId)
      // The build-time lane stamp is authoritative (the query ring evicts
      // independently of previews — deriving the lane from the query record
      // mis-routed a symbol preview to the TS parser after 16 later
      // queries; closing verify-wave finding). Fallbacks cover
      // older records only.
      const targetQuery = target ? getQuery(owner, target.queryId) : undefined
      const polyglotLane = target?.lane
        ? target.lane === 'polyglot'
        : target?.transform.action === 'rewrite' ||
          targetQuery?.query.pattern !== undefined ||
          targetQuery?.query.symbol !== undefined
      const outcome =
        polyglotLane
          ? await applyPolyglotPreview(owner, input.previewId, {
              signal: context.abortController?.signal,
            })
          : await applyPreview(owner, input.previewId, {
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
      // pattern-lane matches explain via the grammar engine.
      if (queryResult.query.pattern !== undefined) {
        const full = path.join(queryResult.root, match.file)
        let text: string
        try {
          text = readFileSync(full, 'utf8')
        } catch (err) {
          return { result: `${match.file}: unreadable — ${(err as Error).message}`, outcome: 'failed' }
        }
        const relocated = await relocatePatternMatches(match.file, text, queryResult.query)
        if (relocated.state === 'refused') return { result: relocated.note, outcome: 'failed' }
        const hit = relocated.byId.get(match.id)
        if (!hit) {
          return { result: `${match.id} no longer reproduces — the file changed since the query; re-query`, outcome: 'failed' }
        }
        return {
          result: [
            `${match.id} ${match.file}:${match.range.startLine}:${match.range.startCol}`,
            `language: ${match.language ?? 'unknown'} · node: ${hit.nodeType}`,
            hit.captures.length
              ? `captures: ${hit.captures.map(c => `${c.key} = ${c.text.split('\n')[0]!.slice(0, 60)}`).join(' · ')}`
              : 'captures: none',
            `text: ${hit.nodeText.split('\n').slice(0, 6).join('\n      ')}`,
          ].join('\n'),
          outcome: 'no-change',
        }
      }
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
  // Discovery surface is BOOT-LATCHED like the schema: the OFF lane is
  // never advertised (the an-OFF-owner-is-never-advertised law).
  searchHint: structurePolyglotEnabled()
    ? 'structural AST query and codemod: find calls imports declarations by shape or metavariable pattern across python go rust js ts, preview and apply multi-file syntax transformations'
    : 'structural AST query and codemod: find calls imports declarations by shape, preview and apply multi-file syntax transformations',
  capability: {
    intents: [
      'find call expressions matching a pattern',
      'query declarations imports or exports by shape',
      'transform matching call expressions',
      'apply a template codemod across files',
      'rewrite an import specifier everywhere',
      'rename a syntactic construct where lsp rename is unsuitable',
      ...(structurePolyglotEnabled()
        ? [
            'find this code structure across languages',
            'search python go or rust code structurally',
            'rewrite a matched pattern in many files',
          ]
        : []),
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
  async prompt() {
    const polyglot = structurePolyglotEnabled()
    return `Bounded structural source-code queries and previewed, stale-safe codemods${polyglot ? ' — JS/TS/JSX/TSX select queries plus POLYGLOT metavariable patterns' : ' over JS/TS/JSX/TSX'} (the syntax owner — for TRUE symbol rename, file moves, or server fixes prefer the LSP tool, the semantic owner).

1. op:"query" (select, filters…) — deterministic bounded AST query. Selects: ${STRUCTURE_SELECTS.join(' · ')}. Filters: name (glob), callee ('fs.*'), module, value, within ('class:Name'), files (globs), limit. Returns stable match ids (sm-…) + mercury://structure/query/<id>.${
      polyglot
        ? `\n   op:"query" (pattern, lang?, files?, limit?) — the POLYGLOT pattern lane: an ast-grep-style pattern ($NAME captures one node · $_ matches one · $$$NAME captures zero-or-more · $$$) matched structurally with per-file language inference across ${POLYGLOT_LANGUAGES.map(l => l.name).join('/')}. Mixed-language directory scopes work; files that do not parse are reported per file, never guessed over. Example: pattern:"print($X)" lang:"python".
   SYMBOL ADDRESSING (no pattern needed): select:"function"|"class"|"method" + name (glob) with lang:"python"|"go"|"rust" (or files globs naming those extensions) addresses document symbols by name over the same engine — e.g. select:"function" name:"process_order" lang:"python". Other engine languages refuse by name (use a pattern).`
        : ''
    }
2. op:"preview" (action, queryId?, matchIds?) — a WRITE-NOTHING proposed transformation over matched nodes: exact files, exact match count, before/after, expected anchors, planned diagnostics. Actions: replace (replacement, $TEXT interpolates the original) · rename (to — the name token only) · remove · insert-before/insert-after (replacement — NEW text on its own line at the symbol boundary; the matched node's bytes untouched) · replace-import (newModule) · replace-callee (to) · set-value (newValue).${
      polyglot
        ? ` Pattern queries preview with action:"rewrite" (out — the template; $NAME/$$$NAME substitute the captured source, "" deletes the match). Symbol queries take replace/remove/insert-before/insert-after.`
        : ''
    }
3. op:"apply" (previewId) — revalidates every file digest (a changed file REFUSES: stale preview), parse-guards the transformed output, writes atomically with rollback on midway failure, verifies by re-read, reruns parse diagnostics, and settles through the exactly-once receipt→transaction seam. Partial application is reported as FAILURE, never success.
4. op:"explain" (matchId, queryId?) — the AST ancestry of one match.

Everything is bounded and inspectable: mercury://structure/query/<id> · mercury://structure/preview/<id> (Inspect).`
  },
  userFacingName,
  shouldDefer: true,
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
  toAutoClassifierInput(input: Input) {
    return `structure ${input.op}: ${input.select ?? input.action ?? input.previewId ?? ''}`
  },
  async validateInput(input: Input) {
    if (!structureEnabled()) {
      return { result: false as const, message: 'the structural plane is disabled (MERCURY_STRUCTURE=0)', errorCode: 1 }
    }
    if (input.op === 'query' && !input.select && input.pattern === undefined) {
      return {
        result: false as const,
        message: structurePolyglotEnabled() ? 'query requires select or pattern' : 'query requires select',
        errorCode: 1,
      }
    }
    if (input.op === 'preview' && !input.action) {
      return { result: false as const, message: 'preview requires action', errorCode: 1 }
    }
    if (input.op === 'apply' && !input.previewId) {
      return { result: false as const, message: 'apply requires previewId', errorCode: 1 }
    }
    if (input.op === 'explain' && !input.matchId) {
      return { result: false as const, message: 'explain requires matchId', errorCode: 1 }
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
  // HZ7 projection: the renderer paints `result` or the inline change
  // view's hunks — search indexes both.
  extractSearchText({ result, changeView }) {
    return changeView ? `${result}\n${changeViewSearchText(changeView)}` : result
  },
})

export { structureEnabled as isStructureToolCatalogEnabled }
