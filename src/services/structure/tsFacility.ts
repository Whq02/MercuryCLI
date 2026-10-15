
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as TS from 'typescript'
import { flagEnv } from '../../substrate/flagRegistry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.join(__filename, '../')

export type TsModule = typeof TS

export interface TsResolution {
  state: 'ok'
  modulePath: string
  source: 'override' | 'workspace' | 'vendored'
}

export interface TsResolutionFailure {
  state: 'unavailable'
  note: string
}

function resolveWorkspace(root: string): string | undefined {
  let dir = path.resolve(root)
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function hasCompilerApi(mod: unknown): mod is TsModule {
  const m = mod as Partial<TsModule> | null
  return (
    !!m &&
    typeof m.createSourceFile === 'function' &&
    typeof m.forEachChild === 'function' &&
    m.ScriptKind !== undefined &&
    m.SyntaxKind !== undefined
  )
}

function vendoredCandidates(): string[] {
  return [
    path.resolve(__dirname, 'vendor', 'typescript', 'typescript.js'),
    path.resolve(__dirname, '..', '..', '..', 'node_modules', 'typescript', 'lib', 'typescript.js'),
  ]
}

export function resolvePackagedTypescript(): { modulePath: string; version?: string } | null {
  for (const candidate of vendoredCandidates()) {
    if (!existsSync(candidate)) continue
    let version: string | undefined
    try {
      const vendorJson = path.join(path.dirname(candidate), 'vendor.json')
      const pkgJson = path.resolve(path.dirname(candidate), '..', 'package.json')
      const meta = existsSync(vendorJson) ? vendorJson : pkgJson
      const parsed = JSON.parse(readFileSync(meta, 'utf8')) as { version?: string }
      if (typeof parsed.version === 'string') version = parsed.version
    } catch {
    }
    return { modulePath: candidate, ...(version ? { version } : {}) }
  }
  return null
}

export function resolveStructureTypescript(root: string): TsResolution | TsResolutionFailure {
  const override = flagEnv('MERCURY_TYPESCRIPT_VENDOR_DIR')
  if (override && override !== '') {
    const candidate = path.join(override, 'typescript.js')
    if (existsSync(candidate) && tryLoad(candidate)) {
      return { state: 'ok', modulePath: candidate, source: 'override' }
    }
    return {
      state: 'unavailable',
      note: `MERCURY_TYPESCRIPT_VENDOR_DIR set but ${candidate} is missing or not a compiler — the pin names itself, no silent fallback`,
    }
  }
  const workspace = resolveWorkspace(root)
  if (workspace && tryLoad(workspace)) {
    return { state: 'ok', modulePath: workspace, source: 'workspace' }
  }
  for (const candidate of vendoredCandidates()) {
    if (existsSync(candidate) && tryLoad(candidate)) {
      return { state: 'ok', modulePath: candidate, source: 'vendored' }
    }
  }
  return {
    state: 'unavailable',
    note:
      'no typescript compiler facility: the workspace has no usable typescript package and no ' +
      'vendored copy sits beside the bundle (dist/vendor/typescript) — structural queries need one',
  }
}

const loaded = new Map<string, TsModule>()

function tryLoad(modulePath: string): TsModule | null {
  const cached = loaded.get(modulePath)
  if (cached) return cached
  try {
    const req = createRequire(modulePath)
    const target: string = modulePath
    const mod = req(target)
    if (!hasCompilerApi(mod)) return null
    loaded.set(modulePath, mod)
    return mod
  } catch {
    return null
  }
}

export function loadTs(modulePath: string): TsModule {
  const mod = tryLoad(modulePath)
  if (!mod) {
    throw new Error(`'${modulePath}' is not a usable typescript compiler module`)
  }
  return mod
}

const EXT_TO_KIND: Record<string, string> = {
  '.js': 'JS',
  '.mjs': 'JS',
  '.cjs': 'JS',
  '.jsx': 'JSX',
  '.ts': 'TS',
  '.mts': 'TS',
  '.cts': 'TS',
  '.tsx': 'TSX',
}

export function scriptKindFor(ts: TsModule, fileName: string): TS.ScriptKind | undefined {
  const ext = path.extname(fileName).toLowerCase()
  const key = EXT_TO_KIND[ext]
  if (!key) return undefined
  return ts.ScriptKind[key as keyof typeof TS.ScriptKind]
}

export function isSupportedSourceFile(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() in EXT_TO_KIND
}

export interface ParsedSource {
  sourceFile: TS.SourceFile
  parseErrors: string[]
}

export function parseSource(ts: TsModule, fileName: string, text: string): ParsedSource {
  const kind = scriptKindFor(ts, fileName)
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
     true,
    kind,
  )
  const rawDiags = (sourceFile as unknown as { parseDiagnostics?: TS.Diagnostic[] })
    .parseDiagnostics
  const parseErrors = (rawDiags ?? [])
    .filter(d => d.category === ts.DiagnosticCategory.Error)
    .slice(0, 5)
    .map(d => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ')
      const pos =
        d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start) : undefined
      return pos ? `${pos.line + 1}:${pos.character + 1} ${message}` : message
    })
  return { sourceFile, parseErrors }
}
