// mercury-ts sidecar — the built-in TypeScript/JavaScript LSP server behind
// the IDE-hands bridge (MERCURY_LSP).
//
// WHY THIS EXISTS: without it a bare workspace has no LSP server and the
// LSP tool stays dead.
// This sidecar is a real Language Server Protocol server, spawned from the
// SAME bundle (`mercury --lsp-ts-sidecar`, see entrypoints/cli.tsx), that
// drives the WORKSPACE's own `typescript` package (never a bundled copy — the
// analysis matches the project's compiler version). No workspace typescript ⇒
// builtinServers offers no config and the bridge degrades honestly.
//
// DESIGN CONSTRAINTS (load-bearing):
//   · Node builtins only + a runtime-resolved `typescript`. No imports from
//     the wider harness (theme/config/feature()), so `bun run` can load and
//     drive it directly — scripts/lsp/prove-lsp-e2e.ts spawns exactly this
//     file's entry and speaks raw JSON-RPC to it.
//   · The `typescript` require is VARIABLE-INDIRECTED so the bundler can
//     never inline a compiler copy into dist.
//   · Every request handler is try/caught into a JSON-RPC error response —
//     a malformed request must never kill the server (the host retries and
//     health-tracks; a crash loop burns its maxRestarts budget).
//
// Protocol surface (matches the capabilities advertised in initialize):
//   textDocument/didOpen|didChange|didSave|didClose   (full-text sync)
//   textDocument/definition|references|hover|documentSymbol|implementation
//   textDocument/prepareCallHierarchy + callHierarchy/incomingCalls|outgoingCalls
//   textDocument/prepareRename|rename                 (WorkspaceEdit.changes)
//   textDocument/codeAction                           (quickfix, literal edits)
//   textDocument/diagnostic                           (pull, LSP 3.17 "full")
//   workspace/symbol
//   + push diagnostics (publishDiagnostics) debounced after open/change/save.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type * as TS from 'typescript'

type TsModule = typeof TS

//
// JSON-RPC framing — the shared sidecar framing owner (extraction;
// byte-identical bodies, one owner for every in-bundle sidecar)
//

import {
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RPC_SERVER_NOT_INITIALIZED,
  createFrameReader,
  createFrameWriter,
  type JsonRpcId,
  type JsonRpcMessage,
} from '../sidecarFraming.js'

//
// LSP shapes (structural — kept local so the sidecar has zero LSP deps)
//

interface LspPosition {
  line: number
  character: number
}
interface LspRange {
  start: LspPosition
  end: LspPosition
}
interface LspLocation {
  uri: string
  range: LspRange
}
interface LspTextEdit {
  range: LspRange
  newText: string
}
interface LspDiagnostic {
  range: LspRange
  severity: number
  code?: number | string
  source: string
  message: string
}
interface LspDocumentSymbol {
  name: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}
interface LspCallHierarchyItem {
  name: string
  kind: number
  uri: string
  range: LspRange
  selectionRange: LspRange
  detail?: string
}
interface LspCodeAction {
  title: string
  kind: string
  diagnostics?: LspDiagnostic[]
  edit?: { changes: Record<string, LspTextEdit[]> }
  data?: unknown
}

//
// Text/position math (UTF-16 code units, matching both LSP and TS)
//

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10) starts.push(i + 1)
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    }
  }
  return starts
}

function offsetAt(text: string, pos: LspPosition): number {
  const starts = lineStartsOf(text)
  if (pos.line >= starts.length) return text.length
  const lineStart = starts[pos.line] ?? text.length
  const lineEnd = pos.line + 1 < starts.length ? (starts[pos.line + 1] ?? text.length) : text.length
  return Math.min(lineStart + Math.max(0, pos.character), lineEnd)
}

function positionAt(text: string, offset: number): LspPosition {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const starts = lineStartsOf(text)
  // Binary search for the greatest line start ≤ offset.
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((starts[mid] ?? 0) <= clamped) lo = mid
    else hi = mid - 1
  }
  return { line: lo, character: clamped - (starts[lo] ?? 0) }
}

function spanToRange(text: string, start: number, length: number): LspRange {
  return {
    start: positionAt(text, start),
    end: positionAt(text, start + length),
  }
}

//
// Workspace typescript resolution
//

/**
 * Resolve the workspace's own `typescript` package from `root`. Exported for
 * builtinServers' availability pre-check (same logic host-side and here).
 *
 * Deterministic walk-up, NOT createRequire: under bun,
 * createRequire falls through to the GLOBAL install cache — an empty
 * workspace "resolved" a typescript@7 version stub with no compiler API
 * (caught live by prove-resolution-law), which would break the sidecar and
 * mask the packaged-fallback rung. Same guard as tsFacility.resolveWorkspace.
 */
