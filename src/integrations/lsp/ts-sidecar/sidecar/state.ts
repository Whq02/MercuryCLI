import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as TS from 'typescript'
import type { TsModule } from './lsp.js'
import { passedOver } from '../../../../platform/errors/passedOver.js'

export interface OpenDoc {
  text: string
  version: number
}

export interface Project {
  key: string
  service: TS.LanguageService
  extraRoots: Set<string>
  fileNames: Set<string>
  rootDir: string
}

const IMPLICIT_PROJECT_KEY_PREFIX = '<implicit>'

const IMPLICIT_PROJECT_SKIP = new Set(['node_modules', 'bower_components', 'jspm_packages', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'venv', '__pycache__'])

const IMPLICIT_PROJECT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

const IMPLICIT_PROJECT_MAX_FILES = 5_000

const IMPLICIT_PROJECT_MAX_ENTRIES = 50_000

const PROJECT_FILES_RELIST_MS = 30_000

function listImplicitProjectFiles(root: string): string[] {
  const files: string[] = []
  let entries = 0
  let truncated = false
  const walk = (dir: string): void => {
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      passedOver(error)
      return
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of names) {
      if (truncated) return
      if (++entries > IMPLICIT_PROJECT_MAX_ENTRIES) {
        truncated = true
        return
      }
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IMPLICIT_PROJECT_SKIP.has(entry.name)) walk(full)
      } else if (entry.isFile() && IMPLICIT_PROJECT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full)
        if (files.length >= IMPLICIT_PROJECT_MAX_FILES) truncated = true
      }
    }
  }
  walk(root)
  return files
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function isHomeOrAbove(dir: string): boolean {
  let home: string
  try {
    home = path.resolve(os.homedir())
  } catch {
    return path.dirname(dir) === dir
  }
  return isWithin(dir, home)
}

export class SidecarState {
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
    this.openDoc(file, text)
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
    } catch (error) {
      passedOver(error)
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
    } catch (error) {
      passedOver(error)
    }
    this.mtimeCache.set(file, { v, at: now })
    return v
  }

  private buildHost(
    rootDir: string,
    options: () => TS.CompilerOptions,
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
      getCompilationSettings: options,
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

  private parseConfig(configPath: string): TS.ParsedCommandLine | undefined {
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
    return ts.getParsedCommandLineOfConfigFile(configPath, {}, host)
  }

  private loadConfiguredProject(configPath: string): Project | undefined {
    const existing = this.projects.get(configPath)
    if (existing) return existing
    const parsed = this.parseConfig(configPath)
    if (!parsed) return undefined
    const rootDir = path.dirname(configPath)
    const fileNames = new Set(parsed.fileNames.map(f => this.normalize(f)))
    const extraRoots = new Set<string>()
    let options = parsed.options
    let listedAt = Date.now()
    const relist = (): void => {
      if (Date.now() - listedAt < PROJECT_FILES_RELIST_MS) return
      listedAt = Date.now()
      const again = this.parseConfig(configPath)
      if (!again) return
      options = again.options
      fileNames.clear()
      for (const f of again.fileNames) fileNames.add(this.normalize(f))
    }
    const project: Project = {
      key: configPath,
      rootDir,
      fileNames,
      extraRoots,
      service: this.ts.createLanguageService(
        this.buildHost(rootDir, () => options, () => {
          relist()
          return [...fileNames, ...extraRoots]
        }),
        this.ts.createDocumentRegistry(
          this.ts.sys.useCaseSensitiveFileNames,
          rootDir,
        ),
      ),
    }
    this.projects.set(configPath, project)
    return project
  }

  implicitRootFor(file: string): string {
    const dir = path.dirname(this.normalize(file))
    const inside = isWithin(this.workspaceRoot, dir)
    let cursor = dir
    for (let i = 0; i < 64; i++) {
      if (fs.existsSync(path.join(cursor, 'package.json'))) return cursor
      if (inside && cursor === this.workspaceRoot) return cursor
      const parent = path.dirname(cursor)
      if (parent === cursor || isHomeOrAbove(parent) || (!inside && isWithin(parent, this.workspaceRoot))) break
      cursor = parent
    }
    return inside ? this.workspaceRoot : dir
  }

  implicitProject(root: string): Project {
    const key = `${IMPLICIT_PROJECT_KEY_PREFIX}${root}`
    const existing = this.projects.get(key)
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
    const list = (): string[] => (isHomeOrAbove(root) ? [] : listImplicitProjectFiles(root).map(f => this.normalize(f)))
    const fileNames = new Set(list())
    const extraRoots = new Set<string>()
    let listedAt = Date.now()
    const relist = (): void => {
      if (Date.now() - listedAt < PROJECT_FILES_RELIST_MS) return
      listedAt = Date.now()
      fileNames.clear()
      for (const f of list()) fileNames.add(f)
    }
    const project: Project = {
      key,
      rootDir: root,
      fileNames,
      extraRoots,
      service: ts.createLanguageService(
        this.buildHost(root, () => options, () => {
          relist()
          return [...fileNames, ...extraRoots]
        }),
        ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, root),
      ),
    }
    this.projects.set(key, project)
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
        for (const refConfig of this.referencedConfigs(project)) {
          const refProject = this.loadConfiguredProject(refConfig)
          if (refProject?.fileNames.has(norm)) {
            project = refProject
            break
          }
        }
      }
    }
    if (!project) project = this.implicitProject(this.implicitRootFor(norm))
    if (!project.fileNames.has(norm)) project.extraRoots.add(norm)
    return project
  }

  private referencedConfigs(solution: Project): string[] {
    return (this.parseConfig(solution.key)?.projectReferences ?? []).map(ref => this.normalize(this.ts.resolveProjectReferencePath(ref)))
  }

  workspaceProjects(): Project[] {
    const configPath = this.nearestConfigFile(this.workspaceRoot)
    const configured = configPath ? this.loadConfiguredProject(this.normalize(configPath)) : undefined
    if (configured) {
      if (configured.fileNames.size > 0) return [configured]
      const referenced = this.referencedConfigs(configured).map(refConfig => this.loadConfiguredProject(refConfig)).filter((refProject): refProject is Project => refProject !== undefined)
      if (referenced.length > 0) return referenced
    }
    return [this.implicitProject(this.workspaceRoot)]
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
