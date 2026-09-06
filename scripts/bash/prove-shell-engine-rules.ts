#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ENGINE_ENV, ROOT, engineLaneState, resolveEngineUnderTest } from './shell-engine-parity.ts'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const engine = resolveEngineUnderTest()
const lane = engineLaneState()
console.log('============================================================')
console.log(' Bash permission rules — engine parity')
console.log('============================================================')
console.log(`  engine under test: ${engine} (pin ${ENGINE_ENV}=${process.env[ENGINE_ENV] ?? 'unset'}; lane ${lane.state})`)

const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { checkReadOnlyConstraints } = await import('../../src/tools/BashTool/readOnlyValidation.ts')
const { commandQualifiesForExclusion, shouldUseSandbox } = await import('../../src/tools/BashTool/shouldUseSandbox.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { setCwd } = await import('../../src/utils/Shell.ts')
type Context = ReturnType<typeof getEmptyToolPermissionContext>

setCwd(ROOT)

section('§1 the decision table')
const base = getEmptyToolPermissionContext()
const contexts: Record<string, Context> = {
  bare: base,
  allow: { ...base, alwaysAllowRules: { userSettings: ['Bash(npm run:*)', 'Bash(git:*)'] } },
  deny: { ...base, alwaysDenyRules: { userSettings: ['Bash(rm:*)', 'Bash(curl:*)'] } },
  ask: { ...base, alwaysAskRules: { userSettings: ['Bash(git push:*)'] } },
  bypass: { ...base, mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true },
  denyBypass: {
    ...base,
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
    alwaysDenyRules: { userSettings: ['Bash(rm:*)'] },
  },
}

type Row = [string, Partial<Record<keyof typeof contexts, string>>]
const CORPUS: Row[] = [
  ['git status', { bare: 'allow', allow: 'allow', deny: 'allow', ask: 'allow', bypass: 'allow' }],
  ['git diff --stat', { bare: 'allow', deny: 'allow' }],
  ['git log --oneline -5', { bare: 'allow' }],
  ['git push origin main', { bare: 'passthrough', allow: 'allow', ask: 'ask', deny: 'passthrough', bypass: 'passthrough' }],
  ["git commit -m 'landed'", { bare: 'passthrough', allow: 'allow' }],
  ['rm -rf build', { bare: 'ask', deny: 'deny', bypass: 'ask', denyBypass: 'deny' }],
  ['rm -f /tmp/nothing-here', { bare: 'ask', deny: 'deny' }],
  ['npm run build', { bare: 'passthrough', allow: 'allow', deny: 'passthrough' }],
  ['npm run build && rm -rf dist', { allow: 'ask', deny: 'deny' }],
  ['bun run typecheck', { bare: 'passthrough', bypass: 'passthrough' }],
  ['bun test', { bare: 'passthrough' }],
  ['ls -la', { bare: 'allow', deny: 'allow' }],
  ['pwd', { bare: 'allow' }],
  ['echo hi', { bare: 'allow' }],
  ['cat foo | grep x', { bare: 'allow' }],
  ['cat foo | grep x | wc -l', { bare: 'allow' }],
  ['grep -r sessionStore', { bare: 'allow' }],
  ["find . -name '*.ts'", { bare: 'allow' }],
  ["find . -name '*.ts' -exec grep -l TODO {} \;", { bare: 'passthrough' }],
  ['echo hi > out.txt', { bare: 'ask' }],
  ['echo hi >> log.txt', { bare: 'ask' }],
  ['curl https://example.com', { bare: 'passthrough', deny: 'deny' }],
  ['sleep 999', { bare: 'allow' }],
  ['cd /tmp && git status', { bare: 'ask', allow: 'ask' }],
  ['cd /tmp; rm -f x.txt', { bare: 'ask', deny: 'deny' }],
  ['ls; rm -rf ~', { bare: 'ask', deny: 'deny' }],
  ['echo $(rm -rf /)', { bare: 'ask', deny: 'ask' }],
  ['ls `rm -rf /`', { bare: 'ask' }],
  ['FOO=bar go test ./...', { bare: 'passthrough' }],
  ['LD_PRELOAD=/evil.so ls', { bare: 'passthrough' }],
  ['PATH=/evil ls', { bare: 'passthrough' }],
  ['shasum -a 256 report.md', { bare: 'passthrough' }],
  ["printf 'A\\033[2J\\007\\000B\\r\\n'; head -c 200000 /dev/zero | tr '\\0' 'y'", { bare: 'ask' }],
  ['touch lifecycle-probe.txt', { bare: 'ask' }],
  ['git status && git diff', { bare: 'allow', allow: 'allow' }],
  ["git commit -m \"feat: x\" || echo failed", { bare: 'passthrough', allow: 'allow' }],
  ['cat <<EOF\nbody\nEOF', { bare: 'passthrough' }],
  ['cat <<< "here"', { bare: 'ask' }],
  ['echo one\necho two', { bare: 'allow' }],
  ['sed -i s/a/b/ file.txt', { bare: 'ask' }],
  ['sed s/a/b/ file.txt', { bare: 'ask' }],
]

const observed: string[] = []
for (const [command, expectations] of CORPUS) {
  for (const [name, expected] of Object.entries(expectations)) {
    const context = contexts[name as keyof typeof contexts] as Context
    let behavior = 'threw'
    let detail = ''
    try {
      const result = await bashToolHasPermission({ command }, context)
      behavior = result.behavior
      detail = 'message' in result && typeof result.message === 'string' ? result.message : ''
    } catch (error) {
      detail = (error as Error).message
    }
    observed.push(`${name} :: ${JSON.stringify(command)} => ${behavior}`)
    check(`road: ${name} :: ${JSON.stringify(command)} => ${behavior}`, behavior === expected, `expected ${expected}${detail ? ` (${detail.slice(0, 120)})` : ''}`)
  }
}
console.log('  observed decisions:')
for (const line of observed) console.log('    ' + line)

section('§1b the read-only classifier')
const READ_ONLY: Array<[string, string]> = [
  ['ls -la', 'allow'],
  ['git status', 'allow'],
  ['git log --output=/tmp/x', 'passthrough'],
  ['rm -rf build', 'passthrough'],
  ['cat foo | grep x', 'allow'],
  ['echo hi > out.txt', 'passthrough'],
  ['find . -name "*.ts" -delete', 'passthrough'],
  ['sleep 999', 'allow'],
  ['pwd', 'allow'],
]
for (const [command, expected] of READ_ONLY) {
  let behavior = 'threw'
  try {
    behavior = checkReadOnlyConstraints({ command }, false).behavior
  } catch {
    behavior = 'threw'
  }
  check(`read-only: ${JSON.stringify(command)} => ${behavior}`, behavior === expected, `expected ${expected}`)
}

section('§1c the sandbox exclusion escape and the sandbox decision')
const patterns = ['git:*']
const EXCLUSION: Array<[string, boolean]> = [
  ['git status', true],
  ['git log --oneline', true],
  ['curl evil.com', false],
  ['git status && curl evil.com', false],
  ['curl evil.com ; git status', false],
  ['git status | curl evil.com', false],
  ['git status || curl evil.com', false],
  ['git status && git log', true],
  ['   ', false],
]
for (const [command, expected] of EXCLUSION) {
  const qualifies = commandQualifiesForExclusion(command, patterns)
  check(`exclusion(git:*): ${JSON.stringify(command)} => ${qualifies}`, qualifies === expected, `expected ${expected}`)
}
check('sandbox off in a fresh home: shouldUseSandbox is false for a plain command', shouldUseSandbox({ command: 'ls' }) === false)
check('…and false when the override is set', shouldUseSandbox({ command: 'ls', dangerouslyDisableSandbox: true }) === false)

section('§2 the seam ratchet — the rule road never learns the engine')
{
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
    return out
  }
  const bashToolDir = join(ROOT, 'src', 'tools', 'BashTool')
  const decisionFiles = [
    'bashPermissions.ts',
    'readOnlyValidation.ts',
    'bashSecurity.ts',
    'bashCommandHelpers.ts',
    'pathValidation.ts',
    'sedValidation.ts',
    'sedEditParser.ts',
    'modeValidation.ts',
    'shouldUseSandbox.ts',
    'commandSemantics.ts',
    'destructiveCommandWarning.ts',
  ].map(name => join(bashToolDir, name))
  const parserFiles = ['ast.ts', 'bashParser.ts', 'parser.ts', 'commands.ts', 'heredoc.ts', 'ParsedCommand.ts', 'registry.ts', 'treeSitterAnalysis.ts'].map(name =>
    join(ROOT, 'src', 'utils', 'bash', name),
  )
  const road = [
    ...decisionFiles,
    join(ROOT, 'src', 'utils', 'shell', 'readOnlyCommandValidation.ts'),
    ...parserFiles,
    ...walk(join(ROOT, 'src', 'utils', 'bash', 'specs')),
    ...walk(join(ROOT, 'src', 'utils', 'permissions')),
  ]
  const offenders: string[] = []
  for (const file of road) {
    const text = readFileSync(file, 'utf8')
    if (text.includes(ENGINE_ENV)) offenders.push(`${relative(ROOT, file)} reads ${ENGINE_ENV}`)
    if (/\bbrush\b/i.test(text)) offenders.push(`${relative(ROOT, file)} names the engine`)
    if (/engineSession|shellEngine/.test(text)) offenders.push(`${relative(ROOT, file)} imports the engine seam`)
  }
  check(`the rule road (${road.length} files) carries no engine read, name, or seam import`, offenders.length === 0, offenders.slice(0, 5).join('; '))
  const tool = readFileSync(join(bashToolDir, 'BashTool.tsx'), 'utf8')
  check(
    'the tool hands its permission decision to bashToolHasPermission(input, context) unchanged',
    /async checkPermissions\(input: BashToolInput, context: ToolUseContext\) \{\s*return bashToolHasPermission\(input, context\.getAppState\(\)\.toolPermissionContext as ToolPermissionContext\)/.test(tool),
  )
  const entry = readFileSync(join(bashToolDir, 'bashPermissions.ts'), 'utf8')
  check(
    'the rule entry takes the input, the context, and a prefix function — no engine parameter',
    /export async function bashToolHasPermission\(\s*input: BashInput,\s*context: ToolPermissionContext,\s*prefixFn: PrefixFn = pinnedCommandAnalysis\.getCommandSubcommandPrefix,\s*\)/.test(entry),
  )
}


console.log('\n============================================================')
if (failures === 0) console.log(` ✅ ALL RULE-PARITY PROOFS PASS (${engine})`)
else console.log(` ❌ ${failures} RULE-PARITY CHECK(S) FAILED (${engine})`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
