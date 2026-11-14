
export interface GrammarRegistryEntry {
  name: string
  wasm: string
  extensions: string[]
  basenames?: string[]
  basenamePrefixes?: string[]
  source?: 'vscode-pack' | 'grammar-pack'
  fragile?: { reason: string }
  declares?: string
  baseline?: boolean
  finalNewline?: boolean
  patternOnly?: boolean
}

const AUDITIONED = { reason: 'the first use of this grammar in a process is auditioned in a disposable child' }

function patternGrammar(name: string, extensions: string[], more: Partial<GrammarRegistryEntry> = {}): GrammarRegistryEntry {
  return { name, wasm: `tree-sitter-${name}.wasm`, extensions, source: 'grammar-pack', patternOnly: true, fragile: AUDITIONED, ...more }
}

export const GRAMMAR_REGISTRY: GrammarRegistryEntry[] = [
  { name: 'python', wasm: 'tree-sitter-python.wasm', extensions: ['.py', '.pyi'] },
  { name: 'go', wasm: 'tree-sitter-go.wasm', extensions: ['.go'] },
  { name: 'rust', wasm: 'tree-sitter-rust.wasm', extensions: ['.rs'] },
  { name: 'javascript', wasm: 'tree-sitter-javascript.wasm', extensions: ['.js', '.mjs', '.cjs', '.jsx'] },
  { name: 'typescript', wasm: 'tree-sitter-typescript.wasm', extensions: ['.ts', '.mts', '.cts'] },
  { name: 'tsx', wasm: 'tree-sitter-tsx.wasm', extensions: ['.tsx'] },
  { name: 'bash', wasm: 'tree-sitter-bash.wasm', extensions: ['.sh', '.bash'], baseline: true },
  { name: 'c-sharp', wasm: 'tree-sitter-c-sharp.wasm', extensions: ['.cs'] },
  { name: 'cpp', wasm: 'tree-sitter-cpp.wasm', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'] },
  { name: 'css', wasm: 'tree-sitter-css.wasm', extensions: ['.css'] },
  { name: 'java', wasm: 'tree-sitter-java.wasm', extensions: ['.java'] },
  { name: 'php', wasm: 'tree-sitter-php.wasm', extensions: ['.php'] },
  { name: 'ruby', wasm: 'tree-sitter-ruby.wasm', extensions: ['.rb'] },
  { name: 'powershell', wasm: 'tree-sitter-powershell.wasm', extensions: ['.ps1', '.psm1', '.psd1'], baseline: true },
  { name: 'ini', wasm: 'tree-sitter-ini.wasm', extensions: ['.ini'] },
  { name: 'regex', wasm: 'tree-sitter-regex.wasm', extensions: ['.regex'] },
  { name: 'c', wasm: 'tree-sitter-c.wasm', extensions: ['.c', '.h'], source: 'grammar-pack' },
  { name: 'html', wasm: 'tree-sitter-html.wasm', extensions: ['.html', '.htm'], source: 'grammar-pack' },
  { name: 'json', wasm: 'tree-sitter-json.wasm', extensions: ['.json'], source: 'grammar-pack' },
  { name: 'toml', wasm: 'tree-sitter-toml.wasm', extensions: ['.toml'], source: 'grammar-pack' },
  { name: 'kotlin', wasm: 'tree-sitter-kotlin.wasm', extensions: ['.kt', '.kts'], source: 'grammar-pack', baseline: true },
  {
    name: 'swift',
    wasm: 'tree-sitter-swift.wasm',
    extensions: ['.swift'],
    source: 'grammar-pack',
    baseline: true,
    fragile: {
      reason:
        'a tree-sitter-swift build once fatally OOMed the V8 wasm compiler (turboshaft Zone OOM after a successful parse; the tree-sitter-wasms 0.1.13 pack build, cured by the pinned upstream 0.7.3 release wasm) — the audition stays armed for any regressed blob',
    },
  },
  { name: 'vue', wasm: 'tree-sitter-vue.wasm', extensions: ['.vue'], source: 'grammar-pack' },
  patternGrammar('yaml', ['.yaml', '.yml']),
  patternGrammar('markdown', ['.md', '.markdown', '.mdx'], { finalNewline: true, baseline: true }),
  patternGrammar('sql', ['.sql']),
  patternGrammar('dockerfile', ['.dockerfile'], {
    wasm: 'tree-sitter-containerfile.wasm',
    declares: 'containerfile',
    basenames: ['Dockerfile', 'Containerfile'],
    basenamePrefixes: ['Dockerfile.'],
  }),
  patternGrammar('lua', ['.lua']),
  patternGrammar('make', ['.mk', '.mak'], { basenames: ['Makefile', 'GNUmakefile'], finalNewline: true }),
  patternGrammar('cmake', ['.cmake'], { basenames: ['CMakeLists.txt'] }),
  patternGrammar('xml', ['.xml', '.xsl', '.xslt', '.svg', '.plist']),
  patternGrammar('hcl', ['.hcl', '.tf', '.tfvars']),
  patternGrammar('graphql', ['.graphql', '.gql']),
  patternGrammar('protobuf', ['.proto'], { declares: 'proto' }),
]

export const GRAMMAR_ENGINE_RUNTIME_FILES = ['tree-sitter.js', 'tree-sitter.wasm'] as const
