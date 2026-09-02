import { stat } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

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

/**
 * The LSP tool: a gate-selected operation set (nine base read-only
 * operations, plus twelve bridge operations while the IDE bridge is on),
 * request routing, gitignore filtering, result formatting, and typed
 * effects.
 */

const MAX_ANALYZABLE_FILE_BYTES = 10_000_000
const WORKSPACE_SYMBOL_DEFAULT_LIMIT = 50
const WORKSPACE_SYMBOL_MAX_LIMIT = 200
const EVIDENCE_MAX_CHARS = 160
const CHECK_IGNORE_BATCH = 50
const CHECK_IGNORE_TIMEOUT_MS = 5_000

// Identifier + inline membership pinned by scripts/lsp/prove-lsp-wiring.ts
// (retired spelling kept deliberately; the registry owns live flag names).
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
])

/** Write-capable exactly when the operation writes AND apply is literal true. */
const WRITE_CAPABLE_OPERATIONS: ReadonlySet<string> = new Set([
  'rename',
  'codeActions',
  'pathRename',
  'fixDiagnostic',
  'formatDocument',
  'formatRange',
  'organizeImports',
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
}>

function isMercuryApplyOp(input: LooseInput | undefined): boolean {
  if (!input || !input.operation) return false
  // The raw-request escape hatch is write-classed UNCONDITIONALLY: an
  // arbitrary protocol method can carry server-side effects the read ladder
  // cannot see, so it always takes the write-permission path (edit-class
  // methods are additionally refused inside the op itself).
  if (input.operation === 'rawRequest') return true
  return WRITE_CAPABLE_OPERATIONS.has(input.operation) && input.apply === true
}

export type Input = LSPToolInput

/** The bridge change-view payload (state is proposed/applied only). */
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
}

/** The permission anchor, shared by checkPermissions and the apply
 *  pipeline's per-file re-check (a self-reference inside the tool literal
 *  would leave the tool implicitly typed). */
const lspPermissionShim = {
  name: LSP_TOOL_NAME,
  getPath(input?: { filePath?: string }): string {
    return input?.filePath || getCwd()
  },
}

// The output schema: the bridge-only fields (applied, outcome, changeView)
// are absent from the base-only form; gate read once at materialisation.
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
  })
})

// ── the flat framework schema (a union is not accepted there) ──────────────

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
  })
})

// ── effects ────────────────────────────────────────────────────────────────

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

// ── method mapping (contract data) ─────────────────────────────────────────

/**
 * The base method mapping (contract data). Positions convert from the
 * tool's 1-based line/character to the protocol's 0-based form, computed
 * once and omitted entirely for the position-free operations. Bridge
 * operations and workspaceSymbol have no base mapping and must throw if
 * reached here — the throw is the proof the routing held.
 */
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

// ── gitignore filtering ────────────────────────────────────────────────────

/** Paths reported ignored by `git check-ignore`, batched at 50 with a
 *  5-second timeout; any non-zero exit counts as "none ignored". */
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
      // None ignored on failure.
    }
  }
  return ignored
}

/**
 * Keep entries whose location URI survives the gitignore filter, plus every
 * entry with no resolvable URI at all (malformed entries are handed to the
 * formatter/counter, never swallowed here).
 */
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
    if (uri === undefined) return true // kept — dropped later by the counter
    return !ignored.has(uriToPath(uri))
  })
}

// ── counts ─────────────────────────────────────────────────────────────────

type CountedLocation = { uri?: string }

/** Valid-location count and distinct-URI count, error-logging URI-less
 *  entries before excluding them. */
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

// ── the tool ────────────────────────────────────────────────────────────────

/**
 * The tool's work, run INSIDE the one armed cancellation door: every
 * language-server request this call makes — through the bridge ops, the
 * workspace search, or the document-scoped road — reads the operator's
 * abort signal from the async context, so no call site can forget to
 * thread it and no request can outlive an Esc.
 */
async function runLspToolCall(input: Input, context: ToolUseContext) {
  const startedAt = Date.now()
  const operation = input.operation
  const filePath = 'filePath' in input ? (input.filePath ?? '') : ''
  const cwd = getCwd()

  const fail = (result: string, overrides: Partial<ToolEffect> = {}) => ({
    data: { operation, result, filePath } satisfies Output,
    effect: makeEffect(operation, 'failed', result, startedAt, overrides),
  })

  // Server initialisation may still be pending — wait, or the tool
  // reports "no server" before init completes.
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

  // Bridge operations route to the bridge pipeline and never reach the
  // base method mapping.
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
      const message = `The ${operation} operation failed: ${err instanceof Error ? err.message : String(err)}`
      return fail(message)
    }
  }

  // workspaceSymbol is workspace-scoped.
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
      // Filter located symbols through gitignore; symbols with no location
      // URI survive to the counter/formatter.
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

  // Document-scoped base operations.
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
      const extension = documentPath.split('.').pop() ?? ''
      const message = `No language server is available for .${extension} files.`
      logError(new Error(`LSP ${operation}: no server response for ${documentPath}`))
      return fail(message)
    }

    // The call-hierarchy two-step: prepare, then incoming/outgoing on the
    // FIRST prepared item.
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

    // Gitignore filtering for the location-bearing operations, arrays only.
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
    const message = `The ${operation} operation failed: ${err instanceof Error ? err.message : String(err)}`
    return fail(message)
  }
}

export const LSPTool = buildTool({
  name: LSP_TOOL_NAME,
  isLsp: true,
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema() {
    return flatSchema() as z.ZodType
  },
  get outputSchema() {
    return outputSchema() as z.ZodType
  },
  /** Never names the bridge operations while the bridge is off. */
  get searchHint(): string {
    return mercuryLspEnabled()
      ? 'code intelligence: definitions references hover symbols diagnostics rename code actions formatting'
      : 'code intelligence: definitions references hover symbols call hierarchy'
  },
  // Mounted whenever a server is configured, whatever its health: a failed
  // server is reported by serverStatus, never by the tool's absence (FN-015
  // rank 56 — gating on connection took the diagnostic surface away at the
  // moment every claimant reached error).
  isEnabled(): boolean {
    return isLspToolMounted()
  },
  // Probed with no input at all by capability descriptors and tracing: the
  // no-input answer is the read-only posture, and it must never throw.
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
    // The gate is read live per use, unlike the memoised schemas.
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
      // The same write-permission path as the Edit tool, anchored on
      // filePath. Every ADDITIONAL file a workspace edit touches is
      // re-checked inside the apply pipeline.
      return checkWritePermissionForTool(lspPermissionShim, input, permissionContext)
    }
    return checkReadPermissionForTool(lspPermissionShim, input, permissionContext)
  },
  async validateInput(input: LooseInput) {
    const parsed = lspToolInputSchema().safeParse(input)
    if (!parsed.success) {
      return {
        result: false as const,
        message: parsed.error.message,
        errorCode: 3,
      }
    }
    const filePath = (parsed.data as { filePath?: string }).filePath
    if (filePath === undefined) {
      return { result: true as const } // workspace-scoped
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
        return {
          result: false as const,
          message: `File does not exist: ${filePath}`,
          errorCode: 1,
        }
      }
      logError(err)
      return {
        result: false as const,
        message: `Cannot access ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: 4,
      }
    }
    if (!stats.isFile()) {
      return {
        result: false as const,
        message: `Path is not a file: ${filePath}`,
        errorCode: 2,
      }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    return runWithLspAbortSignal(context.abortController.signal, () => runLspToolCall(input, context))
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
