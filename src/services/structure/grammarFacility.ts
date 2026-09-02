// ============================================================================
//  structure/grammarFacility — the Family-1 packaged grammar engine:
//  tree-sitter WASM (@vscode/tree-sitter-wasm) for POLYGLOT structural
//  queries and rewrites. The JS/TS select-vocabulary path stays on the
//  typescript compiler facility (tsFacility.ts) byte-identically — this
//  facility serves the PATTERN lane only (metavariable patterns, per-file
//  language inference, mixed-language scopes).
//
//  Resolution order (each step honest, the failure names itself):
//    1. MERCURY_TREESITTER_VENDOR_DIR — explicit override (proof seam);
//    2. the bundle-sibling dist/vendor/treesitter (the packaged artifact —
//       build.ts vendors runtime + grammar wasms there, ripgrep-class);
//    3. the repo's own node_modules/@vscode/tree-sitter-wasm/wasm (source
//       runs);
//    4. unavailable — named, never a silent substitute.
//
//  The require is VARIABLE-INDIRECTED so the bundler never inlines the
//  emscripten loader. WASM is platform-independent: one vendored asset set
//  serves every platform artifact.
//
//  Gate: MERCURY_STRUCTURE_POLYGLOT (default-on, registered) — checked at
//  the tool layer; this module is inert until called.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.join(__filename, '../')

// ── minimal structural types for the web-tree-sitter surface we drive ───────

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

// ── the language table (registry → routing maps) ────────────────────────────
// The table itself lives in grammarRegistry.ts — the ONE declarative source
// build.ts imports the same module, so the vendored payload and
// this routing can never drift. The PROVED minimum (brief law) is
// python · go · rust · javascript · typescript · tsx; every row rides the
// same code path with the same per-file parse honesty, and the census prover
// (scripts/language-sidecars/prove-grammar-census.ts) holds each row to the support bar.

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
  // Basenames first: Dockerfile/Makefile-class files carry no useful
  // extension, and a basename claim is more specific than an extension one.
  const byBase = BASENAME_TO_LANG.get(path.basename(fileName).toLowerCase())
  if (byBase) return byBase
  return EXT_TO_LANG.get(path.extname(fileName).toLowerCase()) ?? null
}

export function languageByName(name: string): PolyglotLanguage | null {
  return POLYGLOT_LANGUAGES.find(l => l.name === name) ?? null
}

// ── engine resolution ───────────────────────────────────────────────────────

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
  // Source runs: walk UP from this module toward the repo root's own
  // devDependency, STOPPING at the first project boundary (.git or
  // package.json) — a fixed-hop path would probe ABOVE the repo in a bundle
  // context, and the walk must never wander into a stranger's node_modules.
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

// ── engine loading (memoized; Parser.init is global one-shot) ───────────────

interface LoadedEngine {
  state: 'ok'
  dir: string
  source: EngineResolution['source']
  parser: TSParser
  loadLanguage(lang: PolyglotLanguage): Promise<unknown | { state: 'unavailable'; note: string }>
  /** Discard + rebuild the shared parser (a detonated parse can leave it
   *  poisoned for every LATER language — observed live in). */
  resetParser(): void
  /** Set when a parse detonated on this engine instance — every later
   *  parsePolyglot call transparently refetches a FRESH engine (the S8
   *  verify wave proved batch loops otherwise keep the poisoned heap). */
  poisoned?: boolean
}

/**
 * Evict the vendored loader from the CJS require cache (verify
 * wave: the loader memoizes its emscripten Module at MODULE scope, so a
 * re-require through the cache returns the SAME poisoned heap — zero fresh
 * WebAssembly instantiations, instrumented proof). Deleting the cache entry
 * is the only way a re-init actually re-instantiates.
 */
function bustLoaderCache(dir: string): void {
  try {
    const target = path.join(dir, 'tree-sitter.js')
    const req = createRequire(target)
    const resolved = req.resolve(target)
    if (req.cache && resolved in req.cache) delete req.cache[resolved]
  } catch {
    /* eviction is best-effort — a failed bust degrades to the old behavior */
  }
}

