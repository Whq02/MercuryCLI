import { existsSync } from 'node:fs'
import { languageByName, POLYGLOT_LANGUAGES, resolveGrammarEngineDir, type PolyglotLanguage } from '../../../../platform/grammars/grammarFacility.js'
import * as path from 'node:path'

export const AST_BOUNDS = {
  defaultLimit: 50,
  maxLimit: 200,
  matchCap: 2000,
  maxFileBytes: 2_000_000,
  maxFilesParsed: 500,
  editMaxFiles: 100,
  editMaxMatches: 500,
  diffLinesPerFile: 160,
} as const


const availabilityByEngineDir = new Map<string, Set<string>>()

export function availableAstLanguages(): PolyglotLanguage[] {
  const engine = resolveGrammarEngineDir()
  if (engine.state !== 'ok') return []
  let names = availabilityByEngineDir.get(engine.dir)
  if (!names) {
    names = new Set(POLYGLOT_LANGUAGES.filter(l => existsSync(path.join(engine.dir, l.wasm))).map(l => l.name))
    availabilityByEngineDir.set(engine.dir, names)
  }
  const carried = names
  return POLYGLOT_LANGUAGES.filter(l => carried.has(l.name))
}

export function astLanguageNames(): string[] {
  return availableAstLanguages().map(l => l.name)
}

export const GRAMMAR_PACK_REMEDY =
  'the grammar-pack extension is not vendored in this build — the operator prepares it with `bun run scripts/vendor/fetch-grammars.ts` and rebuilds (release archives carry it)'

export function isCarried(lang: PolyglotLanguage): boolean {
  return availableAstLanguages().some(l => l.name === lang.name)
}

export function uncarriedRefusal(lang: PolyglotLanguage, what: string): string {
  return `${what} routes to ${lang.name}, but this build does not carry the ${lang.name} grammar: ${GRAMMAR_PACK_REMEDY}. Languages this build carries: ${astLanguageNames().join(', ')}.`
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  cs: 'c-sharp',
  csharp: 'c-sharp',
  'c#': 'c-sharp',
  'c++': 'cpp',
  cxx: 'cpp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  rb: 'ruby',
  kt: 'kotlin',
  ps1: 'powershell',
  pwsh: 'powershell',
  htm: 'html',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  docker: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'make',
  gnumake: 'make',
  mk: 'make',
  mak: 'make',
  xsl: 'xml',
  xslt: 'xml',
  svg: 'xml',
  plist: 'xml',
  tf: 'hcl',
  tfvars: 'hcl',
  terraform: 'hcl',
  gql: 'graphql',
  proto: 'protobuf',
  sc: 'scala',
  sbt: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  hs: 'haskell',
  ml: 'ocaml',
  jl: 'julia',
  star: 'starlark',
  bzl: 'starlark',
  bazel: 'starlark',
  skylark: 'starlark',
  clj: 'clojure',
  cljc: 'clojure',
  cljs: 'clojure',
  clojurescript: 'clojure',
  edn: 'clojure',
  erl: 'erlang',
  hrl: 'erlang',
  'obj-c': 'objc',
  'objective-c': 'objc',
  m: 'objc',
  mm: 'objc',
  f90: 'fortran',
  f95: 'fortran',
  f03: 'fortran',
  f08: 'fortran',
  sol: 'solidity',
  systemverilog: 'verilog',
  sv: 'verilog',
  svh: 'verilog',
  vh: 'verilog',
  v: 'verilog',
  emacslisp: 'emacs-lisp',
  elisp: 'emacs-lisp',
  el: 'emacs-lisp',
  justfile: 'just',
  tla: 'tlaplus',
  'tla+': 'tlaplus',
  pluscal: 'tlaplus',
  pcal: 'tlaplus',
  patch: 'diff',
}

export function resolveAstLanguage(name: string): PolyglotLanguage | null {
  const lowered = name.trim().toLowerCase()
  return languageByName(lowered) ?? languageByName(LANGUAGE_ALIASES[lowered] ?? '')
}

export const PATTERN_GRAMMAR_LINES: readonly string[] = [
  'A pattern is ONE complete node of the target language, written as code: a call "$FN($$$ARGS)", a statement "if ($COND) { $$$BODY }", a declaration "function $NAME($$$ARGS) { $$$BODY }", an import "import { $$$NAMES } from \'$MODULE\'". Wrap a fragment that is not standalone in its container: "class $_ { $$$BODY }".',
  'Meta-variables: $NAME matches exactly one node and captures it; $$$NAME matches a sequence of zero or more sibling nodes (arguments, parameters, statements) and captures it; $_ matches one node without capturing; $$$ matches a sequence without capturing. Names are UPPERCASE letters, digits and underscores. A name used twice must match identical code ($A == $A finds x == x, never x == y). $$X and $$$name are literal text, not meta-variables.',
  'Formatting never matters (spacing, line breaks, comments); structure does: "foo($A)" finds every one-argument call to foo, "foo($$$ARGS)" every call to foo, and neither finds the word foo in a string or a comment.',
]

export const PATTERN_EXAMPLES: readonly string[] = [
  '$FN($$$ARGS)',
  'if ($COND) { $$$BODY }',
  'function $NAME($$$ARGS) { $$$BODY }',
]

