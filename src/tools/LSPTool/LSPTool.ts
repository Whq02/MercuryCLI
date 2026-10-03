import type { UUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { z } from 'zod/v4'

import { buildTool, type ToolEffect, type ToolUseContext } from '../../Tool.js'
import {
  getInitializationStatus,
  getLspServerManager,
  isLspToolMounted,
  waitForInitialization,
} from '../../services/lsp/manager.js'
import {
  mercuryLspEnabled,
  mercuryLspWriteOpsEnabled,
} from '../../services/lsp/mercuryLsp.js'
import {
  clearLspCall,
  LSP_TRIES_BEFORE_REFUSAL,
  lspCallKey,
  lspCallRefusal,
  lspServerRefusal,
  recordLspCallFailure,
  recordLspServerFailure,
} from '../../services/lsp/failureLedger.js'
import { remedyForLanguageServer, serverTitle, unclaimedCause } from '../../services/lsp/failureWords.js'
import { isLspStartFailure } from '../../services/lsp/LSPServerInstance.js'
import { runWithLspAbortSignal } from '../../services/lsp/lspAbort.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
} from '../../utils/permissions/filesystem.js'
import { changeViewSearchText } from '../StructureTool/StructureTool.js'
import {
  runMercuryLspOp,
  type MercuryLspOpInput,
  type MercuryLspOpOutput,
} from './mercuryOps.js'
import {
  boundWorkspaceSymbols,
  formatDocumentSymbolResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatPrepareCallHierarchyResult,
  formatWorkspaceSymbolResult,
  uriToPath,
  type Locationish,
} from './formatters.js'
import { DESCRIPTION, getLspToolDescription, LSP_TOOL_NAME } from './prompt.js'
import {
  BASE_LSP_OPERATIONS,
  BRIDGE_LSP_OPERATIONS,
  lspToolInputSchema,
  type LSPToolInput,
} from './schemas.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'


const MAX_ANALYZABLE_FILE_BYTES = 10_000_000
const WORKSPACE_SYMBOL_DEFAULT_LIMIT = 50
const WORKSPACE_SYMBOL_MAX_LIMIT = 200
const EVIDENCE_MAX_CHARS = 160
const CHECK_IGNORE_BATCH = 50
const CHECK_IGNORE_TIMEOUT_MS = 5_000

const MERCURY_BRIDGE_OPERATIONS = new Set([
  'diagnostics',
  'rename',
  'codeActions',
  'switchSourceHeader',
  'typeDefinition',
  'serverStatus',
  'workspaceDiagnostics',
  'pathRename',
  'fixDiagnostic',
  'formatDocument',
  'formatRange',
  'organizeImports',
  'capabilities',
  'rawRequest',
  'moveSymbol',
])

const WRITE_CAPABLE_OPERATIONS: ReadonlySet<string> = new Set([
  'rename',
  'codeActions',
  'pathRename',
  'fixDiagnostic',
  'formatDocument',
  'formatRange',
  'organizeImports',
  'moveSymbol',
])

type LooseInput = Partial<{
  operation: string
  filePath: string
  line: number
  character: number
  endLine: number
  endCharacter: number
  query: string
  limit: number
  newName: string
  newPath: string
  apply: boolean
  actionId: string
  actionIndex: number
  paths: string[]
  method: string
  params: string
  plan: string
  kind: string
  targetPath: string
}>

function isMercuryApplyOp(input: LooseInput | undefined): boolean {
  if (!input || !input.operation) return false
  if (input.operation === 'rawRequest') return true
  return WRITE_CAPABLE_OPERATIONS.has(input.operation) && input.apply === true
}

export type Input = LSPToolInput

type LspChangeView = NonNullable<MercuryLspOpOutput['changeView']>

export type Output = {
  operation: string
  result: string
  filePath: string
  resultCount?: number
  fileCount?: number
  applied?: boolean
  outcome?: 'succeeded' | 'failed' | 'no-change' | 'indeterminate'
  changeView?: LspChangeView
  edits?: NonNullable<MercuryLspOpOutput['edits']>
  omittedEdits?: number
  plan?: string
}

const lspPermissionShim = {
  name: LSP_TOOL_NAME,
  getPath(input?: { filePath?: string }): string {
    return input?.filePath || getCwd()
  },
}

