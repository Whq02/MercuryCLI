#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GOLDEN = join(import.meta.dir, 'command-analysis-corpus.json')
const record = process.argv.includes('--record')

const { pinnedCommandAnalysis, PARSE_ABORTED } = await import(
  '../../src/permissions/rules/decision/commandAnalysis.ts'
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


section('(2) provider shape — every op present; effectful ops bound, not driven')
{
  const ops = [
    'parseCommandRaw',
    'parseForSecurityFromAst',
    'checkSemantics',
    'nodeTypeId',
    'splitCommand',
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
    check(`op ${op} bound`, typeof (pinnedCommandAnalysis as Record<string, unknown>)[op] === 'function', `pinnedCommandAnalysis in src/permissions/rules/decision/commandAnalysis.ts must bind ${op} as a function`)
  }
  const held = Object.keys(pinnedCommandAnalysis).sort().join(' ')
  const listed = [...ops].sort().join(' ')
  check('the record holds these ops and no other', held === listed, `the record holds ${held}; this check lists ${listed}; an op that enters or leaves pinnedCommandAnalysis enters or leaves ops here`)
}

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
  for (const cmd of SPLIT_CORPUS) {
    await p.parseCommandRaw(cmd)
    split[cmd] = p.splitCommand(cmd)
  }
  const redirections: Golden['redirections'] = {}
  for (const cmd of REDIRECT_CORPUS) {
    await p.parseCommandRaw(cmd)
    redirections[cmd] = p.extractOutputRedirections(cmd)
  }
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
    check('corpus goldens exist (run --record first)', false, `${GOLDEN} is missing; run bun scripts/decisions/prove-command-analysis.ts --record once and keep the file`)
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