export function resolveWorkspaceTypescript(root: string): string | undefined {
  let dir = path.resolve(root)
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function loadTypescript(tsPath: string): TsModule {
  const req = createRequire(tsPath)
  // Variable indirection — the bundler must never inline the compiler.
  const target: string = tsPath
  return req(target) as TsModule
}

//
// Documents + projects
//

interface OpenDoc {
  text: string
  version: number
}

interface Project {
  key: string
  service: TS.LanguageService
  /** Extra root files adopted into this project (open docs outside fileNames). */
  extraRoots: Set<string>
  fileNames: Set<string>
  rootDir: string
}

const INFERRED_PROJECT_KEY = '<inferred>'

class SidecarState {
  readonly ts: TsModule
  readonly workspaceRoot: string
  readonly openDocs = new Map<string, OpenDoc>()
  readonly projects = new Map<string, Project>()
  /** dir → nearest tsconfig. NEGATIVE entries re-probe after a TTL so a
   *  tsconfig created mid-session becomes visible without a restart
   *  (tsserver watches the fs; we poll on touch instead). */
  private readonly configForDir = new Map<
    string,
    { value: string | undefined; at: number }
  >()
  private readonly mtimeCache = new Map<string, { v: string; at: number }>()
  private docVersionCounter = 0

  constructor(ts: TsModule, workspaceRoot: string) {
    this.ts = ts
    this.workspaceRoot = workspaceRoot
  }

  normalize(file: string): string {
    return path.resolve(file)
  }

  openDoc(file: string, text: string): void {
    this.docVersionCounter++
    this.openDocs.set(this.normalize(file), {
      text,
      version: this.docVersionCounter,
    })
  }

  changeDoc(file: string, text: string): void {
    this.docVersionCounter++
    this.openDocs.set(this.normalize(file), {
      text,
      version: this.docVersionCounter,
    })
  }

  closeDoc(file: string): void {
    const norm = this.normalize(file)
    this.openDocs.delete(norm)
    // The doc falls back to mtime versioning — a cached mtime from before
    // the last write would serve a STALE program for up to the cache TTL
    // (the post-apply didSave publish lands inside that window). Invalidate.
    this.mtimeCache.delete(norm)
  }

  /** Current text of a file: overlay first, then disk. Undefined if unreadable. */
  textOf(file: string): string | undefined {
    const norm = this.normalize(file)
    const open = this.openDocs.get(norm)
    if (open) return open.text
    try {
      return fs.readFileSync(norm, 'utf8')
    } catch {
      return undefined
    }
  }

  private scriptVersion(file: string): string {
    const open = this.openDocs.get(file)
    if (open) return `o${open.version}`
    const now = Date.now()
    const cached = this.mtimeCache.get(file)
    if (cached && now - cached.at < 2000) return cached.v
    let v = 'missing'
    try {
      v = `m${fs.statSync(file).mtimeMs}`
    } catch {
      // keep 'missing'
    }
    this.mtimeCache.set(file, { v, at: now })
    return v
  }

  private buildHost(
    rootDir: string,
    options: TS.CompilerOptions,
    baseFiles: () => string[],
  ): TS.LanguageServiceHost {
    const ts = this.ts
    return {
      getScriptFileNames: baseFiles,
      getScriptVersion: f => this.scriptVersion(this.normalize(f)),
      getScriptSnapshot: f => {
        const text = this.textOf(f)
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text)
      },
      getCompilationSettings: () => options,
      getCurrentDirectory: () => rootDir,
      getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
      fileExists: f => ts.sys.fileExists(f),
      readFile: (f, enc) => ts.sys.readFile(f, enc),
      readDirectory: (p, ext, exc, inc, depth) =>
        ts.sys.readDirectory(p, ext, exc, inc, depth),
      directoryExists: d => ts.sys.directoryExists(d),
      getDirectories: d => ts.sys.getDirectories(d),
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    }
  }

  private loadConfiguredProject(configPath: string): Project | undefined {
    const existing = this.projects.get(configPath)
    if (existing) return existing
    const ts = this.ts
    const host: TS.ParseConfigFileHost = {
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      getCurrentDirectory: () => path.dirname(configPath),
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      onUnRecoverableConfigFileDiagnostic: () => {
        /* collected below via parsed.errors; never throw */
      },
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)
    if (!parsed) return undefined
    const rootDir = path.dirname(configPath)
    const fileNames = new Set(parsed.fileNames.map(f => this.normalize(f)))
    const extraRoots = new Set<string>()
    const project: Project = {
      key: configPath,
      rootDir,
      fileNames,
      extraRoots,
      service: this.ts.createLanguageService(
        this.buildHost(rootDir, parsed.options, () => [
          ...fileNames,
          ...extraRoots,
        ]),
        this.ts.createDocumentRegistry(
          this.ts.sys.useCaseSensitiveFileNames,
          rootDir,
        ),
      ),
    }
    this.projects.set(configPath, project)
    return project
  }

  private inferredProject(): Project {
    const existing = this.projects.get(INFERRED_PROJECT_KEY)
    if (existing) return existing
    const ts = this.ts
    const options: TS.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX,
      strict: false,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    }
    const extraRoots = new Set<string>()
    const project: Project = {
      key: INFERRED_PROJECT_KEY,
      rootDir: this.workspaceRoot,
      fileNames: new Set(),
      extraRoots,
      service: ts.createLanguageService(
        this.buildHost(this.workspaceRoot, options, () => [...extraRoots]),
        ts.createDocumentRegistry(
          ts.sys.useCaseSensitiveFileNames,
          this.workspaceRoot,
        ),
      ),
    }
    this.projects.set(INFERRED_PROJECT_KEY, project)
    return project
  }

  /**
   * Project for a file: nearest tsconfig walking up (cached per directory).
   * Solution-style configs (files:[] + references) fall through to the first
   * referenced config that claims the file. Files outside any config land in
   * a shared inferred project. Open files not listed by their config are
   * adopted as extra roots so excluded-but-open files still analyze.
   */
  projectFor(file: string): Project {
    const norm = this.normalize(file)
    const dir = path.dirname(norm)
    const cached = this.configForDir.get(dir)
    let configPath: string | undefined
    const NEGATIVE_TTL_MS = 30_000
    if (
      cached &&
      (cached.value !== undefined || Date.now() - cached.at < NEGATIVE_TTL_MS)
    ) {
      configPath = cached.value
    } else {
      configPath = this.ts.findConfigFile(
        dir,
        f => this.ts.sys.fileExists(f),
        'tsconfig.json',
      )
      this.configForDir.set(dir, { value: configPath, at: Date.now() })
    }
    let project: Project | undefined
    if (configPath) {
      project = this.loadConfiguredProject(this.normalize(configPath))
      // Solution-style: no own files but has references → descend one level.
      if (project && project.fileNames.size === 0) {
        const parsed = this.ts.getParsedCommandLineOfConfigFile(
          project.key,
          {},
          {
            fileExists: this.ts.sys.fileExists,
            readFile: this.ts.sys.readFile,
            readDirectory: this.ts.sys.readDirectory,
            getCurrentDirectory: () => project!.rootDir,
            useCaseSensitiveFileNames: this.ts.sys.useCaseSensitiveFileNames,
            onUnRecoverableConfigFileDiagnostic: () => {},
          },
        )
        for (const ref of parsed?.projectReferences ?? []) {
          const refConfig = this.ts.resolveProjectReferencePath(ref)
          const refProject = this.loadConfiguredProject(
            this.normalize(refConfig),
          )
          if (refProject?.fileNames.has(norm)) {
            project = refProject
            break
          }
        }
      }
    }
    if (!project) project = this.inferredProject()
    if (!project.fileNames.has(norm)) project.extraRoots.add(norm)
    return project
  }

  /** All projects that currently exist (for workspace/symbol fan-out). */
  allProjects(): Project[] {
    return [...this.projects.values()]
  }
}