const outputSchema = lazySchema(() => {
  const base = {
    operation: z.string(),
    result: z.string(),
    filePath: z.string(),
    resultCount: z.number().optional(),
    fileCount: z.number().optional(),
  }
  if (!mercuryLspEnabled()) return z.object(base)
  return z.object({
    ...base,
    applied: z.boolean().optional(),
    outcome: z.enum(['succeeded', 'failed', 'no-change', 'indeterminate']).optional(),
    changeView: z
      .object({
        state: z.enum(['proposed', 'applied']),
        action: z.string(),
        files: z.array(
          z.object({
            file: z.string(),
            hunks: z.array(
              z.object({
                oldStart: z.number(),
                oldLines: z.number(),
                newStart: z.number(),
                newLines: z.number(),
                lines: z.array(z.string()),
              }),
            ),
            omittedHunks: z.number().optional(),
            changedLines: z.number(),
          }),
        ),
        refs: z.array(z.string()),
      })
      .optional(),
    edits: z
      .array(
        z.object({
          file: z.string(),
          range: z.object({
            start: z.object({ line: z.number(), character: z.number() }),
            end: z.object({ line: z.number(), character: z.number() }),
          }),
          before: z.string(),
          after: z.string(),
        }),
      )
      .optional(),
    omittedEdits: z.number().optional(),
    plan: z.string().optional(),
  })
})


const flatSchema = lazySchema(() => {
  const bridge = mercuryLspEnabled()
  const operations = bridge
    ? [...BASE_LSP_OPERATIONS, ...BRIDGE_LSP_OPERATIONS]
    : [...BASE_LSP_OPERATIONS]
  const base = {
    operation: z
      .enum(operations as [string, ...string[]])
      .describe('The language-server operation to perform'),
    filePath: z.string().optional().describe('Absolute path to the file'),
    line: z.number().int().positive().optional().describe('1-based line number'),
    character: z.number().int().positive().optional().describe('1-based character position'),
    query: z.string().optional().describe('workspaceSymbol: the symbol name to search for'),
    limit: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_SYMBOL_MAX_LIMIT)
      .optional()
      .describe('workspaceSymbol: maximum symbols to return'),
  }
  if (!bridge) return z.strictObject(base)
  return z.strictObject({
    ...base,
    newName: z.string().optional().describe('rename: the new symbol name'),
    newPath: z.string().optional().describe('pathRename: the destination path'),
    apply: z.boolean().optional().describe('Write the change (default: preview)'),
    actionId: z.string().optional().describe('codeActions/fixDiagnostic: stable action id'),
    actionIndex: z.number().int().min(0).optional().describe('codeActions: legacy positional selector'),
    endLine: z.number().int().positive().optional().describe('Range end line'),
    endCharacter: z.number().int().positive().optional().describe('Range end character'),
    paths: z.array(z.string()).optional().describe('workspaceDiagnostics: files/directories (max 50)'),
    plan: z.string().optional().describe('apply: the plan token the dry run printed (lsp-…)'),
    kind: z.string().optional().describe('codeActions: a code-action kind to filter by (quickfix, refactor, source.organizeImports, source.addMissingImports, source.removeUnusedImports, source.removeUnused)'),
    targetPath: z.string().optional().describe('moveSymbol: the file the declaration moves to'),
    method: z.string().optional().describe('rawRequest: the LSP request method (e.g. textDocument/documentHighlight)'),
    params: z.string().optional().describe('rawRequest: the request params as JSON text'),
  })
})


function makeEffect(
  operation: string,
  outcome: ToolEffect['outcome'],
  result: string,
  startedAt: number,
  overrides: Partial<ToolEffect> = {},
): ToolEffect {
  return {
    outcome,
    operation: `lsp.${operation}`,
    changedPaths: [],
    evidence: (result.split('\n')[0] ?? '').slice(0, EVIDENCE_MAX_CHARS),
    startedAt,
    completedAt: Date.now(),
    ...overrides,
  }
}


