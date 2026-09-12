
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type * as TS from 'typescript'

type TsModule = typeof TS


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
  const target: string = tsPath
  return req(target) as TsModule
}


interface OpenDoc {
  text: string
  version: number
}

interface Project {
  key: string
  service: TS.LanguageService
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
    this.mtimeCache.delete(norm)
  }

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
      configPath = this.nearestConfigFile(dir)
      this.configForDir.set(dir, { value: configPath, at: Date.now() })
    }
    let project: Project | undefined
    if (configPath) {
      project = this.loadConfiguredProject(this.normalize(configPath))
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

  nearestConfigFile(startDir: string): string | undefined {
    let dir = startDir
    for (let i = 0; i < 64; i++) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = path.join(dir, name)
        if (this.ts.sys.fileExists(candidate)) return candidate
      }
      const parent = path.dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
    return undefined
  }

  allProjects(): Project[] {
    return [...this.projects.values()]
  }
}

interface TextChangeLike {
  start: number
  length: number
  newText: string
}

function applyTextChanges(text: string, changes: readonly TextChangeLike[]): string {
  const ordered = [...changes].sort((a, b) => b.start - a.start)
  let out = text
  for (const change of ordered) {
    out = out.slice(0, change.start) + change.newText + out.slice(change.start + change.length)
  }
  return out
}

function offsetMapper(changes: readonly TextChangeLike[]): (offset: number) => number {
  const ordered = [...changes].sort((a, b) => a.start - b.start)
  return offset => {
    let delta = 0
    for (const change of ordered) {
      if (change.start + change.length <= offset) {
        delta += change.newText.length - change.length
        continue
      }
      if (change.start < offset) return change.start + delta
      break
    }
    return offset + delta
  }
}

function isIdentifierName(ts: TsModule, name: string, target: TS.ScriptTarget): boolean {
  if (name.length === 0) return false
  let first = true
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    const ok = first ? ts.isIdentifierStart(code, target) : ts.isIdentifierPart(code, target)
    if (!ok) return false
    first = false
  }
  return true
}

function reservedWordProblem(ts: TsModule, name: string): string | undefined {
  const stringToToken = (ts as unknown as { stringToToken?: (s: string) => number | undefined }).stringToToken
  if (typeof stringToToken !== 'function') return undefined
  const token = stringToToken(name)
  if (token === undefined) return undefined
  if (token >= ts.SyntaxKind.FirstReservedWord && token <= ts.SyntaxKind.LastReservedWord) {
    return `'${name}' is a reserved word and cannot name a symbol`
  }
  return undefined
}

function tokenOccurrences(ts: TsModule, text: string, word: string, target: TS.ScriptTarget): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(word, from)
    if (at === -1) return out
    from = at + 1
    const before = at > 0 ? text.codePointAt(at - 1) ?? 0 : 0
    const after = at + word.length < text.length ? text.codePointAt(at + word.length) ?? 0 : 0
    if (at > 0 && ts.isIdentifierPart(before, target)) continue
    if (after !== 0 && ts.isIdentifierPart(after, target)) continue
    out.push(at)
  }
}

function positionLabel(root: string, file: string, text: string, offset: number): string {
  const pos = positionAt(text, offset)
  const rel = path.relative(root, file)
  const shown = rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel
  return `${shown}:${pos.line + 1}:${pos.character + 1}`
}

