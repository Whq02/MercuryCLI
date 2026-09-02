// ============================================================================
//  structure/grammarRegistry — the ONE declarative grammar source.
//
//  Every consumer derives from this table:
//    - grammarFacility (runtime routing: basenames + extensions → grammar);
//    - build.ts (which grammar wasms to vendor into dist/vendor/treesitter —
//      it IMPORTS this module; the old hand-kept copy is dead);
//    - dist/vendor/treesitter/vendor.json (written by build.ts from this
//      list — the third copy chains off it and cannot drift).
//  Drift ratchet: scripts/language-sidecars/prove-grammar-registry.ts (registry ⊆ source
//  package · dist contents two-way · vendor.json equality · routing laws).
//
// A row in this table is a ROUTING claim, not a support claim — the
//  bar (parse + error reporting + symbol projection where claimed + the safe
//  structural-query subset, proved against the real engine) is enforced by
//  scripts/language-sidecars/prove-grammar-census.ts; a grammar that fails the census bar
//  must never be presented as supported.
//
//  PURE DATA — zero imports; build.ts loads this file directly under bun.
// ============================================================================

export interface GrammarRegistryEntry {
  /** Canonical language name (display + explicit `lang` filter). */
  name: string
  /** Grammar wasm file inside the vendor dir. */
  wasm: string
  /** File extensions that route to this grammar (lowercased match). */
  extensions: string[]
  /**
   * Exact basenames that route to this grammar — Dockerfile/Makefile-class
   * files that carry no useful extension. Checked BEFORE extensions (exact
   * match first, then case-insensitive). Absent for most grammars.
   */
  basenames?: string[]
  /**
   * Which vendored source supplies the wasm at build time (absent =
   * 'vscode-pack'): 'vscode-pack' = the @vscode/tree-sitter-wasm repo
   * devDependency; 'grammar-pack' = the cherry-picked tree-sitter-wasms
   * cache (vendor/grammars.lock.json + scripts/vendor/fetch-grammars.ts).
   */
  source?: 'vscode-pack' | 'grammar-pack'
  /**
   * Probe-gated grammar (FC-010): loading or exercising this wasm can
   * fatally OOM the HOST engine (a V8 wasm-compiler Zone OOM after a
   * successful parse — the process dies with its work done). The facility
   * probes it once per process in a DISPOSABLE child; a child death
   * quarantines the grammar with this reason, and every other grammar
   * loads in-host exactly as before. The vendor-bump-vs-worker fork was
   * ruled and the bump taken (swift rides the upstream 0.7.3
   * release asset via the lock's sourceUrl); the probe stays as the
   * PERMANENT audition door — a future regressed blob quarantines itself
   * instead of killing the host.
   */
  fragile?: { reason: string }
}

export const GRAMMAR_REGISTRY: GrammarRegistryEntry[] = [
  { name: 'python', wasm: 'tree-sitter-python.wasm', extensions: ['.py', '.pyi'] },
  { name: 'go', wasm: 'tree-sitter-go.wasm', extensions: ['.go'] },
  { name: 'rust', wasm: 'tree-sitter-rust.wasm', extensions: ['.rs'] },
  { name: 'javascript', wasm: 'tree-sitter-javascript.wasm', extensions: ['.js', '.mjs', '.cjs', '.jsx'] },
  { name: 'typescript', wasm: 'tree-sitter-typescript.wasm', extensions: ['.ts', '.mts', '.cts'] },
  { name: 'tsx', wasm: 'tree-sitter-tsx.wasm', extensions: ['.tsx'] },
  { name: 'bash', wasm: 'tree-sitter-bash.wasm', extensions: ['.sh', '.bash'] },
  { name: 'c-sharp', wasm: 'tree-sitter-c-sharp.wasm', extensions: ['.cs'] },
  { name: 'cpp', wasm: 'tree-sitter-cpp.wasm', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'] },
  { name: 'css', wasm: 'tree-sitter-css.wasm', extensions: ['.css'] },
  { name: 'java', wasm: 'tree-sitter-java.wasm', extensions: ['.java'] },
  { name: 'php', wasm: 'tree-sitter-php.wasm', extensions: ['.php'] },
  { name: 'ruby', wasm: 'tree-sitter-ruby.wasm', extensions: ['.rb'] },
  // the three grammars @vscode/tree-sitter-wasm@0.3.1 ships that
  // never mapped — zero new package bytes, census-proved like the rest.
  { name: 'powershell', wasm: 'tree-sitter-powershell.wasm', extensions: ['.ps1', '.psm1', '.psd1'] },
  { name: 'ini', wasm: 'tree-sitter-ini.wasm', extensions: ['.ini'] },
  // The .regex corpus extension is chosen deliberately so the grammar is
  // reachable and provable end to end — an unreachable grammar would be a
  // vanity row the census could never exercise.
  { name: 'regex', wasm: 'tree-sitter-regex.wasm', extensions: ['.regex'] },
  // the grammar-pack extension — cherry-picked from the pinned
  // tree-sitter-wasms cache (vendor/grammars.lock.json carries per-file
  // sha256 + per-grammar upstream licence, all verified).
  // yaml + lua from this pack are REJECTED: their 0.20-era external
  // scanners are ABI-unfit on our runtime (yaml detonates at parse; lua
  // misparses valid code, e.g. `local x = 1`) — census evidence in the
  // record; re-sourcing is S2b work, never a vanity row here.
  { name: 'c', wasm: 'tree-sitter-c.wasm', extensions: ['.c', '.h'], source: 'grammar-pack' },
  { name: 'html', wasm: 'tree-sitter-html.wasm', extensions: ['.html', '.htm'], source: 'grammar-pack' },
  { name: 'json', wasm: 'tree-sitter-json.wasm', extensions: ['.json'], source: 'grammar-pack' },
  { name: 'toml', wasm: 'tree-sitter-toml.wasm', extensions: ['.toml'], source: 'grammar-pack' },
  { name: 'kotlin', wasm: 'tree-sitter-kotlin.wasm', extensions: ['.kt', '.kts'], source: 'grammar-pack' },
  {
    name: 'swift',
    wasm: 'tree-sitter-swift.wasm',
    extensions: ['.swift'],
    source: 'grammar-pack',
    fragile: {
      reason:
        'a tree-sitter-swift build once fatally OOMed the V8 wasm compiler (turboshaft Zone OOM after a successful parse; the tree-sitter-wasms 0.1.13 pack build, cured by the pinned upstream 0.7.3 release wasm) — the audition stays armed for any regressed blob',
    },
  },
  { name: 'vue', wasm: 'tree-sitter-vue.wasm', extensions: ['.vue'], source: 'grammar-pack' },
]

/** The engine runtime files every vendored engine dir must carry. */
export const GRAMMAR_ENGINE_RUNTIME_FILES = ['tree-sitter.js', 'tree-sitter.wasm'] as const