function getMethodAndParams(
  input: Input,
  documentPath: string,
): { method: string; params: unknown } {
  const uri = pathToFileURL(documentPath).toString()
  const line = 'line' in input ? (input as { line?: number }).line : undefined
  const character = 'character' in input ? (input as { character?: number }).character : undefined
  const position =
    line !== undefined && character !== undefined
      ? { line: line - 1, character: character - 1 }
      : undefined
  switch (input.operation) {
    case 'goToDefinition':
      return { method: 'textDocument/definition', params: { textDocument: { uri }, ...(position !== undefined ? { position } : {}) } }
    case 'findReferences':
      return {
        method: 'textDocument/references',
        params: {
          textDocument: { uri },
          ...(position !== undefined ? { position } : {}),
          context: { includeDeclaration: true },
        },
      }
    case 'hover':
      return { method: 'textDocument/hover', params: { textDocument: { uri }, ...(position !== undefined ? { position } : {}) } }
    case 'documentSymbol':
      return { method: 'textDocument/documentSymbol', params: { textDocument: { uri } } }
    case 'goToImplementation':
      return { method: 'textDocument/implementation', params: { textDocument: { uri }, ...(position !== undefined ? { position } : {}) } }
    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls':
      return { method: 'textDocument/prepareCallHierarchy', params: { textDocument: { uri }, ...(position !== undefined ? { position } : {}) } }
    default:
      throw new Error(`No base LSP method mapping for operation: ${input.operation}`)
  }
}


async function gitIgnoredPaths(paths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  if (paths.length === 0) return ignored
  for (let start = 0; start < paths.length; start += CHECK_IGNORE_BATCH) {
    const batch = paths.slice(start, start + CHECK_IGNORE_BATCH)
    try {
      const result = await execFileNoThrow('git', ['check-ignore', ...batch], {
        timeout: CHECK_IGNORE_TIMEOUT_MS,
      })
      if (result.code === 0 && result.stdout.length > 0) {
        for (const line of result.stdout.split('\n')) {
          if (line.trim() !== '') ignored.add(line.trim())
        }
      }
    } catch {
    }
  }
  return ignored
}

async function filterLocationsByGitignore<T>(
  entries: T[],
  uriOf: (entry: T) => string | undefined,
): Promise<T[]> {
  const uniquePaths: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const uri = uriOf(entry)
    if (uri === undefined) continue
    const path = uriToPath(uri)
    if (!seen.has(path)) {
      seen.add(path)
      uniquePaths.push(path)
    }
  }
  const ignored = await gitIgnoredPaths(uniquePaths)
  if (ignored.size === 0) return entries
  return entries.filter(entry => {
    const uri = uriOf(entry)
    if (uri === undefined) return true
    return !ignored.has(uriToPath(uri))
  })
}


type CountedLocation = { uri?: string }

function locationCounts(entries: CountedLocation[]): { resultCount: number; fileCount: number } {
  const uris = new Set<string>()
  let valid = 0
  for (const entry of entries) {
    if (entry.uri === undefined) {
      logError(new Error('LSP result entry has no URI (malformed server data)'))
      continue
    }
    valid++
    uris.add(entry.uri)
  }
  return { resultCount: valid, fileCount: uris.size }
}

function documentSymbolCounts(result: unknown[]): { resultCount: number; fileCount: number } {
  const first = result[0] as { location?: unknown } | undefined
  if (first?.location !== undefined) {
    return { resultCount: result.length, fileCount: result.length > 0 ? 1 : 0 }
  }
  const countTree = (nodes: Array<{ children?: unknown[] }>): number =>
    nodes.reduce(
      (total, node) =>
        total + 1 + (node.children ? countTree(node.children as Array<{ children?: unknown[] }>) : 0),
      0,
    )
  return {
    resultCount: countTree(result as Array<{ children?: unknown[] }>),
    fileCount: result.length > 0 ? 1 : 0,
  }
}


type ZodIssueLike = { code?: string; path?: Array<string | number>; message?: string; expected?: string; keys?: string[] }

const ARGUMENT_EXAMPLES: Record<string, string> = {
  filePath: '"/absolute/path/to/file"',
  line: '<1-based line>',
  character: '<1-based character>',
  endLine: '<1-based end line>',
  endCharacter: '<1-based end character>',
  query: '"<symbol name>"',
  limit: '<1-200>',
  newName: '"<new name>"',
  newPath: '"/absolute/new/path"',
  targetPath: '"/absolute/target/file"',
  paths: '["<file or directory>", …]',
  method: '"textDocument/<method>"',
  params: '"<JSON text>"',
  apply: 'true',
  plan: '"<plan token>"',
  kind: '"<code-action kind>"',
  actionId: '"<action id>"',
  actionIndex: '<index>',
}

