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
import { isLspStartFailure } from '../../services/lsp/LSPServerInstance.js'
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
import { notBuilt } from '../../pi/holes.js'

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

async function runLspOperation(input: Input, tool: Tool, context: ToolUseContext, messageId: UUID | undefined, requestWritePermission?: (path: string) => Promise<boolean>): Promise<Settled> {
  return notBuilt('src/tools/LSPTool/LSPTool.ts:213')
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
  return notBuilt('src/tools/LSPTool/LSPTool.ts:418')
}

export const LspReadTool = makeLspTool('LspRead')
export const LspRenameTool = makeLspTool('LspRename')
export const LspMoveSymbolTool = makeLspTool('LspMoveSymbol')
export const LspMoveFileTool = makeLspTool('LspMoveFile')
export const LspCodeActionTool = makeLspTool('LspCodeAction')
export const LspFormatTool = makeLspTool('LspFormat')
export const LspRequestTool = makeLspTool('LspRequest')
export const LSP_TOOLS = [LspReadTool, LspRenameTool, LspMoveSymbolTool, LspMoveFileTool, LspCodeActionTool, LspFormatTool, LspRequestTool]