export const LANGUAGE_PATTERN_EXAMPLES: Record<string, readonly string[]> = {
  python: ['$FN($$$ARGS)', 'def $NAME($$$ARGS): $$$BODY', 'import $MODULE'],
  go: ['$FN($$$ARGS)', 'if $COND { $$$BODY }', 'func $NAME($$$PARAMS) { $$$BODY }'],
  rust: ['$FN($$$ARGS)', 'if $COND { $$$BODY }', 'fn $NAME($$$PARAMS) { $$$BODY }'],
  bash: ['$CMD $$$ARGS', 'if $COND; then $$$BODY; fi', '$NAME() { $$$BODY; }'],
  'c-sharp': ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'public void $NAME($$$PARAMS) { $$$BODY }'],
  cpp: ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'void $NAME($$$PARAMS) { $$$BODY }'],
  css: ['$PROP: $VALUE;', '$SEL { $$$DECLS }', '@import $URL;'],
  java: ['$OBJ.$METHOD($$$ARGS)', 'if ($COND) { $$$BODY }', 'public void $NAME($$$PARAMS) { $$$BODY }'],
  php: ['$FN($$$ARGS)', 'return $X;', 'echo $X;'],
  ruby: ['$FN($$$ARGS)', '$OBJ.$METHOD($$$ARGS)', 'def $NAME($$$PARAMS) $$$BODY end'],
  powershell: ['$CMD $$$ARGS', 'if ($COND) { $$$BODY }', 'function $NAME { $$$BODY }'],
  ini: ['$KEY = $VALUE', '[$SECTION]'],
  regex: ['($$$BODY)', '$A|$B'],
  c: ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'void $NAME($$$PARAMS) { $$$BODY }'],
  html: ['<ul>$$$ITEMS</ul>', '<a href=$URL>$$$CHILDREN</a>'],
  json: ['[$$$ITEMS]', '{ $$$PAIRS }', '{"name": $VALUE}'],
  toml: ['$KEY = $VALUE', 'name = $VALUE'],
  kotlin: ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'val $NAME = $VALUE'],
  swift: ['$FN($$$ARGS)', 'if $COND { $$$BODY }', 'let $NAME = $VALUE'],
  vue: ['<ul>$$$ITEMS</ul>', '<template>$$$CHILDREN</template>'],
  yaml: ['$KEY: $VALUE', '- $ITEM'],
  markdown: ['# $TITLE', '## $TITLE'],
  sql: ['SELECT $$$COLUMNS FROM $TABLE', 'CREATE TABLE $NAME ($$$COLUMNS)', 'COALESCE($A, $B)'],
  dockerfile: ['FROM $IMAGE', 'WORKDIR $DIR'],
  lua: ['$FN($$$ARGS)', 'if $COND then $$$BODY end', 'function $NAME($$$PARAMS) $$$BODY end'],
  make: ['$NAME := $VALUE', 'include $FILE'],
  cmake: ['$COMMAND($$$ARGS)', 'set($NAME $VALUE)'],
  xml: ['<$TAG>$$$CHILDREN</$TAG>', '<$TAG $$$ATTRS/>'],
  hcl: ['$KEY = $VALUE', 'resource $TYPE $NAME { $$$BODY }'],
  graphql: ['type $NAME { $$$FIELDS }', '$FIELD: $TYPE'],
  protobuf: ['message $NAME { $$$FIELDS }', 'rpc $NAME($REQUEST) returns ($RESPONSE);'],
  dart: ['print($X)', 'if ($COND) { $$$BODY }', 'void $NAME($$$PARAMS)'],
  scala: ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'def $NAME($$$PARAMS): $TYPE = $BODY'],
  elixir: ['$FN($$$ARGS)', 'def $NAME($$$ARGS) do $$$BODY end'],
  zig: ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'fn $NAME($$$PARAMS) $RET { $$$BODY }'],
  haskell: ['$NAME $ARG = $BODY', 'map $F $XS'],
  ocaml: ['let $NAME $ARG = $BODY', 'List.map $F $XS'],
  svelte: ['<$TAG>$$$CHILDREN</$TAG>', '{#if $COND}$$$BODY{/if}'],
  astro: ['<$TAG>$$$CHILDREN</$TAG>', '<$TAG $$$ATTRS />'],
  nix: ['$NAME = $VALUE;', '{ $$$ATTRS }'],
  r: ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'function($$$ARGS) { $$$BODY }'],
  julia: ['$FN($$$ARGS)', 'if $COND $$$BODY end', 'function $NAME($$$ARGS) $$$BODY end'],
  starlark: ['$FN($$$ARGS)', '$NAME = $VALUE'],
  clojure: ['($FN $$$ARGS)', '(defn $NAME [$$$ARGS] $$$BODY)'],
  erlang: ['$MODULE:$FN($$$ARGS)', '$NAME($$$ARGS) -> $$$BODY.'],
  objc: ['[$OBJECT $SELECTOR]', 'if ($COND) { $$$BODY }', '- (void)$NAME { $$$BODY }'],
  fortran: ['call $NAME($$$ARGS)', '$TARGET = $VALUE'],
  solidity: ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', 'function $NAME($$$PARAMS) public { $$$BODY }'],
  verilog: ['assign $TARGET = $VALUE;', 'always @(posedge $CLOCK) begin $$$BODY end'],
  'emacs-lisp': ['($FN $$$ARGS)', '(defun $NAME ($$$ARGS) $$$BODY)'],
  just: ['alias $NAME := $TARGET', '$NAME := $VALUE'],
  odin: ['$FN($$$ARGS)', 'if $COND { $$$BODY }', '$NAME :: proc($$$PARAMS) { $$$BODY }'],
  tlaplus: ['$NAME == $BODY', '$FN($$$ARGS)'],
  diff: ['-int old(void);', '+int renamed(void);'],
}