function errorKeysOf(ts: TsModule, diagnostics: readonly TS.Diagnostic[]): Map<string, TS.Diagnostic[]> {
  const out = new Map<string, TS.Diagnostic[]>()
  for (const d of diagnostics) {
    if (d.category !== ts.DiagnosticCategory.Error) continue
    const key = `${d.code}|${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
    const list = out.get(key) ?? []
    list.push(d)
    out.set(key, list)
  }
  return out
}

function newErrorsAgainst(
  ts: TsModule,
  before: Map<string, TS.Diagnostic[]>,
  after: readonly TS.Diagnostic[],
): TS.Diagnostic[] {
  const budget = new Map<string, number>()
  for (const [key, list] of before) budget.set(key, list.length)
  const fresh: TS.Diagnostic[] = []
  for (const [key, list] of errorKeysOf(ts, after)) {
    const allowed = budget.get(key) ?? 0
    for (const d of list.slice(allowed)) fresh.push(d)
  }
  return fresh
}

interface RenamePlan {
  file: string
  changes: TextChangeLike[]
}

function renameSafetyProblem(
  st: SidecarState,
  project: Project,
  displayName: string,
  newName: string,
  plans: RenamePlan[],
): string | undefined {
  const ts = st.ts
  const target = project.service.getProgram()?.getCompilerOptions().target ?? ts.ScriptTarget.ES2022
  const beforeTexts = new Map<string, string>()
  const mappers = new Map<string, (offset: number) => number>()
  const sensitive = new Set<string>()
  const existingUses = new Map<string, number[]>()
  for (const plan of plans) {
    const text = st.textOf(plan.file) ?? ''
    beforeTexts.set(plan.file, text)
    mappers.set(plan.file, offsetMapper(plan.changes))
    const renamedStarts = new Set(plan.changes.map(c => c.start))
    const occurrences = tokenOccurrences(ts, text, newName, target)
    const uses = occurrences.filter(at => !renamedStarts.has(at))
    if (occurrences.length > 0) sensitive.add(plan.file)
    if (uses.length > 0) existingUses.set(plan.file, uses)
  }
  const defKey = (file: string, offset: number): string => `${st.normalize(file)}:${offset}`
  const mappedDefKeys = (defs: readonly TS.DefinitionInfo[] | undefined): string[] => {
    const out: string[] = []
    for (const def of defs ?? []) {
      const file = st.normalize(def.fileName)
      const map = mappers.get(file)
      out.push(defKey(file, map ? map(def.textSpan.start) : def.textSpan.start))
    }
    return out
  }
  const renamedExpected = new Set<string>()
  const renamedProbe: Array<{ file: string; offset: number }> = []
  for (const plan of plans) {
    if (!sensitive.has(plan.file)) continue
    for (const change of plan.changes) {
      renamedProbe.push({ file: plan.file, offset: change.start })
      for (const key of mappedDefKeys(project.service.getDefinitionAtPosition(plan.file, change.start))) renamedExpected.add(key)
    }
  }
  const usesBefore = new Map<string, string[][]>()
  for (const [file, offsets] of existingUses) {
    usesBefore.set(file, offsets.map(offset => mappedDefKeys(project.service.getDefinitionAtPosition(file, offset))))
  }
  const syntacticBefore = new Map<string, Map<string, TS.Diagnostic[]>>()
  const semanticBefore = new Map<string, Map<string, TS.Diagnostic[]>>()
  for (const plan of plans) {
    syntacticBefore.set(plan.file, errorKeysOf(ts, project.service.getSyntacticDiagnostics(plan.file)))
    if (sensitive.has(plan.file)) semanticBefore.set(plan.file, errorKeysOf(ts, project.service.getSemanticDiagnostics(plan.file)))
  }
  const saved = new Map<string, OpenDoc | undefined>()
  for (const plan of plans) {
    saved.set(plan.file, st.openDocs.get(plan.file))
    st.changeDoc(plan.file, applyTextChanges(beforeTexts.get(plan.file) ?? '', plan.changes))
  }
  try {
    const describe = (file: string, d: TS.Diagnostic): string => {
      const text = st.textOf(file) ?? ''
      return `${positionLabel(st.workspaceRoot, file, text, d.start ?? 0)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
    }
    for (const plan of plans) {
      const fresh = newErrorsAgainst(ts, syntacticBefore.get(plan.file) ?? new Map(), project.service.getSyntacticDiagnostics(plan.file))
      if (fresh[0]) return `renaming '${displayName}' to '${newName}' would collide — ${describe(plan.file, fresh[0])}`
    }
    for (const plan of plans) {
      if (!sensitive.has(plan.file)) continue
      const fresh = newErrorsAgainst(ts, semanticBefore.get(plan.file) ?? new Map(), project.service.getSemanticDiagnostics(plan.file))
      if (fresh[0]) return `renaming '${displayName}' to '${newName}' would collide — ${describe(plan.file, fresh[0])}`
    }
    for (const probe of renamedProbe) {
      const map = mappers.get(probe.file)!
      const after = mappedDefKeys(project.service.getDefinitionAtPosition(probe.file, map(probe.offset)))
      if (after.length > 0 && !after.some(key => renamedExpected.has(key))) {
        const text = st.textOf(probe.file) ?? ''
        return `renaming '${displayName}' to '${newName}' would leave the occurrence at ${positionLabel(st.workspaceRoot, probe.file, text, map(probe.offset))} bound to another '${newName}'`
      }
    }
    for (const [file, offsets] of existingUses) {
      const map = mappers.get(file)!
      const before = usesBefore.get(file) ?? []
      for (let i = 0; i < offsets.length; i++) {
        const after = mappedDefKeys(project.service.getDefinitionAtPosition(file, map(offsets[i]!)))
        const expected = before[i] ?? []
        const same = after.length === expected.length && after.every(key => expected.includes(key))
        if (!same) {
          const text = st.textOf(file) ?? ''
          return `renaming '${displayName}' to '${newName}' would change what '${newName}' at ${positionLabel(st.workspaceRoot, file, text, map(offsets[i]!))} refers to`
        }
      }
    }
    return undefined
  } finally {
    for (const plan of plans) {
      const prior = saved.get(plan.file)
      if (prior) st.changeDoc(plan.file, prior.text)
      else st.closeDoc(plan.file)
    }
  }
}


