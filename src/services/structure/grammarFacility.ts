
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.join(__filename, '../')


export interface TSNode {
  type: string
  text: string
  isNamed: boolean
  isMissing: boolean
  hasError: boolean
  startIndex: number
  endIndex: number
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  childCount: number
  namedChildCount: number
  children: TSNode[]
  namedChildren: TSNode[]
  parent: TSNode | null
}

export interface TSTree {
  rootNode: TSNode
  delete(): void
}

interface TSParser {
  setLanguage(lang: unknown): void
  parse(text: string): TSTree | null
  delete(): void
}

interface TreeSitterModule {
  Parser: {
    new (): TSParser
    init(opts: { locateFile: (file: string) => string }): Promise<void>
  }
  Language: { load(p: string): Promise<unknown> }
}


import { GRAMMAR_REGISTRY, type GrammarRegistryEntry } from './grammarRegistry.js'

export type PolyglotLanguage = GrammarRegistryEntry

export const POLYGLOT_LANGUAGES: PolyglotLanguage[] = GRAMMAR_REGISTRY

const EXT_TO_LANG = new Map<string, PolyglotLanguage>()
const BASENAME_TO_LANG = new Map<string, PolyglotLanguage>()
for (const lang of POLYGLOT_LANGUAGES) {
  for (const ext of lang.extensions) EXT_TO_LANG.set(ext, lang)
  for (const base of lang.basenames ?? []) BASENAME_TO_LANG.set(base.toLowerCase(), lang)
}

export function languageForFile(fileName: string): PolyglotLanguage | null {
  const byBase = BASENAME_TO_LANG.get(path.basename(fileName).toLowerCase())
  if (byBase) return byBase
  return EXT_TO_LANG.get(path.extname(fileName).toLowerCase()) ?? null
}

export function languageByName(name: string): PolyglotLanguage | null {
  return POLYGLOT_LANGUAGES.find(l => l.name === name) ?? null
}


export interface EngineResolution {
  state: 'ok'
  dir: string
  source: 'override' | 'vendored' | 'workspace'
}

export interface EngineUnavailable {
  state: 'unavailable'
  note: string
}

function isEngineDir(dir: string): boolean {
  return existsSync(path.join(dir, 'tree-sitter.js')) && existsSync(path.join(dir, 'tree-sitter.wasm'))
}