//
// TS → LSP mappers
//

function toUri(file: string): string {
  return pathToFileURL(file).href
}

function fromUri(uri: string): string {
  return uri.startsWith('file://') ? fileURLToPath(uri) : uri
}

/** ts.ScriptElementKind → LSP SymbolKind (the typescript-language-server mapping). */
function symbolKindOf(kind: string): number {
  switch (kind) {
    case 'module':
      return 2
    case 'class':
    case 'local class':
    case 'type':
      return 5
    case 'method':
      return 6
    case 'property':
    case 'getter':
    case 'setter':
      return 7
    case 'constructor':
      return 9
    case 'enum':
      return 10
    case 'interface':
      return 11
    case 'function':
    case 'local function':
      return 12
    case 'var':
    case 'let':
    case 'local var':
    case 'alias':
    case 'parameter':
      return 13
    case 'const':
      return 14
    case 'enum member':
      return 22
    case 'type parameter':
      return 26
    default:
      return 13
  }
}

function diagnosticSeverityOf(ts: TsModule, cat: TS.DiagnosticCategory): number {
  switch (cat) {
    case ts.DiagnosticCategory.Error:
      return 1
    case ts.DiagnosticCategory.Warning:
      return 2
    case ts.DiagnosticCategory.Message:
      return 3
    default:
      return 4
  }
}

const DIAGNOSTIC_CAP_PER_FILE = 200

//
// The sidecar
//

export interface SidecarOptions {
  /** Preferred typescript module path (from initializationOptions). */
  typescriptPath?: string
  /** Debug line sink (defaults to silent; entry wires stderr under debug env). */
  log?: (line: string) => void
}

