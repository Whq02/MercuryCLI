import figures from 'figures'

import type { MCPServerConnection } from './mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { logError } from '../utils/log.js'
import { logForDebugging } from '../utils/debug.js'
import { isDeadlineExceeded, withInactivityDeadline } from '../utils/deadline.js'
import { normalizePathForComparison } from '../utils/file.js'
import { jsonParse } from '../utils/slowOperations.js'

/**
 * Baselines and diffs IDE (LSP-over-MCP) diagnostics around file edits and
 * formats the delta for the model. A process-wide singleton; every method
 * degrades to a safe no-op when uninitialised or disconnected.
 */

/** The edit-path budget: a baseline capture or a quiet open may cost an
 *  edit at most this long. */
export const EDIT_PATH_RPC_BUDGET_MS = 1_500
/** The post-edit delta read (one per turn, off the tool's critical path). */
export const POST_EDIT_RPC_BUDGET_MS = 4_000

export interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

// Contract data: first match wins.
const URI_PREFIXES = ['file://', '_claude_fs_right:', '_claude_fs_left:'] as const

function normalizeUri(uri: string): string {
  let path = uri
  for (const prefix of URI_PREFIXES) {
    if (path.startsWith(prefix)) {
      path = path.slice(prefix.length)
      break
    }
  }
  return normalizePathForComparison(path)
}

function diagnosticsEqual(a: Diagnostic, b: Diagnostic): boolean {
  return (
    a.message === b.message &&
    a.severity === b.severity &&
    a.source === b.source &&
    a.code === b.code &&
    a.range.start.line === b.range.start.line &&
    a.range.start.character === b.range.start.character &&
    a.range.end.line === b.range.end.line &&
    a.range.end.character === b.range.end.character
  )
}

/** Set-like: same length, every element of each has a value-equal partner. */
function diagnosticArraysEqual(a: Diagnostic[], b: Diagnostic[]): boolean {
  if (a.length !== b.length) return false
  return (
    a.every(entry => b.some(other => diagnosticsEqual(entry, other))) &&
    b.every(entry => a.some(other => diagnosticsEqual(entry, other)))
  )
}

type IdeClient = ReturnType<typeof getConnectedIdeClient>

const SUMMARY_CHAR_CAP = 4000
const TRUNCATION_MARKER = '… [diagnostics truncated]'

export class DiagnosticTrackingService {
  private static instance: DiagnosticTrackingService | undefined

  static getInstance(): DiagnosticTrackingService {
    if (!DiagnosticTrackingService.instance) {
      DiagnosticTrackingService.instance = new DiagnosticTrackingService()
    }
    return DiagnosticTrackingService.instance
  }

  static getSeveritySymbol(severity: string): string {
    switch (severity) {
      case 'Error':
        return figures.cross
      case 'Warning':
        return figures.warning
      case 'Info':
        return figures.info
      case 'Hint':
        return figures.star
      default:
        return figures.bullet
    }
  }

  /** Basename-introduced files, one indented line per diagnostic, 4000-cap. */
  static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
    const sections: string[] = []
    for (const file of files) {
      // The single sanctioned '/'-split of this module (win32 ratchet).
      const segments = file.uri.split('/')
      const name = segments.length > 1 ? segments[segments.length - 1] : file.uri
      const lines = [`${name}:`]
      for (const diagnostic of file.diagnostics) {
        const position = `[${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}]`
        let line = `  ${DiagnosticTrackingService.getSeveritySymbol(diagnostic.severity)} ${position} ${diagnostic.message}`
        if (diagnostic.code !== undefined) line += ` [${diagnostic.code}]`
        if (diagnostic.source !== undefined) line += ` (${diagnostic.source})`
        lines.push(line)
      }
      sections.push(lines.join('\n'))
    }
    const summary = sections.join('\n\n')
    if (summary.length <= SUMMARY_CHAR_CAP) return summary
    return summary.slice(0, SUMMARY_CHAR_CAP - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
  }

  private client: IdeClient = undefined
  private initialized = false
  private baselines = new Map<string, Diagnostic[]>()
  private rightPaneLastSeen = new Map<string, Diagnostic[]>()
  // Written on every baseline capture, cleared by reset/shutdown, read by
  // nothing — part of the reset contract; do not invent a consumer.
  private lastProcessedAt = new Map<string, number>()

  /** Idempotent. */
  initialize(client: NonNullable<IdeClient>): void {
    if (this.initialized) return
    this.client = client
    this.initialized = true
  }

  async shutdown(): Promise<void> {
    this.initialized = false
    this.client = undefined
    this.baselines.clear()
    this.rightPaneLastSeen.clear()
    this.lastProcessedAt.clear()
  }

  reset(): void {
    this.baselines.clear()
    this.rightPaneLastSeen.clear()
    this.lastProcessedAt.clear()
  }

  private isReady(): boolean {
    return this.initialized && this.client !== undefined && this.client.type === 'connected'
  }