function validShapeOf(operation: string): string {
  const union = lspToolInputSchema() as unknown as { options?: Array<{ shape?: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }> }
  const member = (union.options ?? []).find(option => {
    const literal = option.shape?.operation as { value?: string; values?: Set<string> } | undefined
    return literal?.value === operation || literal?.values?.has(operation) === true
  })
  if (member?.shape === undefined) return ''
  const required: string[] = []
  const optional: string[] = []
  for (const [key, schema] of Object.entries(member.shape)) {
    if (key === 'operation') continue
    if (schema.safeParse(undefined).success) optional.push(key)
    else required.push(key)
  }
  const example = `{"operation":"${operation}"${required.map(key => `,"${key}":${ARGUMENT_EXAMPLES[key] ?? '…'}`).join('')}}`
  return `The valid shape is ${example}${optional.length > 0 ? ` (optional: ${optional.join(', ')})` : ''}.`
}

function invalidArgumentsMessage(operation: string, issues: ZodIssueLike[]): string {
  const problems = issues.map(issue => {
    const key = (issue.path ?? []).join('.')
    if (issue.code === 'invalid_type' && /received undefined/.test(issue.message ?? '')) {
      return `${key} is required (expected ${issue.expected ?? 'a value'})`
    }
    if (issue.code === 'unrecognized_keys') return `unknown keys: ${(issue.keys ?? []).join(', ')}`
    return key ? `${key}: ${issue.message ?? 'invalid'}` : issue.message ?? 'invalid'
  })
  return `Invalid arguments for ${operation || 'the LSP tool'}: ${problems.join('; ')}. ${validShapeOf(operation)} The same arguments will fail the same way; nothing was asked of a language server.`
}


type ServerFailure = { server: string; cause: string }
type Settled = { data: Output; effect: ToolEffect }

function callTargets(input: Input, cwd: string): string[] {
  const targets: string[] = []
  const filePath = 'filePath' in input ? (input as { filePath?: string }).filePath : undefined
  if (filePath) targets.push(expandPath(filePath))
  const paths = 'paths' in input ? (input as { paths?: string[] }).paths : undefined
  for (const raw of paths ?? []) targets.push(resolvePath(cwd, raw))
  return targets
}

function serverFailuresOf(effect: ToolEffect): ServerFailure[] {
  const raw = effect.details?.serverFailures
  return Array.isArray(raw) ? (raw as ServerFailure[]) : []
}

async function runLspToolCall(input: Input, context: ToolUseContext, messageId: UUID | undefined, requestWritePermission?: (path: string) => Promise<boolean>): Promise<Settled> {
  const startedAt = Date.now()
  const operation = input.operation
  const filePath = 'filePath' in input ? (input.filePath ?? '') : ''
  const cwd = getCwd()
  const callKey = lspCallKey(operation, input)
  const fail = (result: string, overrides: Partial<ToolEffect> = {}): Settled => ({
    data: { operation, result, filePath, outcome: 'failed' as const } satisfies Output,
    effect: makeEffect(operation, 'failed', result, startedAt, overrides),
  })

  const refusedCall = lspCallRefusal(callKey)
  if (refusedCall !== undefined) {
    return fail(
      `Not tried: the same ${operation} call has failed ${refusedCall.count} times this session (${refusedCall.summary}); it will not be tried again this session.`,
      { details: { refused: true } },
    )
  }
  if (getInitializationStatus().status === 'pending') {
    await waitForInitialization()
  }
  const manager = getLspServerManager()
  if (manager) {
    for (const target of callTargets(input, cwd)) {
      for (const server of manager.getServersForFile(target)) {
        const latched = lspServerRefusal(server.name)
        if (latched === undefined) continue
        const remedy = remedyForLanguageServer(server, target, latched.cause, cwd)
        return fail(
          `Not tried: ${serverTitle(server, target)} did not start ${latched.count} times this session (${latched.cause}); calls that need it will not be tried again this session.${remedy ? ` What helps: ${remedy}.` : ''}`,
          { details: { refused: true, serverFailures: [{ server: server.name, cause: latched.cause }] } },
        )
      }
    }
  }

  const settled = await runLspOperation(input, context, messageId, requestWritePermission)
  if (context.abortController.signal.aborted) return settled
  if (settled.effect.outcome !== 'failed') {
    clearLspCall(callKey)
    return settled
  }
  const serverFailures = serverFailuresOf(settled.effect)
  const summary = settled.effect.evidence || (settled.data.result.split('\n')[0] ?? '')
  const count = recordLspCallFailure(callKey, summary, serverFailures.map(f => f.server))
  const notes: string[] = []
  if (count >= LSP_TRIES_BEFORE_REFUSAL) notes.push(`This call has failed ${count} times this session; it will not be tried again.`)
  else if (count > 1) notes.push(`This call has failed the same way ${count} times this session.`)
  for (const failure of serverFailures) {
    const serverCount = recordLspServerFailure(failure.server, failure.cause)
    if (serverCount >= LSP_TRIES_BEFORE_REFUSAL) {
      const server = manager ? [...manager.getAllServers().values()].find(s => s.name === failure.server) : undefined
      const title = server ? serverTitle(server, callTargets(input, cwd)[0] ?? '') : `the language server ${failure.server}`
      notes.push(`${title[0]!.toUpperCase()}${title.slice(1)} did not start ${serverCount} times this session; calls that need it will not be tried again.`)
    }
  }
  if (notes.length === 0) return settled
  return {
    data: { ...settled.data, result: `${settled.data.result}\n${notes.join(' ')}` },
    effect: { ...settled.effect, details: { ...(settled.effect.details ?? {}), tries: count } },
  }
}

