
export interface GrammarRegistryEntry {
  name: string
  wasm: string
  extensions: string[]
  basenames?: string[]
  source?: 'vscode-pack' | 'grammar-pack'
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
  { name: 'powershell', wasm: 'tree-sitter-powershell.wasm', extensions: ['.ps1', '.psm1', '.psd1'] },
  { name: 'ini', wasm: 'tree-sitter-ini.wasm', extensions: ['.ini'] },
  { name: 'regex', wasm: 'tree-sitter-regex.wasm', extensions: ['.regex'] },
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

export const GRAMMAR_ENGINE_RUNTIME_FILES = ['tree-sitter.js', 'tree-sitter.wasm'] as const