  async handleQueryStart(clients: MCPServerConnection[]): Promise<void> {
    if (!this.initialized) {
      const ide = getConnectedIdeClient(clients)
      if (ide) this.initialize(ide)
      return
    }
    this.reset()
  }

  /**
   * Every IDE round-trip on the EDIT path is bounded (sweep #2,
   * packet 50): the baseline read before each Edit/Write/ChangeSet and the
   * quiet open ride a short budget, the post-edit delta a longer one. A busy
   * editor (indexing, a large workspace) would otherwise pause every edit by the
   * SDK's full 60s request timeout; now a slow reply degrades to "no
   * diagnostics this time" — logged, never a stalled tool call.
   */
  private async rpc(operation: string, params: Record<string, unknown>): Promise<DiagnosticFile[]> {
    const connection = this.client as { client?: { callTool?: (input: unknown) => Promise<unknown> } }
    const budgetMs = operation === 'getDiagnostics' && Object.keys(params).length === 0 ? POST_EDIT_RPC_BUDGET_MS : EDIT_PATH_RPC_BUDGET_MS
    let result: unknown
    try {
      result = await withInactivityDeadline({ seam: `IDE ${operation}`, limitMs: budgetMs }, () =>
        connection.client?.callTool?.({ name: operation, arguments: params }) ?? Promise.resolve(undefined),
      )
    } catch (error) {
      if (!isDeadlineExceeded(error)) throw error
      logForDebugging(`diagnosticTracking: ${error.message} — continuing without IDE diagnostics for this step`)
      return []
    }
    const content = (result as { content?: unknown })?.content
    if (!Array.isArray(content)) return []
    const textBlock = content.find(block => (block as { type?: string }).type === 'text') as
      | { text?: string }
      | undefined
    if (!textBlock || typeof textBlock.text !== 'string') return []
    return jsonParse(textBlock.text) as DiagnosticFile[]
  }

  /** Open quietly: select nothing, do not raise the window. */
  async ensureFileOpened(uri: string): Promise<void> {
    if (!this.isReady()) return
    try {
      await this.rpc('openFile', {
        filePath: uri,
        preview: false,
        startText: '',
        endText: '',
        selectToEndOfLine: false,
        makeFrontmost: false,
      })
    } catch (err) {
      logError(err)
    }
  }

  /** Capture the pre-edit baseline; an empty capture still tracks the file. */
  async beforeFileEdited(path: string): Promise<void> {
    if (!this.isReady()) return
    try {
      const files = await this.rpc('getDiagnostics', { uri: `file://${path}` })
      const key = normalizeUri(path)
      const entry = files[0]
      if (entry !== undefined) {
        if (normalizeUri(entry.uri) !== key) {
          logError(
            new Error(
              `diagnosticTracking: baseline URI mismatch (requested ${path}, got ${entry.uri})`,
            ),
          )
          return
        }
        this.baselines.set(key, entry.diagnostics)
        this.lastProcessedAt.set(key, Date.now())
        return
      }
      // No entry: an EMPTY baseline keeps the file tracked.
      this.baselines.set(key, [])
      this.lastProcessedAt.set(key, Date.now())
    } catch {
      // An IDE without diagnostics degrades to "no tracking".
    }
  }

  /** New diagnostics since the baselines, right-hand diff pane preferred. */
  async getNewDiagnostics(): Promise<DiagnosticFile[]> {
    if (!this.isReady()) return []
    let all: DiagnosticFile[]
    try {
      all = await this.rpc('getDiagnostics', {})
    } catch {
      return []
    }
    const fileEntries: DiagnosticFile[] = []
    const rightPane = new Map<string, DiagnosticFile>()
    for (const entry of all) {
      if (entry.uri.startsWith('_claude_fs_right:')) {
        rightPane.set(normalizeUri(entry.uri), entry)
      } else if (entry.uri.startsWith('file://')) {
        fileEntries.push(entry)
      }
    }
    const results: DiagnosticFile[] = []
    for (const entry of fileEntries) {
      const key = normalizeUri(entry.uri)
      const baseline = this.baselines.get(key)
      if (baseline === undefined) continue
      const right = rightPane.get(key)
      let chosen = entry
      if (right !== undefined) {
        const lastSeen = this.rightPaneLastSeen.get(key)
        if (lastSeen === undefined || !diagnosticArraysEqual(lastSeen, right.diagnostics)) {
          chosen = right
        }
        this.rightPaneLastSeen.set(key, right.diagnostics)
      }
      const fresh = chosen.diagnostics.filter(
        diagnostic => !baseline.some(existing => diagnosticsEqual(existing, diagnostic)),
      )
      if (fresh.length > 0) {
        // The emitted URI is always the file:// one.
        results.push({ uri: entry.uri, diagnostics: fresh })
      }
      this.baselines.set(key, chosen.diagnostics)
    }
    if (results.length > 0) {
      logForDebugging(`diagnosticTracking: ${results.length} file(s) with new diagnostics`)
    }
    return results
  }
}

export const diagnosticTracker = DiagnosticTrackingService.getInstance()