async function runLspOperation(input: Input, context: ToolUseContext, messageId: UUID | undefined, requestWritePermission?: (path: string) => Promise<boolean>): Promise<Settled> {
  const startedAt = Date.now()
  const operation = input.operation
  const filePath = 'filePath' in input ? (input.filePath ?? '') : ''
  const cwd = getCwd()

  const fail = (result: string, overrides: Partial<ToolEffect> = {}): Settled => ({
    data: { operation, result, filePath, outcome: 'failed' as const } satisfies Output,
    effect: makeEffect(operation, 'failed', result, startedAt, overrides),
  })

  if (getInitializationStatus().status === 'pending') {
    await waitForInitialization()
  }
  const manager = getLspServerManager()
  if (!manager) {
    const message =
      'The language-server manager is not initialised. This may indicate a startup issue; language features are unavailable.'
    logError(new Error('LSPTool invoked with no language-server manager'))
    return fail(message)
  }

  const failureWords = (err: unknown, path: string): { result: string; serverFailures: Array<{ server: string; cause: string }> } => {
    const primary = path ? manager.getServerForFile(expandPath(path)) : undefined
    if (isLspStartFailure(err)) {
      const server = primary && primary.name === err.server ? primary : [...manager.getAllServers().values()].find(s => s.name === err.server)
      const title = server ? serverTitle(server, path) : `the language server ${err.server}`
      const remedy = server ? remedyForLanguageServer(server, path, err.lspCause, cwd) : ''
      return {
        result: `The ${operation} operation was not run: ${title} did not start — ${err.lspCause}.${remedy ? ` What helps: ${remedy}.` : ''}`,
        serverFailures: [{ server: err.server, cause: err.lspCause }],
      }
    }
    return { result: `The ${operation} operation failed: ${err instanceof Error ? err.message : String(err)}`, serverFailures: [] }
  }

  if (MERCURY_BRIDGE_OPERATIONS.has(input.operation)) {
    if (!mercuryLspEnabled()) {
      return fail(
        `The ${operation} operation requires the IDE bridge, which is disabled (MERCURY_LSP is off).`,
      )
    }
    try {
      const op = await runMercuryLspOp({
        input: input as unknown as MercuryLspOpInput,
        absolutePath: filePath ? expandPath(filePath) : cwd,
        cwd,
        manager,
        tool: lspPermissionShim as never,
        context,
        requestWritePermission,
        ...(messageId !== undefined ? { messageId } : {}),
      })
      const data: Output = {
        operation,
        result: op.result,
        filePath,
        resultCount: op.resultCount,
        fileCount: op.fileCount,
        outcome: op.effect.outcome,
        ...(op.applied !== undefined ? { applied: op.applied } : {}),
        ...(op.changeView && op.changeView.files.length > 0
          ? { changeView: op.changeView }
          : {}),
        ...(op.edits !== undefined ? { edits: op.edits } : {}),
        ...(op.omittedEdits !== undefined ? { omittedEdits: op.omittedEdits } : {}),
        ...(op.plan !== undefined ? { plan: op.plan } : {}),
      }
      return {
        data,
        effect: makeEffect(operation, op.effect.outcome, op.result, startedAt, {
          changedPaths: op.effect.changedPaths,
          evidence: op.effect.evidence,
          ...(op.effect.details !== undefined ? { details: op.effect.details } : {}),
        }),
      }
    } catch (err) {
      logError(err)
      const words = failureWords(err, filePath)
      return fail(words.result, words.serverFailures.length > 0 ? { details: { serverFailures: words.serverFailures } } : {})
    }
  }

  if (operation === 'workspaceSymbol') {
    const query = (input as { query: string }).query
    try {
      type WorkspaceSymbolRow = { name: string; kind: number; location?: { uri: string; range: { start: { line: number; character: number } } }; containerName?: string }
      let response: WorkspaceSymbolRow[] | undefined
      if (filePath) {
        response = await manager.sendRequest<WorkspaceSymbolRow[]>(
          expandPath(filePath),
          'workspace/symbol',
          { query },
        )
      } else {
        let sent = false
        for (const server of manager.getAllServers().values()) {
          if (server.state === 'running') {
            response = await server.sendRequest<WorkspaceSymbolRow[]>('workspace/symbol', {
              query,
            })
            sent = true
            break
          }
        }
        if (!sent) {
          const message =
            'No language server is running yet. Servers start on demand — open (Read) a file of the target language to start one, or pass filePath to route the search through a specific server.'
          return {
            data: { operation, result: message, filePath, resultCount: 0, fileCount: 0 } satisfies Output,
            effect: makeEffect(operation, 'failed', message, startedAt),
          }
        }
      }
      if (!Array.isArray(response)) {
        const message = `No symbols found for "${query}" (the server returned no result).`
        return {
          data: { operation, result: message, filePath, resultCount: 0, fileCount: 0 } satisfies Output,
          effect: makeEffect(operation, 'failed', message, startedAt),
        }
      }
      const filtered = await filterLocationsByGitignore(response, symbol => symbol.location?.uri)
      const limit = (input as { limit?: number }).limit ?? WORKSPACE_SYMBOL_DEFAULT_LIMIT
      const bounded = boundWorkspaceSymbols(filtered as never[], limit)
      let result = formatWorkspaceSymbolResult(bounded.shown as never[], cwd)
      if (bounded.truncated) {
        result += `\n\nShowing ${bounded.shown.length} of ${bounded.total} symbols. Raise \`limit\` (maximum ${WORKSPACE_SYMBOL_MAX_LIMIT}) or narrow \`query\` to see the rest.`
      }
      const counts = locationCounts(
        bounded.shown.map(symbol => ({ uri: (symbol as WorkspaceSymbolRow).location?.uri })),
      )
      return {
        data: {
          operation,
          result,
          filePath,
          resultCount: counts.resultCount,
          fileCount: counts.fileCount,
        } satisfies Output,
        effect: makeEffect(operation, 'succeeded', result, startedAt),
      }
    } catch (err) {
      logError(err)
      const message = `The workspaceSymbol search for "${query}" failed: ${err instanceof Error ? err.message : String(err)}`
      return fail(message)
    }
  }

  try {
    const documentPath = expandPath(filePath)

    if (!manager.isFileOpen(documentPath)) {
      const handle = await open(documentPath, 'r')
      try {
        const stats = await handle.stat()
        if (stats.size > MAX_ANALYZABLE_FILE_BYTES) {
          const megabytes = Math.ceil(stats.size / (1024 * 1024))
          const message = `File is too large for language-server analysis (${megabytes} MB; the limit is 10 MB).`
          return fail(message)
        }
        const content = (await handle.readFile({ encoding: 'utf8' })) as string
        await manager.openFile(documentPath, content)
      } finally {
        await handle.close()
      }
    }

    const { method, params } = getMethodAndParams(input, documentPath)
    const response = await manager.sendRequest<unknown>(documentPath, method, params)
    if (response === undefined) {
      const extension = `.${documentPath.split('.').pop() ?? ''}`
      const why = unclaimedCause(extension, cwd)
      const message = `The ${operation} operation was not run: no language server claims '${extension}' files in this session — ${why.cause}.${why.remedy ? ` What helps: ${why.remedy}.` : ''}`
      logError(new Error(`LSP ${operation}: no server response for ${documentPath}`))
      return fail(message)
    }

    if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
      const prepared = response as Array<Record<string, unknown>> | null
      if (!Array.isArray(prepared) || prepared.length === 0) {
        const message = 'No call-hierarchy item found at this position.'
        return {
          data: {
            operation,
            result: message,
            filePath,
            resultCount: 0,
            fileCount: 0,
            outcome: 'no-change',
          } satisfies Output,
          effect: makeEffect(operation, 'no-change', message, startedAt),
        }
      }
      const secondMethod =
        operation === 'incomingCalls' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls'
      const calls = await manager.sendRequest<unknown[]>(documentPath, secondMethod, {
        item: prepared[0],
      })
      if (calls === undefined) {
        logError(new Error(`LSP ${operation}: undefined second response`))
      }
      const callList = (calls ?? []) as Array<{ from?: { uri?: string }; to?: { uri?: string }; fromRanges?: unknown[] }>
      const result =
        operation === 'incomingCalls'
          ? formatIncomingCallsResult(callList as never[], cwd)
          : formatOutgoingCallsResult(callList as never[], cwd)
      const sides = callList
        .map(call => (operation === 'incomingCalls' ? call.from : call.to))
        .filter((item): item is { uri?: string } => item !== undefined && item !== null)
      const uris = new Set<string>()
      for (const side of sides) {
        if (side.uri !== undefined) uris.add(side.uri)
      }
      return {
        data: {
          operation,
          result,
          filePath,
          resultCount: sides.length,
          fileCount: uris.size,
          outcome: 'succeeded',
        } satisfies Output,
        effect: makeEffect(operation, 'succeeded', result, startedAt),
      }
    }

    let finalResponse = response
    if (
      (operation === 'findReferences' ||
        operation === 'goToDefinition' ||
        operation === 'goToImplementation') &&
      Array.isArray(response)
    ) {
      finalResponse = await filterLocationsByGitignore(
        response as Locationish[],
        location =>
          'targetUri' in (location as Record<string, unknown>)
            ? (location as { targetUri?: string }).targetUri
            : (location as { uri?: string }).uri,
      )
    }

    let result: string
    let counts: { resultCount: number; fileCount: number }
    switch (operation) {
      case 'goToDefinition':
      case 'goToImplementation': {
        const list = Array.isArray(finalResponse)
          ? (finalResponse as Locationish[])
          : finalResponse
            ? [finalResponse as Locationish]
            : []
        result = formatGoToDefinitionResult(list, cwd)
        counts = locationCounts(
          list.map(location => ({
            uri:
              'targetUri' in (location as Record<string, unknown>)
                ? (location as { targetUri?: string }).targetUri
                : (location as { uri?: string }).uri,
          })),
        )
        break
      }
      case 'findReferences': {
        const list = Array.isArray(finalResponse) ? (finalResponse as Array<{ uri?: string }>) : []
        result = formatFindReferencesResult(list as never[], cwd)
        counts = locationCounts(list)
        break
      }
      case 'hover': {
        result = formatHoverResult(finalResponse as never, cwd)
        const has = finalResponse !== null && finalResponse !== undefined
        counts = { resultCount: has ? 1 : 0, fileCount: has ? 1 : 0 }
        break
      }
      case 'documentSymbol': {
        const list = Array.isArray(finalResponse) ? (finalResponse as unknown[]) : []
        result = formatDocumentSymbolResult(list as never[], cwd)
        counts = documentSymbolCounts(list)
        break
      }
      case 'prepareCallHierarchy': {
        const list = Array.isArray(finalResponse) ? (finalResponse as Array<{ uri?: string }>) : []
        result = formatPrepareCallHierarchyResult(list as never[], cwd)
        const uris = new Set<string>()
        for (const item of list) if (item.uri !== undefined) uris.add(item.uri)
        counts = { resultCount: list.length, fileCount: uris.size }
        break
      }
      default:
        throw new Error(`Unhandled base LSP operation: ${operation}`)
    }
    return {
      data: {
        operation,
        result,
        filePath,
        resultCount: counts.resultCount,
        fileCount: counts.fileCount,
        outcome: 'succeeded',
      } satisfies Output,
      effect: makeEffect(operation, 'succeeded', result, startedAt),
    }
  } catch (err) {
    logError(err)
    const words = failureWords(err, filePath)
    return fail(words.result, words.serverFailures.length > 0 ? { details: { serverFailures: words.serverFailures } } : {})
  }
}