/**
 * FC-116: the vendored loader speaks through console.log — a wasm that is
 * not a grammar makes it dump the module's whole export listing (150+
 * lines) into the product's machine-readable stdout before rejecting, and
 * the emscripten runtime's own channels default there too. Route the
 * library channels to the debug log for exactly the awaited call: the
 * window is one serialized load, and product logging elsewhere is
 * untouched. The dump is kept (debug channel), never lost.
 */
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
      // Variable indirection — the bundler must never inline the loader.
      const target: string = path.join(dir, 'tree-sitter.js')
      const raw = req(target) as TreeSitterModule & { default?: TreeSitterModule }
      // ESM-interop honesty: a require(esm) namespace parks exports on
      // `default` (the vendored dir pins CommonJS, but an operator override
      // dir may not).
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
          // a poisoned parser may refuse even deletion — abandon it
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
        // The crash fence (FC-010, ruled): a fragile grammar is probed ONCE
        // per process in a DISPOSABLE child before any in-host load — the
        // known failure is a fatal V8 wasm-compiler OOM that kills the host
        // AFTER a successful parse, uncatchable in-process. A dead child
        // quarantines the grammar with an honest note; the other grammars
        // never probe and load exactly as before.
        if (lang.fragile) {
          const verdict = probeFragileGrammarOnce(lang.name, dir, wasmPath, lang.fragile.reason)
          if (verdict !== null) return verdict
        }
        try {
          const loaded = await withLibraryChannelsRouted(() => mod.Language.load(wasmPath))
          // FC-117: a grammar knows its own name — any wasm parked at the
          // expected filename used to be parsed and LABELLED as the
          // registry's language. When the wasm declares a name (the ABI-15
          // pack does) it must match the registry row, separator- and
          // case-folded (the c-sharp row's grammar declares c_sharp). The
          // ABI-14 grammars declare null — nothing to compare, recorded on
          // the debug channel, load proceeds as before.
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

// ── the fragile-grammar probe (FC-010) ──────────────────────────────────────

/** name → quarantine verdict (null = probe passed; absent = never probed).
 *  Once per process: the probe costs one child spawn (~1-2s). */
const fragileProbeVerdicts = new Map<string, { state: 'unavailable'; note: string } | null>()

/** The child's whole program: load the engine, load the ONE grammar, parse
 *  the known trigger. The engine OOM kills the child (exit 133/3); a clean
 *  exit 0 is the pass. Runs under THIS host's own runtime (process.execPath)
 *  so the verdict matches what an in-host load would suffer. */
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
    // spawnSync by absolute execPath (no PATH reliance), generous timeout —
    // a hung probe quarantines rather than hanging the host.
    const probe = spawnSync(process.execPath, ['-e', FRAGILE_PROBE_SOURCE, dir, wasmPath], {
      // child-env law: deliberate raw passthrough — the quarantine verdict must
      // match what THIS host would suffer (NODE_OPTIONS/V8 knobs included); the
      // probe source reads only argv, exports nothing, and spawns nothing.
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

/** TEST-ONLY: drop the fragile-probe memo (proof harnesses re-probing). */
export function _resetFragileProbeForTesting(): void {
  fragileProbeVerdicts.clear()
}

/** TEST-ONLY: drop the memoized engine (proof harnesses re-resolving dirs). */
export function _resetGrammarEngineForTesting(): void {
  enginePromise = null
}

// ── parsing ─────────────────────────────────────────────────────────────────

export interface PolyglotParse {
  tree: TSTree
  /** First error/missing locations (bounded) — parse-failure honesty. */
  parseErrors: string[]
}

/** Find the first bounded set of error/missing nodes (honest locations). */
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

/**
 * Parse `text` as `lang` on the loaded engine. The caller owns the returned
 * tree (`tree.delete()` when done — WASM memory is manual).
 */
export async function parsePolyglot(
  engine: LoadedEngine,
  lang: PolyglotLanguage,
  text: string,
): Promise<PolyglotParse | { state: 'unavailable'; note: string }> {
  // A poisoned engine (an earlier detonation) is never parsed on again —
  // refetch transparently so in-flight batch loops (query/transform/symbols
  // hold ONE engine reference across files) pick up the fresh heap too.
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
    // A grammar wasm whose imports the runtime cannot satisfy (foreign-ABI
    // external scanner) detonates INSIDE parse — answer unavailable by name,
    // never crash the tool (caught live by the yaml 0.20-era
    // C++-scanner build on the @vscode runtime). The detonation corrupts the
    // emscripten HEAP shared by every language (observed: valid lua
    // misparsing after yaml's crash; a parser rebuild alone did NOT clear
    // it) — mark THIS instance poisoned, drop the memoized promise, and
    // EVICT the loader from the require cache so the next load genuinely
    // re-instantiates (the loader memoizes its Module at module scope; a
    // cached re-require returns the same poisoned heap — S8 verify wave).
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
  // hasError is the AUTHORITATIVE flag: this runtime hides zero-width
  // MISSING recovery tokens from `.children`, so a walk can come back empty
  // even when the tree is broken (observed on Go top-level expressions) —
  // synthesize an honest row rather than reporting clean.
  let parseErrors: string[] = []
  if (tree.rootNode.hasError) {
    parseErrors = collectParseErrors(tree.rootNode)
    if (parseErrors.length === 0) parseErrors = ['syntax error (recovery token; exact location unavailable)']
  }
  return { tree, parseErrors }
}
