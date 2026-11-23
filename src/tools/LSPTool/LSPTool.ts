import type { UUID } from 'node:crypto'
import { stat, open, readFile } from 'node:fs/promises'
import { basename, extname, resolve as resolvePath, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod/v4'
import { buildTool, type Tool, type ToolEffect, type ToolUseContext } from '../../Tool.js'
import { getInitializationStatus, getLspServerManager, isLspToolMounted, waitForInitialization } from '../../services/lsp/manager.js'
import { clearLspCall, LSP_TRIES_BEFORE_REFUSAL, lspCallKey, lspCallRefusal, lspCallSituation, lspLedgerNow, lspRefusalWindowMs, recordLspServerFault } from '../../services/lsp/failureLedger.js'
import { lspStartFailureWords, remedyForLanguageServer, retryTimeWords, serverTitle, unclaimedCause } from '../../services/lsp/failureWords.js'
import { LSP_FIRST_CALL_START_WAIT_MS, startedWithin, workspaceSymbolServer } from '../../services/lsp/firstCallServer.js'
import { isLspStartFailure, type LSPServerInstance } from '../../services/lsp/LSPServerInstance.js'
import { mercuryLspEnabled, mercuryLspWriteOpsEnabled } from '../../services/lsp/mercuryLsp.js'
import { mercuryLspServersInvalidNote } from '../../services/lsp/builtinServers.js'
import { runWithLspAbortSignal, lspRequestFaultCount } from '../../services/lsp/lspAbort.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'
import { controlCharacterPathRefusal, expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool, checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import { changeViewSearchText } from '../StructureTool/StructureTool.js'
import { runMercuryLspOp, type MercuryLspOpInput, type MercuryLspOpOutput } from './mercuryOps.js'
import { readLocationSourceLines, boundWorkspaceSymbols, formatDocumentSymbolResult, formatFindReferencesResult, formatGoToDefinitionResult, formatHoverResult, formatIncomingCallsResult, formatOutgoingCallsResult, formatWorkspaceSymbolResult, uriToPath, type DocumentSymbol, type HoverResult, type IncomingCall, type Location, type Locationish, type OutgoingCall, type SymbolInformation } from './formatters.js'
import { LSP_DESCRIPTIONS, LSP_SEARCH_HINTS, type LspToolName } from '../../constants/tools/lsp.js'
import { LSP_INPUT_JSON_SCHEMAS, lspInputSchema, readArguments, readArgumentError, type LspInput } from './schemas.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage } from './UI.js'
import { passedOver } from '../../utils/passedOver.js'

const MAX_ANALYZABLE_FILE_BYTES = 10_000_000
const WORKSPACE_SYMBOL_DEFAULT_LIMIT = 50
const WORKSPACE_SYMBOL_MAX_LIMIT = 200
const EVIDENCE_MAX_CHARS = 160
const CHECK_IGNORE_BATCH = 50
const CHECK_IGNORE_TIMEOUT_MS = 5_000
const MERCURY_BRIDGE_OPERATIONS = new Set(['diagnostics', 'rename', 'codeActions', 'typeDefinition', 'serverStatus', 'workspaceDiagnostics', 'pathRename', 'formatDocument', 'formatRange', 'organizeImports', 'rawRequest', 'moveSymbol'])
let lastNotedInvalidLspServers: string | null = null
function consumeInvalidLspServersNote(): string {
  const note = mercuryLspServersInvalidNote()
  if (note === null) {
    lastNotedInvalidLspServers = null
    return ''
  }
  if (lastNotedInvalidLspServers === note) return ''
  lastNotedInvalidLspServers = note
  return ` ${note}`
}

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

type WorkspaceSymbolResponse =
  | SymbolInformation[]
  | { symbols: SymbolInformation[]; incompleteError?: string }
  | null

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const withCode: Error & { code?: unknown } = err
  return withCode.code === 'ABORT_ERR' || err.name === 'AbortError'
}

function locationUri(loc: Locationish): string | undefined {
  const entry: { uri?: string; targetUri?: string } = loc
  return entry.targetUri ?? entry.uri
}

function mapOperationToLspRequest(
  input: Input,
  absolutePath: string,
): { method: string; params: Record<string, unknown> } {
  const uri = pathToFileURL(absolutePath).href
  const position = {
    line: (input.line ?? 1) - 1,
    character: (input.character ?? 1) - 1,
  }
  switch (input.operation) {
    case 'goToDefinition':
      return { method: 'textDocument/definition', params: { textDocument: { uri }, position } }
    case 'findReferences':
      return {
        method: 'textDocument/references',
        params: { textDocument: { uri }, position, context: { includeDeclaration: true } },
      }
    case 'hover':
      return { method: 'textDocument/hover', params: { textDocument: { uri }, position } }
    case 'documentSymbol':
      return { method: 'textDocument/documentSymbol', params: { textDocument: { uri } } }
    case 'goToImplementation':
      return { method: 'textDocument/implementation', params: { textDocument: { uri }, position } }
    case 'incomingCalls':
    case 'outgoingCalls':
      return { method: 'textDocument/prepareCallHierarchy', params: { textDocument: { uri }, position } }
    default:
      throw new Error(`Unsupported LSP operation: ${input.operation}`)
  }
}

async function gitignoredPathSet(
  paths: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<Set<string>> {
  const unique = [...new Set(paths.filter(p => p.length > 0))]
  const ignored = new Set<string>()
  if (unique.length === 0) return ignored
  for (let i = 0; i < unique.length; i += CHECK_IGNORE_BATCH) {
    const batch = unique.slice(i, i + CHECK_IGNORE_BATCH)
    try {
      const outcome = await execFileNoThrow('git', ['check-ignore', '--', ...batch], {
        timeout: CHECK_IGNORE_TIMEOUT_MS,
        abortSignal: signal,
      })
      if (outcome.code === 0 && outcome.stdout) {
        for (const rawLine of outcome.stdout.split(/\r?\n/)) {
          const line = rawLine.trim()
          if (!line) continue
          ignored.add(line)
          ignored.add(resolvePath(cwd, line))
        }
      }
    } catch (error) {
      passedOver(error)
    }
  }
  return ignored
}

async function filterGitignoredLocations<T extends Locationish>(
  locations: T[],
  cwd: string,
  signal: AbortSignal,
): Promise<T[]> {
  if (locations.length === 0) return locations
  const paths = locations
    .map(loc => {
      const uri = locationUri(loc)
      return uri ? uriToPath(uri) : ''
    })
    .filter(p => p.length > 0)
  const ignored = await gitignoredPathSet(paths, cwd, signal)
  if (ignored.size === 0) return locations
  return locations.filter(loc => {
    const uri = locationUri(loc)
    if (!uri) return true
    const filePath = uriToPath(uri)
    return !ignored.has(filePath) && !ignored.has(resolvePath(cwd, filePath))
  })
}

async function filterGitignoredSymbols(
  symbols: SymbolInformation[],
  cwd: string,
  signal: AbortSignal,
): Promise<SymbolInformation[]> {
  if (symbols.length === 0) return symbols
  const paths = symbols
    .map(sym => (sym.location?.uri ? uriToPath(sym.location.uri) : ''))
    .filter(p => p.length > 0)
  const ignored = await gitignoredPathSet(paths, cwd, signal)
  if (ignored.size === 0) return symbols
  return symbols.filter(sym => {
    const uri = sym.location?.uri
    if (!uri) return true
    const filePath = uriToPath(uri)
    return !ignored.has(filePath) && !ignored.has(resolvePath(cwd, filePath))
  })
}

function unclaimedFileResult(
  operation: string,
  filePath: string,
  absolutePath: string,
  cwd: string,
  startedAt: number,
): Settled {
  const ext = extname(absolutePath).toLowerCase() || basename(absolutePath)
  const { cause, remedy } = unclaimedCause(ext, cwd)
  const detail = cause.includes('no language server') ? '' : ` — ${cause}`
  const help = remedy ? ` What helps: ${remedy}.` : ''
  const result = `${operation} could not run: no language server claims '${ext}' files in this session${detail}.${help}${consumeInvalidLspServersNote()}`
  return {
    data: { operation, result, filePath, outcome: 'failed' },
    effect: makeEffect(operation, 'failed', result, startedAt),
  }
}

function formatStartFailure(
  err: unknown,
  manager: NonNullable<ReturnType<typeof getLspServerManager>>,
  operation: string,
  filePath: string,
  absolutePath: string,
  cwd: string,
  startedAt: number,
  serverOverride?: LSPServerInstance,
  pathOverride?: string,
): Settled | null {
  if (!isLspStartFailure(err)) return null
  const server =
    serverOverride ??
    manager.getAllServers().get(err.server) ??
    (absolutePath ? manager.getServerForFile(absolutePath) : undefined)
  const targetPath = pathOverride ?? absolutePath
  const result = server
    ? (() => {
        const title = serverTitle(server, targetPath)
        const remedy = remedyForLanguageServer(server, targetPath, err.lspCause, cwd)
        const attempted = `${title} did not start: ${err.lspCause}.${remedy ? ` What helps: ${remedy}.` : ''}`
        return lspStartFailureWords(err, title, remedy, attempted)
      })()
    : err.message
  return {
    data: { operation, result, filePath, outcome: 'failed' },
    effect: makeEffect(operation, 'failed', result, startedAt),
  }
}

async function runWorkspaceSymbolOp(
  input: Input,
  manager: NonNullable<ReturnType<typeof getLspServerManager>>,
  filePath: string,
  absolutePath: string,
  cwd: string,
  context: ToolUseContext,
  startedAt: number,
): Promise<Settled> {
  const query = input.query ?? ''
  let target: { server: LSPServerInstance; path: string }
  if (absolutePath) {
    const server = manager.getServerForFile(absolutePath)
    if (!server) return unclaimedFileResult('workspaceSymbol', filePath, absolutePath, cwd, startedAt)
    target = { server, path: absolutePath }
  } else {
    const chosen = workspaceSymbolServer(manager, query, cwd)
    if (!chosen) {
      const result = `No language server is configured for this workspace.${consumeInvalidLspServersNote()}`
      return {
        data: { operation: 'workspaceSymbol', result, filePath, outcome: 'failed' },
        effect: makeEffect('workspaceSymbol', 'failed', result, startedAt),
      }
    }
    target = chosen
  }

  try {
    if (target.server.state !== 'running') {
      let ready = await startedWithin(target.server, LSP_FIRST_CALL_START_WAIT_MS)
      if (!ready) {
        ready = await startedWithin(target.server, LSP_FIRST_CALL_START_WAIT_MS)
      }
      if (!ready) {
        const waitSeconds = Math.round((2 * LSP_FIRST_CALL_START_WAIT_MS) / 1000)
        const result = `${serverTitle(target.server, target.path)} is starting for this workspace and was not ready after ${waitSeconds} s. Send the same call again in a few seconds once it finishes indexing.`
        return {
          data: { operation: 'workspaceSymbol', result, filePath, outcome: 'indeterminate' },
          effect: makeEffect('workspaceSymbol', 'indeterminate', result, startedAt),
        }
      }
    }
    const response = (
      absolutePath
        ? await manager.sendRequest(absolutePath, 'workspace/symbol', { query })
        : await target.server.sendRequest('workspace/symbol', { query })
    ) as WorkspaceSymbolResponse | undefined
    if (response === undefined) {
      return unclaimedFileResult('workspaceSymbol', filePath, absolutePath, cwd, startedAt)
    }
    let rawSymbols: SymbolInformation[]
    let incompleteError: string | undefined
    if (Array.isArray(response)) {
      rawSymbols = response
    } else if (response !== null && Array.isArray(response.symbols)) {
      rawSymbols = response.symbols
      incompleteError = response.incompleteError
    } else {
      rawSymbols = []
    }
    const filtered = await filterGitignoredSymbols(rawSymbols, cwd, context.abortController.signal)
    if (filtered.length === 0) {
      const base = formatWorkspaceSymbolResult([], cwd)
      const result = incompleteError
        ? `${base}\nNote: workspace search was incomplete (${incompleteError}).`
        : base
      return {
        data: {
          operation: 'workspaceSymbol',
          result,
          filePath,
          resultCount: 0,
          fileCount: 0,
          outcome: 'no-change',
        },
        effect: makeEffect('workspaceSymbol', 'no-change', result, startedAt),
      }
    }
    const limit = Math.min(input.limit ?? WORKSPACE_SYMBOL_DEFAULT_LIMIT, WORKSPACE_SYMBOL_MAX_LIMIT)
    const { shown, total, truncated } = boundWorkspaceSymbols(filtered, limit)
    let formatted = formatWorkspaceSymbolResult(shown, cwd)
    if (truncated) {
      formatted += `\nShowing ${shown.length} of ${total} symbols (narrow the query or pass limit up to ${WORKSPACE_SYMBOL_MAX_LIMIT}).`
    }
    if (incompleteError) {
      formatted += `\nNote: workspace search was incomplete (${incompleteError}).`
    }
    const { resultCount, fileCount } = locationCounts(shown.map(sym => ({ uri: sym.location?.uri })))
    return {
      data: {
        operation: 'workspaceSymbol',
        result: formatted,
        filePath,
        resultCount,
        fileCount,
        outcome: 'succeeded',
      },
      effect: makeEffect('workspaceSymbol', 'succeeded', formatted, startedAt),
    }
  } catch (err) {
    if (isAbortError(err) || context.abortController.signal.aborted) throw err
    const startFail = formatStartFailure(
      err,
      manager,
      'workspaceSymbol',
      filePath,
      absolutePath,
      cwd,
      startedAt,
      target.server,
      target.path,
    )
    if (startFail) return startFail
    logError(err)
    const result = `Error performing workspaceSymbol: ${err instanceof Error ? err.message : String(err)}`
    return {
      data: { operation: 'workspaceSymbol', result, filePath, outcome: 'failed' },
      effect: makeEffect('workspaceSymbol', 'failed', result, startedAt),
    }
  }
}

async function runLspOperation(
  input: Input,
  tool: Tool,
  context: ToolUseContext,
  messageId: UUID | undefined,
  requestWritePermission?: (path: string) => Promise<boolean>,
): Promise<Settled> {
  const startedAt = Date.now()
  const cwd = getCwd()
  const filePath = input.filePath ?? ''
  const absolutePath = filePath ? expandPath(filePath) : ''

  const manager = getLspServerManager()
  if (!manager) {
    const result =
      'The language-server manager is not initialised. This may indicate a startup issue; language features are unavailable.'
    return {
      data: { operation: input.operation, result, filePath, outcome: 'failed' },
      effect: makeEffect(input.operation, 'failed', result, startedAt),
    }
  }

  if (MERCURY_BRIDGE_OPERATIONS.has(input.operation)) {
    if (!mercuryLspEnabled()) {
      const result = `The ${tool.name} operation requires the IDE bridge, which is disabled (MERCURY_LSP is off).`
      return {
        data: { operation: input.operation, result, filePath, outcome: 'failed' },
        effect: makeEffect(input.operation, 'failed', result, startedAt),
      }
    }
    const opInput: MercuryLspOpInput = {
      operation: input.operation as MercuryLspOpInput['operation'],
      filePath,
      line: input.line ?? 1,
      character: input.character ?? 1,
      ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
      ...(input.endCharacter !== undefined ? { endCharacter: input.endCharacter } : {}),
      ...(input.newName !== undefined ? { newName: input.newName } : {}),
      ...(input.newPath !== undefined ? { newPath: input.newPath } : {}),
      ...(input.apply !== undefined ? { apply: input.apply } : {}),
      ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
      ...(input.actionIndex !== undefined ? { actionIndex: input.actionIndex } : {}),
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.plan !== undefined ? { plan: input.plan } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.targetPath !== undefined ? { targetPath: input.targetPath } : {}),
    }
    try {
      const opOutput = await runMercuryLspOp({
        input: opInput,
        absolutePath,
        cwd,
        manager,
        tool,
        context,
        messageId,
        requestWritePermission,
      })
      const resultText =
        opOutput.effect.outcome === 'failed' && /no language server/i.test(opOutput.result)
          ? `${opOutput.result}${consumeInvalidLspServersNote()}`
          : opOutput.result
      return {
        data: {
          operation: input.operation,
          result: resultText,
          filePath,
          ...(opOutput.resultCount !== undefined ? { resultCount: opOutput.resultCount } : {}),
          ...(opOutput.fileCount !== undefined ? { fileCount: opOutput.fileCount } : {}),
          ...(opOutput.applied !== undefined ? { applied: opOutput.applied } : {}),
          outcome: opOutput.effect.outcome,
          ...(opOutput.changeView !== undefined ? { changeView: opOutput.changeView } : {}),
          ...(opOutput.edits !== undefined ? { edits: opOutput.edits } : {}),
          ...(opOutput.omittedEdits !== undefined ? { omittedEdits: opOutput.omittedEdits } : {}),
          ...(opOutput.plan !== undefined ? { plan: opOutput.plan } : {}),
        },
        effect: makeEffect(input.operation, opOutput.effect.outcome, resultText, startedAt, {
          changedPaths: opOutput.effect.changedPaths,
          evidence: opOutput.effect.evidence.slice(0, EVIDENCE_MAX_CHARS),
          ...(opOutput.effect.details !== undefined ? { details: opOutput.effect.details } : {}),
        }),
      }
    } catch (err) {
      if (isAbortError(err) || context.abortController.signal.aborted) throw err
      const startFail = formatStartFailure(err, manager, input.operation, filePath, absolutePath, cwd, startedAt)
      if (startFail) return startFail
      logError(err)
      const result = `Error performing ${input.operation}: ${err instanceof Error ? err.message : String(err)}`
      return {
        data: { operation: input.operation, result, filePath, outcome: 'failed' },
        effect: makeEffect(input.operation, 'failed', result, startedAt),
      }
    }
  }

  try {
    await manager.revalidateOpenDocuments()
  } catch (err) {
    passedOver(err)
  }

  if (input.operation === 'workspaceSymbol') {
    return runWorkspaceSymbolOp(input, manager, filePath, absolutePath, cwd, context, startedAt)
  }

  try {
    if (!manager.isFileOpen(absolutePath)) {
      const handle = await open(absolutePath, 'r')
      let content: string
      try {
        const info = await handle.stat()
        if (info.size > MAX_ANALYZABLE_FILE_BYTES) {
          const mb = (info.size / 1_000_000).toFixed(1)
          const result = `File is too large for language-server analysis (${mb} MB; the limit is 10 MB).`
          return {
            data: { operation: input.operation, result, filePath, outcome: 'failed' },
            effect: makeEffect(input.operation, 'failed', result, startedAt),
          }
        }
        content = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
      await manager.openFile(absolutePath, content)
    }

    const { method, params } = mapOperationToLspRequest(input, absolutePath)
    const response: unknown = await manager.sendRequest(absolutePath, method, params)
    if (response === undefined) {
      return unclaimedFileResult(input.operation, filePath, absolutePath, cwd, startedAt)
    }

    if (input.operation === 'incomingCalls' || input.operation === 'outgoingCalls') {
      const prepared = Array.isArray(response) ? response : response ? [response] : []
      if (prepared.length === 0) {
        const result = 'No call-hierarchy item found at this position.'
        return {
          data: {
            operation: input.operation,
            result,
            filePath,
            resultCount: 0,
            fileCount: 0,
            outcome: 'no-change',
          },
          effect: makeEffect(input.operation, 'no-change', result, startedAt),
        }
      }
      const callMethod =
        input.operation === 'incomingCalls'
          ? 'callHierarchy/incomingCalls'
          : 'callHierarchy/outgoingCalls'
      const calls: unknown = await manager.sendRequest(
        absolutePath,
        callMethod,
        { item: prepared[0] },
      )
      if (calls === undefined) {
        return unclaimedFileResult(input.operation, filePath, absolutePath, cwd, startedAt)
      }
      if (input.operation === 'incomingCalls') {
        const incoming = (calls as IncomingCall[] | null) ?? []
        const result = formatIncomingCallsResult(calls as IncomingCall[] | null, cwd)
        const { resultCount, fileCount } = locationCounts(incoming.map(c => ({ uri: c.from?.uri })))
        return {
          data: { operation: input.operation, result, filePath, resultCount, fileCount, outcome: 'succeeded' },
          effect: makeEffect(input.operation, 'succeeded', result, startedAt),
        }
      }
      const outgoing = (calls as OutgoingCall[] | null) ?? []
      const result = formatOutgoingCallsResult(calls as OutgoingCall[] | null, cwd)
      const { resultCount, fileCount } = locationCounts(outgoing.map(c => ({ uri: c.to?.uri })))
      return {
        data: { operation: input.operation, result, filePath, resultCount, fileCount, outcome: 'succeeded' },
        effect: makeEffect(input.operation, 'succeeded', result, startedAt),
      }
    }

    if (input.operation === 'goToDefinition' || input.operation === 'goToImplementation') {
      const rawLocations: Locationish[] = Array.isArray(response)
        ? (response as Locationish[])
        : response
          ? [response as Locationish]
          : []
      const locations = await filterGitignoredLocations(rawLocations, cwd, context.abortController.signal)
      const sourceLines =
        locations.length > 0 ? await readLocationSourceLines(locations, tool, context) : undefined
      const result = formatGoToDefinitionResult(locations.length > 0 ? locations : null, cwd, sourceLines)
      const { resultCount, fileCount } = locationCounts(locations.map(loc => ({ uri: locationUri(loc) })))
      return {
        data: { operation: input.operation, result, filePath, resultCount, fileCount, outcome: 'succeeded' },
        effect: makeEffect(input.operation, 'succeeded', result, startedAt),
      }
    }

    if (input.operation === 'findReferences') {
      const rawLocations: Location[] = Array.isArray(response) ? (response as Location[]) : []
      const locations = await filterGitignoredLocations(rawLocations, cwd, context.abortController.signal)
      const sourceLines =
        locations.length > 0 ? await readLocationSourceLines(locations, tool, context) : undefined
      const result = formatFindReferencesResult(locations.length > 0 ? locations : null, cwd, sourceLines)
      const { resultCount, fileCount } = locationCounts(locations)
      return {
        data: { operation: input.operation, result, filePath, resultCount, fileCount, outcome: 'succeeded' },
        effect: makeEffect(input.operation, 'succeeded', result, startedAt),
      }
    }

    if (input.operation === 'hover') {
      const result = formatHoverResult(response as HoverResult | null, cwd)
      const hasHover = !result.startsWith('No hover information available')
      return {
        data: {
          operation: input.operation,
          result,
          filePath,
          resultCount: hasHover ? 1 : 0,
          fileCount: hasHover ? 1 : 0,
          outcome: 'succeeded',
        },
        effect: makeEffect(input.operation, 'succeeded', result, startedAt),
      }
    }

    if (input.operation === 'documentSymbol') {
      const symbols = Array.isArray(response)
        ? (response as Array<DocumentSymbol | SymbolInformation>)
        : null
      const result = formatDocumentSymbolResult(symbols, cwd)
      const { resultCount, fileCount } = symbols
        ? documentSymbolCounts(symbols)
        : { resultCount: 0, fileCount: 0 }
      return {
        data: { operation: input.operation, result, filePath, resultCount, fileCount, outcome: 'succeeded' },
        effect: makeEffect(input.operation, 'succeeded', result, startedAt),
      }
    }

    const result = `Unsupported LSP operation: ${input.operation}`
    return {
      data: { operation: input.operation, result, filePath, outcome: 'failed' },
      effect: makeEffect(input.operation, 'failed', result, startedAt),
    }
  } catch (err) {
    if (isAbortError(err) || context.abortController.signal.aborted) throw err
    const startFail = formatStartFailure(err, manager, input.operation, filePath, absolutePath, cwd, startedAt)
    if (startFail) return startFail
    logError(err)
    const result = `Error performing ${input.operation}: ${err instanceof Error ? err.message : String(err)}`
    return {
      data: { operation: input.operation, result, filePath, outcome: 'failed' },
      effect: makeEffect(input.operation, 'failed', result, startedAt),
    }
  }
}

async function validateInput(name: LspToolName, input: LspInput) {
  const refuse = (message: string, errorCode = 3) => ({ result: false as const, message, errorCode })
  for (const path of [input.filePath, ...(input.paths ?? []), input.targetPath, input.newPath]) {
    const pathRefusal = controlCharacterPathRefusal(path)
    if (pathRefusal !== null) return refuse(pathRefusal, 1)
  }
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
    name, isLsp: true, shouldDefer: true,
    straightQuoteInputs: STRAIGHT_QUOTES[name], maxResultSizeChars: 100_000,
    inputSchema: lspInputSchema(name), inputJSONSchema: LSP_INPUT_JSON_SCHEMAS[name], outputSchema,
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