export const LSPTool = buildTool({
  name: LSP_TOOL_NAME,
  isLsp: true,
  shouldDefer: true,
  loadInFullOnCloud: true,
  straightQuoteInputs: ['filePath', 'query', 'newName', 'newPath', 'targetPath', 'paths'],
  maxResultSizeChars: 100_000,
  get inputSchema() {
    return flatSchema() as z.ZodType
  },
  get outputSchema() {
    return outputSchema() as z.ZodType
  },
  get searchHint(): string {
    return mercuryLspEnabled()
      ? 'code intelligence: definitions references hover symbols diagnostics rename move symbol refactor code actions formatting'
      : 'code intelligence: definitions references hover symbols call hierarchy'
  },
  isEnabled(): boolean {
    return isLspToolMounted()
  },
  isReadOnly(input: Input): boolean {
    return !isMercuryApplyOp(input)
  },
  isConcurrencySafe(input: Input): boolean {
    return !isMercuryApplyOp(input)
  },
  userFacingName,
  getToolUseSummary(input?: LooseInput): string | null {
    return input?.operation ?? null
  },
  getActivityDescription(input?: LooseInput): string {
    return input?.operation ? `Running ${input.operation}` : 'Running a language-server operation'
  },
  toAutoClassifierInput(input: LooseInput): string {
    return input.filePath ? `${input.operation ?? ''} ${input.filePath}` : (input.operation ?? '')
  },
  getPath(input?: LooseInput): string {
    return input?.filePath || getCwd()
  },
  async description(): Promise<string> {
    return getLspToolDescription(mercuryLspEnabled())
  },
  async prompt(): Promise<string> {
    return getLspToolDescription(mercuryLspEnabled())
  },
  async checkPermissions(input: LooseInput, context: ToolUseContext) {
    const permissionContext = context.getAppState().toolPermissionContext
    if (isMercuryApplyOp(input)) {
      if (!mercuryLspWriteOpsEnabled()) {
        return {
          behavior: 'deny' as const,
          message:
            'LSP apply operations are disabled (the MERCURY_LSP write sub-capability is off). Re-run without apply, or enable write operations.',
          decisionReason: {
            type: 'other' as const,
            reason: 'LSP write operations disabled by configuration',
          },
        }
      }
      return checkWritePermissionForTool(lspPermissionShim, input, permissionContext)
    }
    return checkReadPermissionForTool(lspPermissionShim, input, permissionContext)
  },
  async validateInput(input: LooseInput) {
    const operation = input.operation ?? ''
    const key = lspCallKey(operation, input)
    const refused = lspCallRefusal(key)
    if (refused !== undefined) {
      return {
        result: false as const,
        message: `Not tried: the same ${operation} call has failed ${refused.count} times this session (${refused.summary}); it will not be tried again this session.`,
        errorCode: 3,
      }
    }
    const refuse = (message: string, errorCode: number) => {
      const count = recordLspCallFailure(key, message.split('. ')[0] ?? message)
      const note =
        count >= LSP_TRIES_BEFORE_REFUSAL
          ? ` This call has failed ${count} times this session; it will not be tried again.`
          : count > 1
            ? ` This call has failed the same way ${count} times this session.`
            : ''
      return { result: false as const, message: `${message}${note}`, errorCode }
    }
    const parsed = lspToolInputSchema().safeParse(input)
    if (!parsed.success) {
      return refuse(invalidArgumentsMessage(operation, parsed.error.issues as ZodIssueLike[]), 3)
    }
    const filePath = (parsed.data as { filePath?: string }).filePath
    if (filePath === undefined) {
      return { result: true as const }
    }
    if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
      return { result: true as const }
    }
    const expanded = expandPath(filePath)
    let stats
    try {
      stats = await stat(expanded)
    } catch (err) {
      if (isENOENT(err)) {
        return refuse(`File does not exist: ${filePath}. The same arguments will fail the same way; nothing was asked of a language server.`, 1)
      }
      logError(err)
      return refuse(`Cannot access ${filePath}: ${err instanceof Error ? err.message : String(err)}`, 4)
    }
    if (!stats.isFile()) {
      return refuse(`Path is not a file: ${filePath}. The same arguments will fail the same way; nothing was asked of a language server.`, 2)
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, canUseTool, parentMessage) {
    const messageId = parentMessage?.uuid as UUID | undefined
    const own = lspToolInputSchema().safeParse(input)
    const scoped = (own.success ? own.data : input) as Input
    const requestWritePermission = typeof canUseTool === 'function' && parentMessage
      ? async (path: string): Promise<boolean> => {
          const requested = { ...scoped, filePath: path }
          const decision = await canUseTool(LSPTool, requested, context, parentMessage, context.toolUseId ?? 'lsp-write')
          return decision.behavior === 'allow' && isDeepStrictEqual(decision.updatedInput ?? requested, requested)
        }
      : undefined
    return runWithLspAbortSignal(context.abortController.signal, () => runLspToolCall(scoped, context, messageId, requestWritePermission))
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: data.result }
  },
  extractSearchText(data: Output): string {
    if (data.changeView) {
      return `${data.result}\n${changeViewSearchText(data.changeView)}`
    }
    return data.result
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})

export { DESCRIPTION }
