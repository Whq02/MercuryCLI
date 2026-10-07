import type { UUID } from 'node:crypto'
import { stat, open, readFile } from 'node:fs/promises'
import { resolve as resolvePath, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod/v4'
import { buildTool, type Tool, type ToolEffect, type ToolUseContext } from '../../Tool.js'
import { getInitializationStatus, getLspServerManager, isLspToolMounted, waitForInitialization } from '../../services/lsp/manager.js'
import { clearLspCall, LSP_TRIES_BEFORE_REFUSAL, lspCallKey, lspCallRefusal, lspCallSituation, lspLedgerNow, lspRefusalWindowMs, recordLspServerFault } from '../../services/lsp/failureLedger.js'
import { lspStartFailureWords, remedyForLanguageServer, retryTimeWords, serverTitle, unclaimedCause } from '../../services/lsp/failureWords.js'
import { isLspStartFailure } from '../../services/lsp/LSPServerInstance.js'
import { mercuryLspEnabled, mercuryLspWriteOpsEnabled } from '../../services/lsp/mercuryLsp.js'
import { runWithLspAbortSignal, lspRequestFaultCount } from '../../services/lsp/lspAbort.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool, checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import { changeViewSearchText } from '../StructureTool/StructureTool.js'
import { runMercuryLspOp, type MercuryLspOpInput, type MercuryLspOpOutput } from './mercuryOps.js'
import { boundWorkspaceSymbols, formatDocumentSymbolResult, formatFindReferencesResult, formatGoToDefinitionResult, formatHoverResult, formatIncomingCallsResult, formatOutgoingCallsResult, formatWorkspaceSymbolResult, uriToPath, type Locationish } from './formatters.js'
import { LSP_DESCRIPTIONS, LSP_SEARCH_HINTS, type LspToolName } from './prompt.js'
import { LSP_INPUT_JSON_SCHEMAS, lspInputSchema, readArguments, readArgumentError, type LspInput } from './schemas.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage } from './UI.js'

const MAX_ANALYZABLE_FILE_BYTES = 10_000_000
const WORKSPACE_SYMBOL_DEFAULT_LIMIT = 50
const WORKSPACE_SYMBOL_MAX_LIMIT = 200
const EVIDENCE_MAX_CHARS = 160
const CHECK_IGNORE_BATCH = 50
const CHECK_IGNORE_TIMEOUT_MS = 5_000
const MERCURY_BRIDGE_OPERATIONS = new Set(['diagnostics', 'rename', 'codeActions', 'typeDefinition', 'serverStatus', 'workspaceDiagnostics', 'pathRename', 'formatDocument', 'formatRange', 'organizeImports', 'rawRequest', 'moveSymbol'])

type Input = LspInput & { operation: string }
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

type Settled = { data: Output; effect: ToolEffect }
const outputSchema = z.object({
  operation: z.string(), result: z.string(), filePath: z.string(),
  resultCount: z.number().optional(), fileCount: z.number().optional(), applied: z.boolean().optional(),
  outcome: z.enum(['succeeded', 'failed', 'no-change', 'indeterminate']).optional(),
  changeView: z.object({
    state: z.enum(['proposed', 'applied']), action: z.string(),
    files: z.array(z.object({ file: z.string(), hunks: z.array(z.object({ oldStart: z.number(), oldLines: z.number(), newStart: z.number(), newLines: z.number(), lines: z.array(z.string()) })), omittedHunks: z.number().optional(), changedLines: z.number() })), refs: z.array(z.string()),
  }).optional(),
  edits: z.array(z.object({ file: z.string(), range: z.object({ start: z.object({ line: z.number(), character: z.number() }), end: z.object({ line: z.number(), character: z.number() }) }), before: z.string(), after: z.string() })).optional(),
  omittedEdits: z.number().optional(), plan: z.string().optional(),
})

function makeEffect(operation: string, outcome: ToolEffect['outcome'], result: string, startedAt: number, overrides: Partial<ToolEffect> = {}): ToolEffect {
  return { outcome, operation: `lsp.${operation}`, changedPaths: [], evidence: (result.split('\n')[0] ?? '').slice(0, EVIDENCE_MAX_CHARS), startedAt, completedAt: Date.now(), ...overrides }
}

function getMethodAndParams(input: Input, documentPath: string): { method: string; params: unknown } {
  const uri = pathToFileURL(documentPath).toString()
  const position = input.line !== undefined && input.character !== undefined ? { line: input.line - 1, character: input.character - 1 } : undefined
  const textDocument = { uri }
  switch (input.operation) {
    case 'goToDefinition': return { method: 'textDocument/definition', params: { textDocument, ...(position ? { position } : {}) } }
    case 'findReferences': return { method: 'textDocument/references', params: { textDocument, ...(position ? { position } : {}), context: { includeDeclaration: true } } }
    case 'hover': return { method: 'textDocument/hover', params: { textDocument, ...(position ? { position } : {}) } }
    case 'documentSymbol': return { method: 'textDocument/documentSymbol', params: { textDocument } }
    case 'goToImplementation': return { method: 'textDocument/implementation', params: { textDocument, ...(position ? { position } : {}) } }
    case 'incomingCalls':
    case 'outgoingCalls': return { method: 'textDocument/prepareCallHierarchy', params: { textDocument, ...(position ? { position } : {}) } }
    default: throw new Error(`No base LSP method mapping for operation: ${input.operation}`)
  }
}

async function gitIgnoredPaths(paths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  for (let start = 0; start < paths.length; start += CHECK_IGNORE_BATCH) {
    const batch = paths.slice(start, start + CHECK_IGNORE_BATCH)
    try {
      const result = await execFileNoThrow('git', ['check-ignore', ...batch], { timeout: CHECK_IGNORE_TIMEOUT_MS })
      if (result.code === 0 && result.stdout.length > 0) {
        for (const line of result.stdout.split('\n')) if (line.trim() !== '') ignored.add(line.trim())
      }
    } catch {}
  }
  return ignored
}

async function filterLocationsByGitignore<T>(entries: T[], uriOf: (entry: T) => string | undefined): Promise<T[]> {
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
    return uri === undefined || !ignored.has(uriToPath(uri))
  })
}