export function resolveGrammarEngineDir(): EngineResolution | EngineUnavailable {
  const override = flagEnv('MERCURY_TREESITTER_VENDOR_DIR')
  if (override && override !== '') {
    if (isEngineDir(override)) return { state: 'ok', dir: override, source: 'override' }
    return {
      state: 'unavailable',
      note: `MERCURY_TREESITTER_VENDOR_DIR set but ${override} holds no tree-sitter.js + tree-sitter.wasm — the pin names itself, no silent fallback`,
    }
  }
  const vendored = path.resolve(__dirname, 'vendor', 'treesitter')
  if (isEngineDir(vendored)) return { state: 'ok', dir: vendored, source: 'vendored' }
  let dir = path.resolve(__dirname)
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
    if (isEngineDir(candidate)) return { state: 'ok', dir: candidate, source: 'workspace' }
    if (existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return {
    state: 'unavailable',
    note:
      'no tree-sitter grammar engine: neither dist/vendor/treesitter beside the bundle nor the ' +
      'workspace @vscode/tree-sitter-wasm package — polyglot structural queries need one ' +
      '(the JS/TS select-vocabulary path is unaffected)',
  }
}


interface LoadedEngine {
  state: 'ok'
  dir: string
  source: EngineResolution['source']
  parser: TSParser
  loadLanguage(lang: PolyglotLanguage): Promise<unknown | { state: 'unavailable'; note: string }>
  resetParser(): void
  poisoned?: boolean
}

function bustLoaderCache(dir: string): void {
  try {
    const target = path.join(dir, 'tree-sitter.js')
    const req = createRequire(target)
    const resolved = req.resolve(target)
    if (req.cache && resolved in req.cache) delete req.cache[resolved]
  } catch {
  }
}

async function withLibraryChannelsRouted<T>(fn: () => Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const route = (...args: unknown[]): void => {
    logForDebugging(`tree-sitter loader: ${args.map(String).join(' ').slice(0, 4000)}`)
  }
  console.log = route as never
  console.warn = route as never
  console.error = route as never
  try {
    return await fn()
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}

let enginePromise: Promise<LoadedEngine | EngineUnavailable> | null = null

export function loadGrammarEngine(): Promise<LoadedEngine | EngineUnavailable> {
  if (enginePromise) return enginePromise
  enginePromise = (async (): Promise<LoadedEngine | EngineUnavailable> => {
    const resolution = resolveGrammarEngineDir()
    if (resolution.state === 'unavailable') return resolution
    const dir = resolution.dir
    let mod: TreeSitterModule
    try {
      const req = createRequire(path.join(dir, 'tree-sitter.js'))
      const target: string = path.join(dir, 'tree-sitter.js')
      const raw = req(target) as TreeSitterModule & { default?: TreeSitterModule }
      mod = raw?.Parser ? raw : (raw?.default ?? raw)
    } catch (err) {
      return { state: 'unavailable', note: `tree-sitter loader failed to load from ${dir}: ${(err as Error).message}` }
    }
    if (typeof mod?.Parser?.init !== 'function' || typeof mod?.Language?.load !== 'function') {
      return { state: 'unavailable', note: `${dir}/tree-sitter.js is not a web-tree-sitter module (no Parser.init/Language.load)` }
    }
    try {
      await withLibraryChannelsRouted(() =>
        mod.Parser.init({ locateFile: (file: string) => path.join(dir, file) }),
      )
    } catch (err) {
      return { state: 'unavailable', note: `tree-sitter runtime wasm failed to initialize: ${(err as Error).message}` }
    }
    let parser = new mod.Parser()
    const languageCache = new Map<string, unknown>()
    return {
      state: 'ok',
      dir,
      source: resolution.source,
      get parser() {
        return parser
      },
      resetParser() {
        try {
          parser.delete()
        } catch {
        }
        parser = new mod.Parser()
      },
      async loadLanguage(lang: PolyglotLanguage) {
        const cached = languageCache.get(lang.name)
        if (cached) return cached
        const wasmPath = path.join(dir, lang.wasm)
        if (!existsSync(wasmPath)) {
          return { state: 'unavailable' as const, note: `grammar '${lang.name}' missing (${lang.wasm} not in ${dir})` }
        }
        if (lang.fragile) {
          const verdict = probeFragileGrammarOnce(lang.name, dir, wasmPath, lang.fragile.reason)
          if (verdict !== null) return verdict
        }
        try {
          const loaded = await withLibraryChannelsRouted(() => mod.Language.load(wasmPath))
          const declared = (loaded as { name?: unknown } | null)?.name
          if (typeof declared === 'string' && declared.length > 0) {
            const fold = (n: string): string => n.toLowerCase().replace(/[-_]/g, '')
            if (fold(declared) !== fold(lang.name)) {
              return {
                state: 'unavailable' as const,
                note: `grammar '${lang.name}' rejected: the wasm at ${lang.wasm} declares itself '${declared}' — wrong grammar at the expected filename`,
              }
            }
          } else {
            logForDebugging(`grammar '${lang.name}': wasm declares no name — identity check skipped (pre-ABI-15 grammar)`)
          }
          languageCache.set(lang.name, loaded)
          return loaded
        } catch (err) {
          return { state: 'unavailable' as const, note: `grammar '${lang.name}' failed to load: ${(err as Error).message}` }
        }
      },
    }
  })()
  return enginePromise
}


const fragileProbeVerdicts = new Map<string, { state: 'unavailable'; note: string } | null>()

const FRAGILE_PROBE_SOURCE = [
  "const path = require('node:path');",
  'const dir = process.argv[1];',
  'const wasm = process.argv[2];',
  "const raw = require(path.join(dir, 'tree-sitter.js'));",
  'const mod = raw && raw.Parser ? raw : (raw && raw.default) || raw;',
  '(async () => {',
  '  await mod.Parser.init({ locateFile: f => path.join(dir, f) });',
  '  const parser = new mod.Parser();',
  '  parser.setLanguage(await mod.Language.load(wasm));',
  "  const tree = parser.parse('print(1)');",
  '  if (!tree || !tree.rootNode) process.exit(8);',
  '  process.exit(0);',
  '})().catch(() => process.exit(9));',
].join('\n')

function probeFragileGrammarOnce(
  name: string,
  dir: string,
  wasmPath: string,
  reason: string,
): { state: 'unavailable'; note: string } | null {
  const remembered = fragileProbeVerdicts.get(name)
  if (remembered !== undefined) return remembered
  let verdict: { state: 'unavailable'; note: string } | null
  try {
    const probe = spawnSync(process.execPath, ['-e', FRAGILE_PROBE_SOURCE, dir, wasmPath], {
      env: process.env,
      timeout: 30_000,
      stdio: 'ignore',
      windowsHide: true,
    })
    const died = probe.status !== 0 || probe.signal !== null || probe.error !== undefined
    verdict = died
      ? {
          state: 'unavailable' as const,
          note:
            `grammar '${name}' quarantined: ${reason} — the disposable probe child died ` +
            `(exit ${probe.status ?? 'null'}${probe.signal ? `, signal ${probe.signal}` : ''}); ` +
            `the host is protected and every other grammar is unaffected`,
        }
      : null
  } catch (err) {
    verdict = {
      state: 'unavailable' as const,
      note: `grammar '${name}' quarantined: ${reason} — the probe could not run (${(err as Error).message})`,
    }
  }
  fragileProbeVerdicts.set(name, verdict)
  return verdict
}

export function _resetFragileProbeForTesting(): void {
  fragileProbeVerdicts.clear()
}

export function _resetGrammarEngineForTesting(): void {
  enginePromise = null
}


export interface PolyglotParse {
  tree: TSTree
  parseErrors: string[]
}

function collectParseErrors(root: TSNode, cap = 3): string[] {
  const errors: string[] = []
  const stack: TSNode[] = [root]
  let visited = 0
  while (stack.length > 0 && errors.length < cap && visited < 50_000) {
    const node = stack.pop()!
    visited++
    if (node.type === 'ERROR' || node.isMissing) {
      errors.push(
        `${node.startPosition.row + 1}:${node.startPosition.column + 1} ${node.isMissing ? `missing ${node.type}` : 'syntax error'}`,
      )
      continue
    }
    if (!node.hasError) continue
    for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.children[i]!)
  }
  return errors
}

export async function parsePolyglot(
  engine: LoadedEngine,
  lang: PolyglotLanguage,
  text: string,
): Promise<PolyglotParse | { state: 'unavailable'; note: string }> {
  if (engine.poisoned) {
    const fresh = await loadGrammarEngine()
    if (fresh.state === 'unavailable') return fresh
    engine = fresh
  }
  const language = await engine.loadLanguage(lang)
  if (typeof language === 'object' && language !== null && (language as { state?: string }).state === 'unavailable') {
    return language as { state: 'unavailable'; note: string }
  }
  let tree: TSTree | null
  try {
    engine.parser.setLanguage(language)
    tree = engine.parser.parse(text)
  } catch (err) {
    engine.poisoned = true
    engine.resetParser()
    enginePromise = null
    bustLoaderCache(engine.dir)
    return {
      state: 'unavailable',
      note: `the ${lang.name} grammar failed at parse time (runtime/ABI mismatch): ${(err as Error).message}`,
    }
  }
  if (!tree) return { state: 'unavailable', note: `the ${lang.name} parser returned no tree` }
  let parseErrors: string[] = []
  if (tree.rootNode.hasError) {
    parseErrors = collectParseErrors(tree.rootNode)
    if (parseErrors.length === 0) parseErrors = ['syntax error (recovery token; exact location unavailable)']
  }
  return { tree, parseErrors }
}