/**
 * Run the mercury-ts LSP sidecar over the given streams. Returns a promise
 * that resolves when the peer disconnects or an `exit` notification arrives
 * (the entrypoint then exits the process).
 */
export function runTsLspSidecar(
  input: Readable,
  output: Writable,
  opts: SidecarOptions = {},
): Promise<number> {
  const log = opts.log ?? (() => {})
  const write = createFrameWriter(output)

  let state: SidecarState | undefined
  let shutdownRequested = false
  const pendingPublishes = new Map<string, ReturnType<typeof setTimeout>>()

  return new Promise<number>(resolve => {
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      for (const timer of pendingPublishes.values()) clearTimeout(timer)
      resolve(code)
    }

    function respond(id: JsonRpcId, result: unknown): void {
      write({ jsonrpc: '2.0', id, result })
    }
    function respondError(id: JsonRpcId, code: number, message: string): void {
      write({ jsonrpc: '2.0', id, error: { code, message } })
    }
    function notify(method: string, params: unknown): void {
      write({ jsonrpc: '2.0', method, params })
    }

    // ---- diagnostics ----

    function computeDiagnostics(file: string): LspDiagnostic[] {
      if (!state) return []
      const norm = state.normalize(file)
      const project = state.projectFor(norm)
      const text = state.textOf(norm) ?? ''
      const all = [
        ...project.service.getSyntacticDiagnostics(norm),
        ...project.service.getSemanticDiagnostics(norm),
      ]
      const out: LspDiagnostic[] = []
      for (const d of all.slice(0, DIAGNOSTIC_CAP_PER_FILE)) {
        const start = d.start ?? 0
        const length = d.length ?? 0
        out.push({
          range: spanToRange(text, start, length),
          severity: diagnosticSeverityOf(state.ts, d.category),
          code: d.code,
          source: 'mercury-ts',
          message: state.ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        })
      }
      return out
    }

    function schedulePublish(file: string): void {
      if (!state) return
      const norm = state.normalize(file)
      const existing = pendingPublishes.get(norm)
      if (existing) clearTimeout(existing)
      pendingPublishes.set(
        norm,
        setTimeout(() => {
          pendingPublishes.delete(norm)
          try {
            notify('textDocument/publishDiagnostics', {
              uri: toUri(norm),
              diagnostics: computeDiagnostics(norm),
            })
          } catch (e) {
            log(`publishDiagnostics failed for ${norm}: ${String(e)}`)
          }
        }, 150),
      )
    }

    // ---- request handlers ----

    function requireState(): SidecarState {
      if (!state) {
        throw Object.assign(new Error('server not initialized'), {
          rpcCode: RPC_SERVER_NOT_INITIALIZED,
        })
      }
      return state
    }

    function docContext(params: unknown): {
      st: SidecarState
      file: string
      text: string
      project: Project
      offset: number
    } {
      const st = requireState()
      const p = params as {
        textDocument: { uri: string }
        position?: LspPosition
      }
      const file = st.normalize(fromUri(p.textDocument.uri))
      const text = st.textOf(file) ?? ''
      const project = st.projectFor(file)
      const offset = p.position ? offsetAt(text, p.position) : 0
      return { st, file, text, project, offset }
    }

    function spansToLocations(
      st: SidecarState,
      entries: readonly { fileName: string; textSpan: TS.TextSpan }[],
    ): LspLocation[] {
      const out: LspLocation[] = []
      for (const entry of entries) {
        const file = st.normalize(entry.fileName)
        const text = st.textOf(file)
        if (text === undefined) continue
        out.push({
          uri: toUri(file),
          range: spanToRange(text, entry.textSpan.start, entry.textSpan.length),
        })
      }
      return out
    }

    function navTreeToSymbols(
      text: string,
      items: TS.NavigationTree[] | undefined,
    ): LspDocumentSymbol[] {
      if (!items) return []
      const out: LspDocumentSymbol[] = []
      for (const item of items) {
        const spans = item.spans
        if (!spans || spans.length === 0) {
          out.push(...navTreeToSymbols(text, item.childItems))
          continue
        }
        const first = spans[0]!
        let minStart = first.start
        let maxEnd = first.start + first.length
        for (const s of spans) {
          minStart = Math.min(minStart, s.start)
          maxEnd = Math.max(maxEnd, s.start + s.length)
        }
        const selection = item.nameSpan ?? first
        const children = navTreeToSymbols(text, item.childItems)
        const symbol: LspDocumentSymbol = {
          name: item.text,
          kind: symbolKindOf(item.kind),
          range: spanToRange(text, minStart, maxEnd - minStart),
          selectionRange: spanToRange(text, selection.start, selection.length),
        }
        if (children.length > 0) symbol.children = children
        out.push(symbol)
      }
      return out
    }

    function callItemOf(
      st: SidecarState,
      item: TS.CallHierarchyItem,
    ): LspCallHierarchyItem | undefined {
      const file = st.normalize(item.file)
      const text = st.textOf(file)
      if (text === undefined) return undefined
      const mapped: LspCallHierarchyItem = {
        name: item.name,
        kind: symbolKindOf(item.kind),
        uri: toUri(file),
        range: spanToRange(text, item.span.start, item.span.length),
        selectionRange: spanToRange(
          text,
          item.selectionSpan.start,
          item.selectionSpan.length,
        ),
      }
      if (item.containerName) mapped.detail = item.containerName
      return mapped
    }

    function fileTextChangesToWorkspaceEdit(
      st: SidecarState,
      changesList: readonly TS.FileTextChanges[],
    ): { changes: Record<string, LspTextEdit[]> } {
      const changes: Record<string, LspTextEdit[]> = {}
      for (const fileChanges of changesList) {
        const file = st.normalize(fileChanges.fileName)
        const text = st.textOf(file)
        if (text === undefined) continue
        const uri = toUri(file)
        const edits = (changes[uri] ??= [])
        for (const tc of fileChanges.textChanges) {
          edits.push({
            range: spanToRange(text, tc.span.start, tc.span.length),
            newText: tc.newText,
          })
        }
      }
      return { changes }
    }

    const FORMAT_OPTIONS: TS.FormatCodeSettings = {
      indentSize: 2,
      tabSize: 2,
      convertTabsToSpaces: true,
      newLineCharacter: '\n',
      insertSpaceAfterCommaDelimiter: true,
      insertSpaceAfterKeywordsInControlFlowStatements: true,
      insertSpaceBeforeAndAfterBinaryOperators: true,
      semicolons: 'ignore' as TS.SemicolonPreference,
    }

    function handleRequest(method: string, params: unknown): unknown {
      switch (method) {
        case 'initialize': {
          const p = params as {
            rootUri?: string | null
            rootPath?: string | null
            workspaceFolders?: { uri: string }[] | null
            initializationOptions?: { typescriptPath?: string } | null
          }
          const firstFolder = p.workspaceFolders?.[0]?.uri
          const root = path.resolve(
            firstFolder
              ? fromUri(firstFolder)
              : p.rootUri
                ? fromUri(p.rootUri)
                : (p.rootPath ?? process.cwd()),
          )
          const tsPath =
            opts.typescriptPath ??
            p.initializationOptions?.typescriptPath ??
            resolveWorkspaceTypescript(root)
          if (!tsPath) {
            throw Object.assign(
              new Error(
                `no resolvable 'typescript' package from workspace root ${root}`,
              ),
              { rpcCode: RPC_INTERNAL_ERROR },
            )
          }
          const ts = loadTypescript(tsPath)
          state = new SidecarState(ts, root)
          log(`initialized: typescript@${ts.version} root=${root}`)
          return {
            capabilities: {
              textDocumentSync: {
                openClose: true,
                change: 1,
                save: { includeText: false },
              },
              definitionProvider: true,
              referencesProvider: true,
              hoverProvider: true,
              documentFormattingProvider: true,
              documentRangeFormattingProvider: true,
              documentSymbolProvider: true,
              workspaceSymbolProvider: true,
              implementationProvider: true,
              typeDefinitionProvider: true,
              callHierarchyProvider: true,
              renameProvider: { prepareProvider: true },
              codeActionProvider: { codeActionKinds: ['quickfix'] },
              diagnosticProvider: {
                interFileDependencies: true,
                workspaceDiagnostics: false,
              },
              // path-rename intelligence — the client asks
              // willRenameFiles BEFORE moving a file; we answer with the
              // import-updating WorkspaceEdit from the workspace TypeScript's
              // getEditsForFileRename.
              workspace: {
                fileOperations: {
                  willRename: {
                    filters: [
                      {
                        pattern: {
                          glob: '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}',
                        },
                      },
                    ],
                  },
                },
              },
            },
            serverInfo: { name: 'mercury-ts', version: ts.version },
          }
        }

        case 'shutdown':
          shutdownRequested = true
          return null

        case 'textDocument/definition': {
          const { st, project, file, offset } = docContext(params)
          const info = project.service.getDefinitionAndBoundSpan(file, offset)
          return spansToLocations(st, info?.definitions ?? [])
        }

        case 'textDocument/implementation': {
          const { st, project, file, offset } = docContext(params)
          const impls = project.service.getImplementationAtPosition(
            file,
            offset,
          )
          return spansToLocations(st, impls ?? [])
        }

        case 'textDocument/typeDefinition': {
          const { st, project, file, offset } = docContext(params)
          const defs = project.service.getTypeDefinitionAtPosition(
            file,
            offset,
          )
          return spansToLocations(st, defs ?? [])
        }

        case 'workspace/willRenameFiles': {
          // the import-updating edit for a file move.
          // Edits are computed against the CURRENT (pre-move) paths — the
          // client applies them, then performs the move, then notifies
          // didRenameFiles.
          const st = requireState()
          const p = params as { files?: { oldUri: string; newUri: string }[] }
          const merged: Record<string, LspTextEdit[]> = {}
          for (const f of p.files ?? []) {
            const oldFile = st.normalize(fromUri(f.oldUri))
            const newFile = st.normalize(fromUri(f.newUri))
            const project = st.projectFor(oldFile)
            const changes = project.service.getEditsForFileRename(
              oldFile,
              newFile,
              FORMAT_OPTIONS,
              {},
            )
            const edit = fileTextChangesToWorkspaceEdit(st, changes)
            for (const [uri, edits] of Object.entries(edit.changes)) {
              ;(merged[uri] ??= []).push(...edits)
            }
          }
          return { changes: merged }
        }

        case 'textDocument/formatting': {
          // the TS/JS formatting owner is the SHIPPED compiler's
          // own formatter — zero new bytes; project-local style tools keep
          // winning upstream (the LSP capability owner picks the first
          // ADVERTISING claimant, and operator/extension servers merge first).
          const st = requireState()
          const p = params as {
            textDocument: { uri: string }
            options?: { tabSize?: number; insertSpaces?: boolean }
          }
          const file = st.normalize(fromUri(p.textDocument.uri))
          const text = st.textOf(file)
          if (text === undefined) return []
          const project = st.projectFor(file)
          const settings: TS.FormatCodeSettings = {
            ...FORMAT_OPTIONS,
            indentSize: p.options?.tabSize ?? FORMAT_OPTIONS.indentSize,
            tabSize: p.options?.tabSize ?? FORMAT_OPTIONS.tabSize,
            convertTabsToSpaces: p.options?.insertSpaces ?? true,
          }
          const edits = project.service.getFormattingEditsForDocument(file, settings)
          return edits.map(e => ({
            range: spanToRange(text, e.span.start, e.span.length),
            newText: e.newText,
          }))
        }

        case 'textDocument/rangeFormatting': {
          const st = requireState()
          const p = params as {
            textDocument: { uri: string }
            range: { start: LspPosition; end: LspPosition }
            options?: { tabSize?: number; insertSpaces?: boolean }
          }
          const file = st.normalize(fromUri(p.textDocument.uri))
          const text = st.textOf(file)
          if (text === undefined) return []
          const project = st.projectFor(file)
          const settings: TS.FormatCodeSettings = {
            ...FORMAT_OPTIONS,
            indentSize: p.options?.tabSize ?? FORMAT_OPTIONS.indentSize,
            tabSize: p.options?.tabSize ?? FORMAT_OPTIONS.tabSize,
            convertTabsToSpaces: p.options?.insertSpaces ?? true,
          }
          const edits = project.service.getFormattingEditsForRange(
            file,
            offsetAt(text, p.range.start),
            offsetAt(text, p.range.end),
            settings,
          )
          return edits.map(e => ({
            range: spanToRange(text, e.span.start, e.span.length),
            newText: e.newText,
          }))
        }

        case 'textDocument/references': {
          const { st, project, file, offset } = docContext(params)
          const p = params as { context?: { includeDeclaration?: boolean } }
          const includeDecl = p.context?.includeDeclaration !== false
          const refs = project.service.getReferencesAtPosition(file, offset)
          // isDefinition lives on ReferencedSymbolEntry in the TS typings but
          // is populated on these entries at runtime; read it structurally.
          const filtered = (refs ?? []).filter(
            r => includeDecl || !(r as { isDefinition?: boolean }).isDefinition,
          )
          return spansToLocations(st, filtered)
        }

        case 'textDocument/hover': {
          const { st, project, file, text, offset } = docContext(params)
          const info = project.service.getQuickInfoAtPosition(file, offset)
          if (!info) return null
          const signature = st.ts.displayPartsToString(info.displayParts ?? [])
          const docs = st.ts.displayPartsToString(info.documentation ?? [])
          const value =
            '```typescript\n' + signature + '\n```' + (docs ? `\n${docs}` : '')
          return {
            contents: { kind: 'markdown', value },
            range: spanToRange(text, info.textSpan.start, info.textSpan.length),
          }
        }

        case 'textDocument/documentSymbol': {
          const { project, file, text } = docContext(params)
          const tree = project.service.getNavigationTree(file)
          return navTreeToSymbols(text, tree.childItems)
        }

        case 'workspace/symbol': {
          const st = requireState()
          const p = params as { query?: string }
          const query = p.query ?? ''
          const seen = new Set<string>()
          const out: {
            name: string
            kind: number
            location: LspLocation
            containerName?: string
          }[] = []
          for (const project of st.allProjects()) {
            let items: TS.NavigateToItem[] = []
            try {
              items = project.service.getNavigateToItems(query, 128)
            } catch {
              continue
            }
            for (const item of items) {
              const file = st.normalize(item.fileName)
              const text = st.textOf(file)
              if (text === undefined) continue
              const key = `${file}:${item.textSpan.start}:${item.name}`
              if (seen.has(key)) continue
              seen.add(key)
              const entry: {
                name: string
                kind: number
                location: LspLocation
                containerName?: string
              } = {
                name: item.name,
                kind: symbolKindOf(item.kind),
                location: {
                  uri: toUri(file),
                  range: spanToRange(
                    text,
                    item.textSpan.start,
                    item.textSpan.length,
                  ),
                },
              }
              if (item.containerName) entry.containerName = item.containerName
              out.push(entry)
              if (out.length >= 256) return out
            }
          }
          return out
        }

        case 'textDocument/prepareCallHierarchy': {
          const { st, project, file, offset } = docContext(params)
          const prepared = project.service.prepareCallHierarchy(file, offset)
          if (!prepared) return null
          const items = Array.isArray(prepared) ? prepared : [prepared]
          return items
            .map(i => callItemOf(st, i))
            .filter((i): i is LspCallHierarchyItem => i !== undefined)
        }

        case 'callHierarchy/incomingCalls': {
          const st = requireState()
          const p = params as { item: LspCallHierarchyItem }
          const file = st.normalize(fromUri(p.item.uri))
          const text = st.textOf(file) ?? ''
          const project = st.projectFor(file)
          const offset = offsetAt(text, p.item.selectionRange.start)
          const calls = project.service.provideCallHierarchyIncomingCalls(
            file,
            offset,
          )
          const out: { from: LspCallHierarchyItem; fromRanges: LspRange[] }[] =
            []
          for (const call of calls) {
            const from = callItemOf(st, call.from)
            if (!from) continue
            const fromText = st.textOf(st.normalize(call.from.file)) ?? ''
            out.push({
              from,
              fromRanges: call.fromSpans.map(s =>
                spanToRange(fromText, s.start, s.length),
              ),
            })
          }
          return out
        }

        case 'callHierarchy/outgoingCalls': {
          const st = requireState()
          const p = params as { item: LspCallHierarchyItem }
          const file = st.normalize(fromUri(p.item.uri))
          const text = st.textOf(file) ?? ''
          const project = st.projectFor(file)
          const offset = offsetAt(text, p.item.selectionRange.start)
          const calls = project.service.provideCallHierarchyOutgoingCalls(
            file,
            offset,
          )
          const out: { to: LspCallHierarchyItem; fromRanges: LspRange[] }[] = []
          for (const call of calls) {
            const to = callItemOf(st, call.to)
            if (!to) continue
            out.push({
              to,
              // Outgoing fromSpans are ranges in the SOURCE (item's) file.
              fromRanges: call.fromSpans.map(s =>
                spanToRange(text, s.start, s.length),
              ),
            })
          }
          return out
        }

        case 'textDocument/prepareRename': {
          const { st, project, file, text, offset } = docContext(params)
          const info = project.service.getRenameInfo(file, offset, {})
          if (!info.canRename) return null
          void st
          return {
            range: spanToRange(
              text,
              info.triggerSpan.start,
              info.triggerSpan.length,
            ),
            placeholder: info.displayName,
          }
        }

        case 'textDocument/rename': {
          const { st, project, file, offset } = docContext(params)
          const p = params as { newName: string }
          const info = project.service.getRenameInfo(file, offset, {})
          if (!info.canRename) {
            throw Object.assign(
              new Error(info.localizedErrorMessage || 'cannot rename here'),
              { rpcCode: RPC_INTERNAL_ERROR },
            )
          }
          const locations = project.service.findRenameLocations(
            file,
            offset,
            false,
            false,
            { providePrefixAndSuffixTextForRename: false },
          )
          const changes: Record<string, LspTextEdit[]> = {}
          for (const loc of locations ?? []) {
            const locFile = st.normalize(loc.fileName)
            const locText = st.textOf(locFile)
            if (locText === undefined) continue
            const uri = toUri(locFile)
            const edits = (changes[uri] ??= [])
            edits.push({
              range: spanToRange(
                locText,
                loc.textSpan.start,
                loc.textSpan.length,
              ),
              newText:
                (loc.prefixText ?? '') + p.newName + (loc.suffixText ?? ''),
            })
          }
          return { changes }
        }

        case 'textDocument/codeAction': {
          const { st, project, file, text } = docContext(params)
          const p = params as {
            range: LspRange
            context?: { diagnostics?: LspDiagnostic[] }
          }
          const start = offsetAt(text, p.range.start)
          const end = offsetAt(text, p.range.end)
          // Error codes: from the request context when provided, else from
          // our own diagnostics overlapping the range.
          let codes = (p.context?.diagnostics ?? [])
            .map(d => (typeof d.code === 'number' ? d.code : Number(d.code)))
            .filter(c => Number.isFinite(c))
          if (codes.length === 0) {
            const own = [
              ...project.service.getSyntacticDiagnostics(file),
              ...project.service.getSemanticDiagnostics(file),
            ]
            codes = own
              .filter(d => {
                const ds = d.start ?? 0
                const de = ds + (d.length ?? 0)
                return ds <= end && de >= start
              })
              .map(d => d.code)
          }
          const uniqueCodes = [...new Set(codes)]
          if (uniqueCodes.length === 0) return []
          const fixes = project.service.getCodeFixesAtPosition(
            file,
            start,
            end,
            uniqueCodes,
            FORMAT_OPTIONS,
            {},
          )
          const actions: LspCodeAction[] = []
          for (const fix of fixes) {
            actions.push({
              title: fix.description,
              kind: 'quickfix',
              edit: fileTextChangesToWorkspaceEdit(st, fix.changes),
            })
          }
          return actions
        }

        case 'textDocument/diagnostic': {
          const { file } = docContext(params)
          return { kind: 'full', items: computeDiagnostics(file) }
        }

        default:
          throw Object.assign(new Error(`method not found: ${method}`), {
            rpcCode: RPC_METHOD_NOT_FOUND,
          })
      }
    }

    function handleNotification(method: string, params: unknown): void {
      switch (method) {
        case 'initialized':
          return
        case 'exit':
          finish(shutdownRequested ? 0 : 1)
          return
        case 'textDocument/didOpen': {
          const st = requireState()
          const p = params as {
            textDocument: { uri: string; text: string }
          }
          const file = st.normalize(fromUri(p.textDocument.uri))
          st.openDoc(file, p.textDocument.text)
          schedulePublish(file)
          return
        }
        case 'textDocument/didChange': {
          const st = requireState()
          const p = params as {
            textDocument: { uri: string }
            contentChanges: { text: string }[]
          }
          const file = st.normalize(fromUri(p.textDocument.uri))
          const last = p.contentChanges[p.contentChanges.length - 1]
          if (last) st.changeDoc(file, last.text)
          schedulePublish(file)
          return
        }
        case 'textDocument/didSave': {
          const st = requireState()
          const p = params as { textDocument: { uri: string } }
          const file = st.normalize(fromUri(p.textDocument.uri))
          // Disk is now the truth; drop the overlay so mtime versioning
          // reflects external edits again.
          st.closeDoc(file)
          schedulePublish(file)
          return
        }
        case 'textDocument/didClose': {
          const st = requireState()
          const p = params as { textDocument: { uri: string } }
          st.closeDoc(st.normalize(fromUri(p.textDocument.uri)))
          return
        }
        case 'workspace/didRenameFiles': {
          // The move happened: drop overlays keyed by the OLD paths so mtime
          // versioning picks up the disk truth (the new path enters via a
          // normal didOpen from the client).
          const st = requireState()
          const p = params as { files?: { oldUri: string }[] }
          for (const f of p.files ?? []) {
            st.closeDoc(st.normalize(fromUri(f.oldUri)))
          }
          return
        }
        default:
          // $/cancelRequest, $/setTrace, workspace/didChangeConfiguration, …
          return
      }
    }

    const readChunk = createFrameReader(
      msg => {
        if (msg.method !== undefined) {
          if (msg.id !== undefined && msg.id !== null) {
            // Request
            try {
              respond(msg.id, handleRequest(msg.method, msg.params))
            } catch (e) {
              const rpcCode =
                (e as { rpcCode?: number }).rpcCode ?? RPC_INTERNAL_ERROR
              respondError(
                msg.id,
                rpcCode,
                e instanceof Error ? e.message : String(e),
              )
            }
          } else {
            // Notification
            try {
              handleNotification(msg.method, msg.params)
            } catch (e) {
              log(`notification ${msg.method} failed: ${String(e)}`)
            }
          }
        }
        // Responses to server→client requests: none issued; ignore.
      },
      err => {
        log(`protocol error: ${err.message}`)
        write({
          jsonrpc: '2.0',
          id: null,
          error: { code: RPC_PARSE_ERROR, message: err.message },
        })
      },
    )

    input.on('data', (chunk: Buffer) => {
      try {
        readChunk(chunk)
      } catch (e) {
        log(`fatal read error: ${String(e)}`)
        finish(1)
      }
    })
    input.on('end', () => finish(0))
    input.on('close', () => finish(0))
    input.on('error', () => finish(1))
  })
}