function toUri(file: string): string {
  return pathToFileURL(file).href
}

function fromUri(uri: string): string {
  return uri.startsWith('file://') ? fileURLToPath(uri) : uri
}

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


export interface SidecarOptions {
  typescriptPath?: string
  log?: (line: string) => void
}

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

    function fileTextChangesToDocumentChanges(
      st: SidecarState,
      changesList: readonly TS.FileTextChanges[],
    ): { documentChanges: unknown[] } {
      const documentChanges: unknown[] = []
      for (const fileChanges of changesList) {
        const file = st.normalize(fileChanges.fileName)
        const text = fileChanges.isNewFile ? '' : st.textOf(file)
        if (text === undefined) continue
        const uri = toUri(file)
        if (fileChanges.isNewFile) {
          documentChanges.push({ kind: 'create', uri, options: { overwrite: false, ignoreIfExists: false } })
        }
        documentChanges.push({
          textDocument: { uri, version: null },
          edits: fileChanges.textChanges.map(tc => ({
            range: spanToRange(text, tc.span.start, tc.span.length),
            newText: tc.newText,
          })),
        })
      }
      return { documentChanges }
    }

    function declarationNamesOf(
      ts: TsModule,
      statement: TS.Statement,
      sourceFile: TS.SourceFile,
    ): Array<{ name: string; start: number; end: number }> {
      const spanOf = (node: TS.Node): { name: string; start: number; end: number } => ({
        name: node.getText(sourceFile),
        start: node.getStart(sourceFile),
        end: node.end,
      })
      if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.map(d => spanOf(d.name))
      }
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        statement.name
      ) {
        return [spanOf(statement.name)]
      }
      return []
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
              codeActionProvider: {
                codeActionKinds: [
                  'quickfix',
                  'refactor',
                  'source.organizeImports',
                  'source.removeUnusedImports',
                  'source.addMissingImports',
                  'source.removeUnused',
                ],
                resolveProvider: true,
              },
              diagnosticProvider: {
                interFileDependencies: true,
                workspaceDiagnostics: false,
              },
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
          const target =
            project.service.getProgram()?.getCompilerOptions().target ?? st.ts.ScriptTarget.ES2022
          if (p.newName === info.displayName) {
            throw Object.assign(new Error(`'${p.newName}' is already the symbol's name`), {
              rpcCode: RPC_INTERNAL_ERROR,
            })
          }
          if (isIdentifierName(st.ts, info.displayName, target)) {
            const reserved = reservedWordProblem(st.ts, p.newName)
            if (reserved) throw Object.assign(new Error(reserved), { rpcCode: RPC_INTERNAL_ERROR })
            if (!isIdentifierName(st.ts, p.newName, target)) {
              throw Object.assign(new Error(`'${p.newName}' is not a valid identifier`), {
                rpcCode: RPC_INTERNAL_ERROR,
              })
            }
          }
          const locations = project.service.findRenameLocations(
            file,
            offset,
            false,
            false,
            { providePrefixAndSuffixTextForRename: false },
          )
          const plans = new Map<string, RenamePlan>()
          for (const loc of locations ?? []) {
            const locFile = st.normalize(loc.fileName)
            if (st.textOf(locFile) === undefined) continue
            const plan = plans.get(locFile) ?? { file: locFile, changes: [] }
            plan.changes.push({
              start: loc.textSpan.start,
              length: loc.textSpan.length,
              newText: (loc.prefixText ?? '') + p.newName + (loc.suffixText ?? ''),
            })
            plans.set(locFile, plan)
          }
          const problem = renameSafetyProblem(st, project, info.displayName, p.newName, [...plans.values()])
          if (problem) throw Object.assign(new Error(problem), { rpcCode: RPC_INTERNAL_ERROR })
          const changes: Record<string, LspTextEdit[]> = {}
          for (const plan of plans.values()) {
            const locText = st.textOf(plan.file)
            if (locText === undefined) continue
            changes[toUri(plan.file)] = plan.changes.map(change => ({
              range: spanToRange(locText, change.start, change.length),
              newText: change.newText,
            }))
          }
          return { changes }
        }

        case 'textDocument/codeAction': {
          const { st, project, file, text } = docContext(params)
          const p = params as {
            range: LspRange
            context?: { diagnostics?: LspDiagnostic[]; only?: string[] }
          }
          const start = offsetAt(text, p.range.start)
          const end = offsetAt(text, p.range.end)
          const only = p.context?.only
          const wanted = (kind: string): boolean =>
            !only || only.some(o => kind === o || kind.startsWith(`${o}.`))
          const actions: LspCodeAction[] = []
          if (wanted('quickfix')) {
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
            if (uniqueCodes.length > 0) {
              const fixes = project.service.getCodeFixesAtPosition(
                file,
                start,
                end,
                uniqueCodes,
                FORMAT_OPTIONS,
                {},
              )
              for (const fix of fixes) {
                actions.push({
                  title: fix.description,
                  kind: 'quickfix',
                  edit: fileTextChangesToWorkspaceEdit(st, fix.changes),
                })
              }
            }
          }
          const wholeFile = { type: 'file' as const, fileName: file }
          const sourceActions: Array<{
            kind: string
            title: string
            compute: () => readonly TS.FileTextChanges[]
          }> = [
            {
              kind: 'source.organizeImports',
              title: 'Organize imports',
              compute: () =>
                project.service.organizeImports(
                  { ...wholeFile, mode: st.ts.OrganizeImportsMode.All },
                  FORMAT_OPTIONS,
                  {},
                ),
            },
            {
              kind: 'source.removeUnusedImports',
              title: 'Remove unused imports',
              compute: () =>
                project.service.organizeImports(
                  { ...wholeFile, mode: st.ts.OrganizeImportsMode.RemoveUnused },
                  FORMAT_OPTIONS,
                  {},
                ),
            },
            {
              kind: 'source.addMissingImports',
              title: 'Add all missing imports',
              compute: () =>
                project.service.getCombinedCodeFix(wholeFile, 'fixMissingImport', FORMAT_OPTIONS, {})
                  .changes,
            },
            {
              kind: 'source.removeUnused',
              title: 'Remove all unused declarations',
              compute: () =>
                project.service.getCombinedCodeFix(
                  wholeFile,
                  'unusedIdentifier_delete',
                  FORMAT_OPTIONS,
                  {},
                ).changes,
            },
          ]
          for (const source of sourceActions) {
            if (only === undefined || !wanted(source.kind)) continue
            let changes: readonly TS.FileTextChanges[]
            try {
              changes = source.compute()
            } catch {
              continue
            }
            const edit = fileTextChangesToWorkspaceEdit(st, changes)
            if (Object.values(edit.changes).every(list => list.length === 0)) continue
            actions.push({ title: source.title, kind: source.kind, edit })
          }
          if (wanted('refactor')) {
            const requestedKind = only?.find(o => o.startsWith('refactor.'))
            const refactors = project.service.getApplicableRefactors(
              file,
              start === end ? start : { pos: start, end },
              {},
              'invoked',
              requestedKind,
            )
            for (const refactor of refactors) {
              for (const action of refactor.actions) {
                if (action.notApplicableReason) continue
                const kind = action.kind ?? 'refactor'
                if (!wanted(kind)) continue
                actions.push({
                  title:
                    refactor.description === action.description
                      ? action.description
                      : `${refactor.description}: ${action.description}`,
                  kind,
                  data: {
                    uri: toUri(file),
                    refactorName: refactor.name,
                    actionName: action.name,
                    start,
                    end,
                  },
                })
              }
            }
          }
          return actions
        }

        case 'codeAction/resolve': {
          const st = requireState()
          const action = params as LspCodeAction
          const data = action.data as
            | { uri?: string; refactorName?: string; actionName?: string; start?: number; end?: number }
            | undefined
          if (!data?.uri || !data.refactorName || !data.actionName) return action
          const file = st.normalize(fromUri(data.uri))
          const project = st.projectFor(file)
          const start = data.start ?? 0
          const end = data.end ?? start
          const info = project.service.getEditsForRefactor(
            file,
            FORMAT_OPTIONS,
            start === end ? start : { pos: start, end },
            data.refactorName,
            data.actionName,
            {},
          )
          if (!info) {
            throw Object.assign(new Error(`the refactor '${action.title}' produced no edit`), {
              rpcCode: RPC_INTERNAL_ERROR,
            })
          }
          if (info.edits.some(e => e.isNewFile)) {
            throw Object.assign(
              new Error(
                `the refactor '${action.title}' would create a file — a symbol move that creates its target goes through moveSymbol`,
              ),
              { rpcCode: RPC_INTERNAL_ERROR },
            )
          }
          return { ...action, edit: fileTextChangesToWorkspaceEdit(st, info.edits) }
        }

        case 'mercury/moveToFile': {
          const { st, project, file, offset } = docContext(params)
          const p = params as { targetUri: string }
          const refuse = (message: string): never => {
            throw Object.assign(new Error(message), { rpcCode: RPC_INTERNAL_ERROR })
          }
          const targetFile = st.normalize(fromUri(p.targetUri))
          if (targetFile === file) return refuse('the target must differ from the source file')
          const sourceExt = path.extname(file).toLowerCase()
          const targetExt = path.extname(targetFile).toLowerCase()
          const families = [['.ts', '.tsx'], ['.js', '.jsx'], ['.mts'], ['.cts'], ['.mjs'], ['.cjs']]
          const family = families.find(f => f.includes(sourceExt))
          if (!family || !family.includes(targetExt)) {
            return refuse(
              `the target must be a ${(family ?? [sourceExt]).join(' or ')} file to match ${path.basename(file)} (got '${targetExt || 'no extension'}')`,
            )
          }
          let targetIsDirectory = false
          try {
            targetIsDirectory = fs.statSync(targetFile).isDirectory()
          } catch {
            targetIsDirectory = false
          }
          if (targetIsDirectory) return refuse(`the target ${targetFile} is a directory — name a file`)
          const sourceFile = project.service.getProgram()?.getSourceFile(file)
          if (!sourceFile) return refuse('the source file is not part of the project')
          const statement = sourceFile.statements.find(
            s => s.getStart(sourceFile) <= offset && offset < s.end,
          )
          if (!statement) {
            return refuse(
              'the position is not inside a top-level statement — point at the name of the declaration to move',
            )
          }
          const names = declarationNamesOf(st.ts, statement, sourceFile)
          if (names.length === 0) {
            return refuse(
              `the statement at the position (${st.ts.SyntaxKind[statement.kind]}) is not a declaration that can move — point at the name of a function, class, interface, type, enum or variable declared at the top level`,
            )
          }
          const headerEnd = Math.max(...names.map(n => n.end))
          if (offset > headerEnd) {
            const text = st.textOf(file) ?? ''
            return refuse(
              `the position is inside the body of '${names[0]!.name}' — point at its name (${positionLabel(st.workspaceRoot, file, text, names[0]!.start)}) to move the whole declaration`,
            )
          }
          const range = { pos: statement.getStart(sourceFile), end: statement.end }
          let info: TS.RefactorEditInfo | undefined
          try {
            info = project.service.getEditsForRefactor(
              file,
              FORMAT_OPTIONS,
              range,
              'Move to file',
              'Move to file',
              { allowTextChangesInNewFiles: true },
              { targetFile },
            )
          } catch (e) {
            return refuse(`the service refused the move: ${e instanceof Error ? e.message : String(e)}`)
          }
          if (!info) return refuse('the service offered no move for this declaration')
          if (info.notApplicableReason) return refuse(`the service refused the move: ${info.notApplicableReason}`)
          return fileTextChangesToDocumentChanges(st, info.edits)
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
          const st = requireState()
          const p = params as { files?: { oldUri: string }[] }
          for (const f of p.files ?? []) {
            st.closeDoc(st.normalize(fromUri(f.oldUri)))
          }
          return
        }
        default:
          return
      }
    }

    const readChunk = createFrameReader(
      msg => {
        if (msg.method !== undefined) {
          if (msg.id !== undefined && msg.id !== null) {
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
            try {
              handleNotification(msg.method, msg.params)
            } catch (e) {
              log(`notification ${msg.method} failed: ${String(e)}`)
            }
          }
        }
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