function locationCounts(entries: Array<{ uri?: string }>): { resultCount: number; fileCount: number } {
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
  if (first?.location !== undefined) return { resultCount: result.length, fileCount: result.length > 0 ? 1 : 0 }
  const countTree = (nodes: Array<{ children?: unknown[] }>): number => nodes.reduce((total, node) => total + 1 + (node.children ? countTree(node.children as Array<{ children?: unknown[] }>) : 0), 0)
  return { resultCount: countTree(result as Array<{ children?: unknown[] }>), fileCount: result.length > 0 ? 1 : 0 }
}

function callTargets(input: LspInput): string[] {
  return [...new Set([input.filePath, ...(input.paths ?? []), input.targetPath, input.newPath].filter((path): path is string => !!path).map(path => expandPath(path)))]
}

function refusalSubject(input: LspInput): string {
  const paths = callTargets(input).map(path => relative(getCwd(), path) || path)
  if (!paths.length) return 'a language server restarts'
  return `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''} changes or a language server restarts`
}

function refusalWords(name: LspToolName, input: LspInput, refused: { count: number; summary: string; retryAt: number }): string {
  const what = name === 'LspRead' ? input.operation : name
  const meanwhile = name === 'LspRead' ? 'answer it with Read or Grep, or fix the cause above.' : 'make the change with Edit, or fix the cause above.'
  return `Not tried: this ${what} call failed ${refused.count} times in a row with nothing it depends on changed (last: ${refused.summary}). It will be sent again once ${refusalSubject(input)}, or after ${retryTimeWords(refused.retryAt)}. Until then, ${meanwhile}`
}

