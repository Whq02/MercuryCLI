#!/usr/bin/env bun
// ============================================================================
//  scripts/decisions/prove-command-analysis.ts — the pinned
//  CommandAnalysisProvider.
//
//  The command-language parsers are PINNED dependencies: never reimplemented,
//  reached only through the typed provider
//  (src/utils/permissions/decision/commandAnalysis.ts). This proof holds two
//  contracts:
//
//  (1) THE SEAM RATCHET — the permission-entry consumers import NO parser
//      module directly; the provider module is the single gateway. A new
//      direct import in one of the ratcheted files fails the gate.
//
//  (2) THE BEHAVIOR CORPUS — the HERMETIC provider operations (split,
//      redirection extraction, shell-quote tokenization, the parseCommandRaw
//      null-stub, security-parse fallbacks, the pure PS helpers) run over a
//      fixed command corpus against RECORDED goldens
//      (command-analysis-corpus.json). A parser swap must reproduce the
//      corpus or deliberately re-record with --record. The two EFFECTFUL ops
//      (getCommandSubcommandPrefix — API-backed; parsePowerShellCommand —
//      spawns pwsh) are bound and type-pinned but never driven here.
//
//  Run:            ~/.bun/bin/bun run scripts/decisions/prove-command-analysis.ts
//  Regen (review): … --record
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const GOLDEN = join(import.meta.dir, 'command-analysis-corpus.json')
const record = process.argv.includes('--record')

const { pinnedCommandAnalysis, PARSE_ABORTED } = await import(
  '../../src/utils/permissions/decision/commandAnalysis.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' CommandAnalysisProvider — seam ratchet + behavior corpus')
console.log('============================================================')

// ---------------------------------------------------------------------------
section('(1) the seam ratchet — no direct parser imports in the entry consumers')
{
  // The ratcheted closure: the decision package + the two checkPermissions
  // entry modules + the engine's sandbox-policy target. (The intra-tool
  // validation helpers — path/sed/mode/readOnly/gitSafety — are BashTool/
  // PowerShellTool internals; their direct imports ride the tool-call
  // transaction cut.)
  const RATCHETED = [
    'src/utils/permissions/permissions.ts',
    'src/utils/permissions/decision/engine.ts',
    'src/utils/permissions/decision/wrapper.ts',
    'src/utils/permissions/decision/rules.ts',
    'src/utils/permissions/decision/requestMessage.ts',
    'src/utils/permissions/decision/trace.ts',
    'src/utils/permissions/shellRuleMatching.ts',
    'src/tools/BashTool/bashPermissions.ts',
    'src/tools/PowerShellTool/powershellPermissions.ts',
    'src/tools/BashTool/shouldUseSandbox.ts',
    // Phase 5 widening: the intra-tool analysis passes route through the
    // gateway too (path/sed/mode/readOnly/gitSafety/security twins +
    // helpers). The directory law below makes NEW files join automatically.
    'src/tools/BashTool/modeValidation.ts',
    'src/tools/BashTool/pathValidation.ts',
    'src/tools/BashTool/sedValidation.ts',
    'src/tools/BashTool/bashCommandHelpers.ts',
    'src/tools/BashTool/readOnlyValidation.ts',
    'src/tools/BashTool/commandSemantics.ts',
    'src/tools/BashTool/sedEditParser.ts',
    'src/tools/BashTool/BashTool.tsx',
    'src/tools/BashTool/bashSecurity.ts',
    'src/tools/PowerShellTool/modeValidation.ts',
    'src/tools/PowerShellTool/pathValidation.ts',
    'src/tools/PowerShellTool/readOnlyValidation.ts',
    'src/tools/PowerShellTool/gitSafety.ts',
    'src/tools/PowerShellTool/powershellSecurity.ts',
  ]
  const PARSER_IMPORT = /from\s+'[^']*(?:utils\/bash|utils\/powershell)\/(?:ast|parser|commands|shellQuote|shellQuoting|bashParser|ParsedCommand|treeSitterAnalysis|heredoc|bashPipeCommand|prefix)\.js'/
  for (const rel of RATCHETED) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    check(`${rel} routes through the provider`, !PARSER_IMPORT.test(text))
  }
  // DIRECTORY LAW: no file under the two tool dirs may import a parser
  // module directly — new files join the ratchet automatically.
  const { readdirSync } = await import('node:fs')
  for (const dir of ['src/tools/BashTool', 'src/tools/PowerShellTool']) {
    for (const entry of readdirSync(join(ROOT, dir))) {
      if (!/\.tsx?$/.test(entry)) continue
      const text = readFileSync(join(ROOT, dir, entry), 'utf8')
      check(`${dir}/${entry} carries no direct parser import`, !PARSER_IMPORT.test(text))
    }
  }

  // The provider itself must keep binding both lanes.
  const provider = readFileSync(
    join(ROOT, 'src/utils/permissions/decision/commandAnalysis.ts'),
    'utf8',
  )
  check(
    'the provider module binds the bash + powershell lanes',
    provider.includes("from '../../bash/") && provider.includes("from '../../powershell/parser.js'"),
  )
}