function engineOperation(name: LspToolName, input: LspInput): string {
  switch (name) {
    case 'LspRead': return input.operation === 'diagnostics' && input.paths?.length ? 'workspaceDiagnostics' : input.operation ?? ''
    case 'LspRename': return 'rename'
    case 'LspMoveSymbol': return 'moveSymbol'
    case 'LspMoveFile': return 'pathRename'
    case 'LspCodeAction': return 'codeActions'
    case 'LspFormat': return input.organizeImports === true ? 'organizeImports' : input.line !== undefined ? 'formatRange' : 'formatDocument'
    case 'LspRequest': return 'rawRequest'
  }
}

async function runLspToolCall(name: LspToolName, input: LspInput, tool: Tool, context: ToolUseContext, messageId: UUID | undefined, requestWritePermission?: (path: string) => Promise<boolean>): Promise<Settled> {
  if (getInitializationStatus().status === 'pending') await waitForInitialization()
  const situation = await lspCallSituation(callTargets(input), getLspServerManager())
  const key = lspCallKey(name === 'LspRead' ? input.operation ?? '' : name, input)
  const refused = lspCallRefusal(key, situation)
  const operation = engineOperation(name, input)
  if (refused) {
    const result = refusalWords(name, input, refused)
    return { data: { operation: name === 'LspRead' ? input.operation! : operation, result, filePath: input.filePath ?? '', outcome: 'failed' }, effect: makeEffect(operation, 'failed', result, Date.now(), { details: { refused: true } }) }
  }
  const engineInput: Input = { ...input, operation }
  if (name === 'LspFormat' && operation === 'formatRange') {
    const text = await readFile(expandPath(input.filePath!), 'utf8')
    engineInput.character = 1
    engineInput.endCharacter = (text.split(/\r?\n/)[input.endLine! - 1]?.length ?? 0) + 1
  }
  const settled = await runLspOperation(engineInput, tool, context, messageId, requestWritePermission)
  if (name === 'LspRead') settled.data.operation = input.operation!
  if (context.abortController.signal.aborted) return settled
  if (settled.effect.outcome !== 'failed') {
    clearLspCall(key)
    return settled
  }
  if (!lspRequestFaultCount() || settled.effect.details?.applyRefusal) return settled
  const summary = settled.effect.evidence || (settled.data.result.split('\n')[0] ?? '')
  const count = recordLspServerFault(key, summary, situation)
  const note = count >= LSP_TRIES_BEFORE_REFUSAL
    ? ` This call has now failed ${count} times in a row with nothing it depends on changed; it will not be sent again until ${refusalSubject(input)}, or before ${retryTimeWords(lspLedgerNow() + lspRefusalWindowMs(count))}.`
    : count > 1 ? ' This call has now failed the same way 2 times in a row with nothing it depends on changed.' : ''
  return { data: { ...settled.data, result: settled.data.result + note }, effect: { ...settled.effect, details: { ...settled.effect.details, tries: count } } }
}