// ---------------------------------------------------------------------------
section('(2) provider shape — every op present; effectful ops bound, not driven')
{
  const ops = [
    'parseCommandRaw',
    'parseForSecurityFromAst',
    'checkSemantics',
    'nodeTypeId',
    'splitCommand',
    'getCommandSubcommandPrefix',
    'extractOutputRedirections',
    'tryParseShellCommand',
    'parsePowerShellCommand',
    'deriveSecurityFlags',
    'getAllCommandNames',
    'getFileRedirections',
    'stripModulePrefix',
    'classifyCommandName',
  ]
  for (const op of ops) {
    check(`op ${op} bound`, typeof (pinnedCommandAnalysis as Record<string, unknown>)[op] === 'function')
  }
  check(
    'getCommandSubcommandPrefix keeps its memo cache (API-backed, /clear-cleared)',
    typeof (pinnedCommandAnalysis.getCommandSubcommandPrefix as unknown as { cache?: { clear?: unknown } }).cache?.clear === 'function',
  )
}

// ---------------------------------------------------------------------------
// The hermetic behavior corpus.
const SPLIT_CORPUS = [
  'ls -la',
  'git status && git diff',
  'echo "a && b"',
  'cd /tmp; rm -f x.txt',
  'cat foo | grep bar | wc -l',
  'echo one\necho two',
  'FOO=bar go test ./...',
  'find . -name "*.ts" -exec grep -l TODO {} \\;',
  "echo 'single && quoted; safe'",
  'git commit -m "feat: x" || echo failed',
]
const REDIRECT_CORPUS = [
  'echo hi > out.txt',
  'echo hi >> log.txt',
  'ls -la',
  'echo a > /tmp/x && echo b >> /tmp/y',
  'cat < in.txt',
  'echo dangerous > ~/.bashrc',
]
const TOKENIZE_CORPUS = [
  'git commit -m "hello world"',
  "echo 'a b' c",
  'VAR=1 cmd --flag=value',
  'echo $HOME',
  'grep -r "needle" .',
]
const PS_NAME_CORPUS = [
  'Get-ChildItem',
  'Microsoft.PowerShell.Management\\Get-ChildItem',
  'Remove-Item',
  'Invoke-Expression',
  'Select-String',
]

type Golden = {
  split: Record<string, string[]>
  redirections: Record<string, unknown>
  tokens: Record<string, unknown>
  parseStub: Record<string, unknown>
  security: Record<string, unknown>
  psStrip: Record<string, string>
  psClassify: Record<string, unknown>
}

async function computeCorpus(): Promise<Golden> {
  const p = pinnedCommandAnalysis
  const split: Golden['split'] = {}
  for (const cmd of SPLIT_CORPUS) split[cmd] = p.splitCommand(cmd)
  const redirections: Golden['redirections'] = {}
  for (const cmd of REDIRECT_CORPUS) redirections[cmd] = p.extractOutputRedirections(cmd)
  const tokens: Golden['tokens'] = {}
  for (const cmd of TOKENIZE_CORPUS) tokens[cmd] = p.tryParseShellCommand(cmd)
  const parseStub: Golden['parseStub'] = {
    'ls -la': await p.parseCommandRaw('ls -la'),
    '(subshell) && x': await p.parseCommandRaw('(true) && echo x'),
    'empty': await p.parseCommandRaw(''),
  }
  const security: Golden['security'] = {
    'aborted-root git status': p.parseForSecurityFromAst('git status', PARSE_ABORTED),
    'control-chars': p.parseForSecurityFromAst('echo \x07bell', PARSE_ABORTED),
    'checkSemantics []': p.checkSemantics([]),
    "nodeTypeId('command')": p.nodeTypeId('command'),
    'nodeTypeId(undefined)': p.nodeTypeId(undefined),
  }
  const psStrip: Golden['psStrip'] = {}
  for (const name of PS_NAME_CORPUS) psStrip[name] = p.stripModulePrefix(name)
  const psClassify: Golden['psClassify'] = {}
  for (const name of PS_NAME_CORPUS) psClassify[name] = p.classifyCommandName(p.stripModulePrefix(name)) ?? null
  return { split, redirections, tokens, parseStub, security, psStrip, psClassify }
}

const current = await computeCorpus()

if (record) {
  writeFileSync(GOLDEN, JSON.stringify(current, null, 1) + '\n')
  console.log(`\n  [RECORDED] corpus goldens → ${GOLDEN}`)
} else {
  section('(3) the behavior corpus vs recorded goldens')
  if (!existsSync(GOLDEN)) {
    check('corpus goldens exist (run --record first)', false)
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
    for (const [family, rows] of Object.entries(golden)) {
      const currentFamily = (current as unknown as Record<string, Record<string, unknown>>)[family]
      for (const [key, want] of Object.entries(rows as Record<string, unknown>)) {
        const got = currentFamily?.[key]
        check(
          `${family} · ${JSON.stringify(key)}`,
          JSON.stringify(got) === JSON.stringify(want),
          `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
        )
      }
    }
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(record ? ' ✅ CORPUS RECORDED' : ' ✅ COMMAND-ANALYSIS PROVIDER GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} COMMAND-ANALYSIS FAILURE(S)`)
process.exit(1)