async function runLspOperation(input: Input, tool: Tool, context: ToolUseContext, messageId: UUID | undefined, requestWritePermission?: (path: string) => Promise<boolean>): Promise<Settled> {
  const startedAt = Date.now()
  const operation = input.operation
  const filePath = input.filePath ?? ''
  const cwd = getCwd()
  const fail = (result: string, overrides: Partial<ToolEffect> = {}): Settled => ({ data: { operation, result, filePath, outcome: 'failed' }, effect: makeEffect(operation, 'failed', result, startedAt, overrides) })
  const manager = getLspServerManager()
  if (!manager) return fail('The language-server manager is not initialised. This may indicate a startup issue; language features are unavailable.')
  const failureWords = (err: unknown, path: string): string => {
    if (isLspStartFailure(err)) {
      const server = [...manager.getAllServers().values()].find(s => s.name === err.server)
      const title = server ? serverTitle(server, path) : `the language server ${err.server}`
      const remedy = server ? remedyForLanguageServer(server, path, err.lspCause, cwd) : ''
      return lspStartFailureWords(err, title, remedy, `The ${operation} operation was not run: ${title} did not start — ${err.lspCause}.${remedy ? ` What helps: ${remedy}.` : ''}`)
    }
    return `The ${operation} operation failed: ${err instanceof Error ? err.message : String(err)}`
  }
  if (MERCURY_BRIDGE_OPERATIONS.has(operation)) {
    if (!mercuryLspEnabled()) return fail(`The ${tool.name} operation requires the IDE bridge, which is disabled (MERCURY_LSP is off).`)
    try {
      const op = await runMercuryLspOp({ input: input as MercuryLspOpInput, absolutePath: filePath ? expandPath(filePath) : cwd, cwd, manager, tool, context, requestWritePermission, ...(messageId !== undefined ? { messageId } : {}) })
      const data: Output = {
        operation, result: op.result, filePath, resultCount: op.resultCount, fileCount: op.fileCount, outcome: op.effect.outcome,
        ...(op.applied !== undefined ? { applied: op.applied } : {}),
        ...(op.changeView && op.changeView.files.length > 0 ? { changeView: op.changeView } : {}),
        ...(op.edits !== undefined ? { edits: op.edits } : {}),
        ...(op.omittedEdits !== undefined ? { omittedEdits: op.omittedEdits } : {}),
        ...(op.plan !== undefined ? { plan: op.plan } : {}),
      }
      return { data, effect: makeEffect(operation, op.effect.outcome, op.result, startedAt, { changedPaths: op.effect.changedPaths, evidence: op.effect.evidence, ...(op.effect.details !== undefined ? { details: op.effect.details } : {}) }) }
    } catch (err) {
      logError(err)
      return fail(failureWords(err, filePath))
    }
  }
  if (operation === 'workspaceSymbol') {
    const query = input.query!
    try {
      type WorkspaceSymbolRow = { name: string; kind: number; location?: { uri: string; range: { start: { line: number; character: number } } }; containerName?: string }
      let response: WorkspaceSymbolRow[] | undefined
      if (filePath) {
        response = await manager.sendRequest<WorkspaceSymbolRow[]>(expandPath(filePath), 'workspace/symbol', { query })
      } else {
        let sent = false
        for (const server of manager.getAllServers().values()) {
          if (server.state === 'running') {
            response = await server.sendRequest<WorkspaceSymbolRow[]>('workspace/symbol', { query })
            sent = true
            break
          }
        }
        if (!sent) return fail('No language server is running yet. Servers start on demand — open (Read) a file of the target language to start one, or pass filePath to route the search through a specific server.')
      }
      if (!Array.isArray(response)) {
        const result = `No symbols found for "${query}" (the server returned no result).`
        return { data: { operation, result, filePath, resultCount: 0, fileCount: 0, outcome: 'no-change' }, effect: makeEffect(operation, 'no-change', result, startedAt) }
      }
      const filtered = await filterLocationsByGitignore(response, symbol => symbol.location?.uri)
      const bounded = boundWorkspaceSymbols(filtered as never[], input.limit ?? WORKSPACE_SYMBOL_DEFAULT_LIMIT)
      let result = formatWorkspaceSymbolResult(bounded.shown as never[], cwd)
      if (bounded.truncated) result += `\n\nShowing ${bounded.shown.length} of ${bounded.total} symbols. Raise \`limit\` (maximum ${WORKSPACE_SYMBOL_MAX_LIMIT}) or narrow \`query\` to see the rest.`
      const counts = locationCounts(bounded.shown.map(symbol => ({ uri: (symbol as WorkspaceSymbolRow).location?.uri })))
      return { data: { operation, result, filePath, ...counts }, effect: makeEffect(operation, 'succeeded', result, startedAt) }
    } catch (err) {
      logError(err)
      return fail(`The workspaceSymbol search for "${query}" failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    const documentPath = expandPath(filePath)
    if (!manager.isFileOpen(documentPath)) {
      const handle = await open(documentPath, 'r')
      try {
        const stats = await handle.stat()
        if (stats.size > MAX_ANALYZABLE_FILE_BYTES) return fail(`File is too large for language-server analysis (${Math.ceil(stats.size / (1024 * 1024))} MB; the limit is 10 MB).`)
        await manager.openFile(documentPath, await handle.readFile({ encoding: 'utf8' }))
      } finally { await handle.close() }
    }
    const { method, params } = getMethodAndParams(input, documentPath)
    const response = await manager.sendRequest<unknown>(documentPath, method, params)
    if (response === undefined) {
      const extension = `.${documentPath.split('.').pop() ?? ''}`
      const why = unclaimedCause(extension, cwd)
      return fail(`The ${operation} operation was not run: no language server claims '${extension}' files in this session — ${why.cause}.${why.remedy ? ` What helps: ${why.remedy}.` : ''}`)
    }
    if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
      const prepared = response as Array<Record<string, unknown>> | null
      if (!Array.isArray(prepared) || prepared.length === 0) {
        const result = 'No call-hierarchy item found at this position.'
        return { data: { operation, result, filePath, resultCount: 0, fileCount: 0, outcome: 'no-change' }, effect: makeEffect(operation, 'no-change', result, startedAt) }
      }
      const secondMethod = operation === 'incomingCalls' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls'
      const calls = await manager.sendRequest<unknown[]>(documentPath, secondMethod, { item: prepared[0] })
      if (calls === undefined) logError(new Error(`LSP ${operation}: undefined second response`))
      const callList = (calls ?? []) as Array<{ from?: { uri?: string }; to?: { uri?: string }; fromRanges?: unknown[] }>
      const result = operation === 'incomingCalls' ? formatIncomingCallsResult(callList as never[], cwd) : formatOutgoingCallsResult(callList as never[], cwd)
      const sides = callList.map(call => operation === 'incomingCalls' ? call.from : call.to).filter((item): item is { uri?: string } => item !== undefined && item !== null)
      const uris = new Set(sides.flatMap(side => side.uri === undefined ? [] : [side.uri]))
      return { data: { operation, result, filePath, resultCount: sides.length, fileCount: uris.size, outcome: 'succeeded' }, effect: makeEffect(operation, 'succeeded', result, startedAt) }
    }
    let finalResponse = response
    if (['findReferences', 'goToDefinition', 'goToImplementation'].includes(operation) && Array.isArray(response)) {
      finalResponse = await filterLocationsByGitignore(response as Locationish[], location => 'targetUri' in (location as Record<string, unknown>) ? (location as { targetUri?: string }).targetUri : (location as { uri?: string }).uri)
    }
    let result: string
    let counts: { resultCount: number; fileCount: number }
    switch (operation) {
      case 'goToDefinition':
      case 'goToImplementation': {
        const list = Array.isArray(finalResponse) ? finalResponse as Locationish[] : finalResponse ? [finalResponse as Locationish] : []
        result = formatGoToDefinitionResult(list, cwd)
        counts = locationCounts(list.map(location => ({ uri: 'targetUri' in (location as Record<string, unknown>) ? (location as { targetUri?: string }).targetUri : (location as { uri?: string }).uri })))
        break
      }
      case 'findReferences': {
        const list = Array.isArray(finalResponse) ? finalResponse as Array<{ uri?: string }> : []
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
        const list = Array.isArray(finalResponse) ? finalResponse as unknown[] : []
        result = formatDocumentSymbolResult(list as never[], cwd)
        counts = documentSymbolCounts(list)
        break
      }
      default: throw new Error(`Unhandled base LSP operation: ${operation}`)
    }
    return { data: { operation, result, filePath, ...counts, outcome: 'succeeded' }, effect: makeEffect(operation, 'succeeded', result, startedAt) }
  } catch (err) {
    logError(err)
    return fail(failureWords(err, filePath))
  }
}

async function validateInput(name: LspToolName, input: LspInput) {
  const refuse = (message: string, errorCode = 3) => ({ result: false as const, message, errorCode })
  if (name === 'LspRead') {
    const error = readArgumentError(input)
    if (error) return refuse(error)
  }
  if (name === 'LspFormat') {
    if ((input.line === undefined) !== (input.endLine === undefined)) return refuse('LspFormat formats lines line through endLine: give both, or neither to format the whole file. Nothing was sent to a language server.')
    if (input.line !== undefined && input.endLine! < input.line) return refuse(`endLine (${input.endLine}) comes before line (${input.line}); the range is line through endLine. Nothing was sent to a language server.`)
    if (input.organizeImports === true && input.line !== undefined) return refuse('organizeImports works on the whole file; drop line and endLine. Nothing was sent to a language server.')
  }
  const filePath = input.filePath
  if (filePath) {
    if (name === 'LspMoveFile' && resolvePath(expandPath(filePath)) === resolvePath(expandPath(input.newPath ?? ''))) return refuse('newPath is the same path as filePath; give the new location. Nothing was moved.')
    if (!filePath.startsWith('\\\\') && !filePath.startsWith('//')) {
      try {
        const stats = await stat(expandPath(filePath))
        const directoryAllowed = name === 'LspMoveFile' || (name === 'LspRead' && input.operation === 'diagnostics')
        if (stats.isDirectory() && !directoryAllowed) return refuse(`${filePath} is a directory; ${name === 'LspRead' ? input.operation : name} reads one file. Nothing was sent to a language server.`, 2)
        if (!stats.isFile() && !stats.isDirectory()) return refuse(`${filePath} is not a regular file. Nothing was sent to a language server.`, 2)
      } catch (err) {
        if (isENOENT(err)) {
          if (name === 'LspMoveFile') return refuse(`${filePath} does not exist; LspMoveFile moves an existing file or directory. Nothing was moved.`, 1)
          return refuse(name === 'LspRead' ? `${filePath} does not exist. ${input.operation} needs an existing file; Glob finds a file by name. Nothing was sent to a language server.` : `${filePath} does not exist. ${name} needs the file it works on; Glob finds a file by name. Nothing was sent to a language server.`, 1)
        }
        return refuse(`Cannot access ${filePath}: ${err instanceof Error ? err.message : String(err)}. Nothing was sent to a language server.`, 4)
      }
    }
  }
  const key = lspCallKey(name === 'LspRead' ? input.operation ?? '' : name, input)
  const situation = await lspCallSituation(callTargets(input), getLspServerManager())
  const refused = lspCallRefusal(key, situation)
  return refused ? refuse(refusalWords(name, input, refused)) : { result: true as const }
}

const STRAIGHT_QUOTES: Record<LspToolName, string[]> = { LspRead: ['filePath', 'query', 'paths'], LspRename: ['filePath', 'newName'], LspMoveSymbol: ['filePath', 'targetPath'], LspMoveFile: ['filePath', 'newPath'], LspCodeAction: ['filePath'], LspFormat: ['filePath'], LspRequest: ['filePath'] }

function makeLspTool(name: LspToolName): Tool {
  const scoped = (input: LspInput): LspInput => name === 'LspRead' ? readArguments(input) : input
  const writes = (input?: LspInput): boolean => name === 'LspRequest' || (name !== 'LspRead' && input?.apply === true)
  const tool: Tool = buildTool({
    name, isLsp: true, shouldDefer: true, ...(name === 'LspRead' ? { loadInFullOnCloud: true } : {}),
    straightQuoteInputs: STRAIGHT_QUOTES[name], maxResultSizeChars: 100_000,
    inputSchema: lspInputSchema(name), inputJSONSchema: LSP_INPUT_JSON_SCHEMAS[name] as unknown as NonNullable<Tool['inputJSONSchema']>, outputSchema,
    searchHint: LSP_SEARCH_HINTS[name],
    isEnabled: isLspToolMounted,
    isReadOnly: (input: LspInput) => !writes(input),
    isConcurrencySafe: (input: LspInput) => !writes(input),
    userFacingName: () => name,
    getToolUseSummary: (input?: LspInput) => name === 'LspRead' ? input?.operation ?? null : engineOperation(name, input ?? {}),
    getActivityDescription: (input?: LspInput) => `Running ${name === 'LspRead' ? input?.operation ?? 'a language-server question' : name}`,
    getPath: (input?: LspInput) => input?.filePath || getCwd(),
    description: async () => LSP_DESCRIPTIONS[name],
    prompt: async () => LSP_DESCRIPTIONS[name],
    async checkPermissions(input: LspInput, context: ToolUseContext) {
      const permissionContext = context.getAppState().toolPermissionContext
      if (writes(input) && !mercuryLspWriteOpsEnabled()) return {
        behavior: 'deny' as const,
        message: `${name} writes are disabled (MERCURY_LSP is off).`,
        decisionReason: { type: 'other' as const, reason: 'Language-service writes disabled by configuration' },
      }
      if (writes(input)) return checkWritePermissionForTool(tool, input, permissionContext)
      const own = scoped(input)
      const paths = name === 'LspRead' ? [own.filePath, ...(own.paths ?? [])].filter((path): path is string => !!path) : [own.filePath || getCwd()]
      const checks = await Promise.all((paths.length ? [...new Set(paths)] : [getCwd()]).map(filePath => checkReadPermissionForTool(tool, { filePath }, permissionContext)))
      const denied = checks.find(check => check.behavior === 'deny')
      if (denied) return denied
      const asks = checks.filter(check => check.behavior === 'ask')
      if (asks.length) return { ...asks[0]!, message: asks.map(check => check.message).join('\n') }
      return { behavior: 'allow' as const, updatedInput: input }
    },
    validateInput: async (input: LspInput) => validateInput(name, scoped(input)),
    async call(input: LspInput, context: ToolUseContext, canUseTool, parentMessage) {
      const own = scoped(input)
      const messageId = parentMessage?.uuid as UUID | undefined
      const requestWritePermission = typeof canUseTool === 'function' && parentMessage
        ? async (path: string): Promise<boolean> => {
            const requested = { ...own, filePath: path }
            const decision = await canUseTool(tool, requested, context, parentMessage, context.toolUseId ?? 'lsp-write')
            return decision.behavior === 'allow' && isDeepStrictEqual(decision.updatedInput ?? requested, requested)
          }
        : undefined
      return runWithLspAbortSignal(context.abortController.signal, () => runLspToolCall(name, own, tool, context, messageId, requestWritePermission))
    },
    mapToolResultToToolResultBlockParam: (data: Output, toolUseID: string) => ({ tool_use_id: toolUseID, type: 'tool_result' as const, content: data.result }),
    extractSearchText: (data: Output) => data.changeView ? `${data.result}\n${changeViewSearchText(data.changeView)}` : data.result,
    renderToolUseMessage: (input: LspInput, options) => renderToolUseMessage({ ...input, operation: engineOperation(name, input) }, options),
    renderToolResultMessage,
    renderToolUseRejectedMessage: () => null,
    renderToolUseErrorMessage: (result, options) => renderToolUseErrorMessage(result, options, name),
  })
  return tool
}

export const LspReadTool = makeLspTool('LspRead')
export const LspRenameTool = makeLspTool('LspRename')
export const LspMoveSymbolTool = makeLspTool('LspMoveSymbol')
export const LspMoveFileTool = makeLspTool('LspMoveFile')
export const LspCodeActionTool = makeLspTool('LspCodeAction')
export const LspFormatTool = makeLspTool('LspFormat')
export const LspRequestTool = makeLspTool('LspRequest')
export const LSP_TOOLS = [LspReadTool, LspRenameTool, LspMoveSymbolTool, LspMoveFileTool, LspCodeActionTool, LspFormatTool, LspRequestTool]
