#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { getFlagSpec } from '../../src/platform/substrate/flagRegistry.ts'
import { ENGINE_ENV, ROOT, findVendoredBrush } from './shell-engine-parity.ts'

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

const laneState = getFlagSpec(ENGINE_ENV) !== undefined && findVendoredBrush(ROOT) !== null ? 'wired' : 'unwired'
const engine = process.env[ENGINE_ENV] === 'brush' && laneState === 'wired' ? 'brush' : 'system'
console.log('============================================================')
console.log(' Bash permission rules — engine parity')
console.log('============================================================')
console.log(`  engine under test: ${engine} (pin ${ENGINE_ENV}=${process.env[ENGINE_ENV] ?? 'unset'}; lane ${laneState})`)

const { bashToolHasPermission } = await import('../../src/tools/shell/bashPermissions.ts')
const { checkReadOnlyConstraints } = await import('../../src/tools/shell/readOnlyValidation.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { setCwd } = await import('../../src/platform/shell/shellExec.ts')
type Context = ReturnType<typeof getEmptyToolPermissionContext>

setCwd(ROOT)

section('§1 the decision table')
const base = getEmptyToolPermissionContext()
const contexts: Record<string, Context> = {
  bare: base,
  allow: { ...base, alwaysAllowRules: { userSettings: ['Bash(npm run *)', 'Bash(git *)'] } },
  deny: { ...base, alwaysDenyRules: { userSettings: ['Bash(rm *)', 'Bash(curl *)'] } },
  ask: { ...base, alwaysAskRules: { userSettings: ['Bash(git push *)'] } },
  bypass: { ...base, mode: 'sovereign', isBypassPermissionsModeAvailable: true },
  denyBypass: {
    ...base,
    mode: 'sovereign',
    isBypassPermissionsModeAvailable: true,
    alwaysDenyRules: { userSettings: ['Bash(rm *)'] },
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
  ['ls; rm -rf ~', { bare: 'deny', deny: 'deny' }],
  ['echo $(rm -rf /)', { bare: 'deny', deny: 'deny' }],
  ['ls `rm -rf /`', { bare: 'deny' }],
  ['FOO=bar go test ./...', { bare: 'passthrough' }],
  ['LD_PRELOAD=/evil.so ls', { bare: 'ask' }],
  ['PATH=/evil ls', { bare: 'ask' }],
  ['shasum -a 256 report.md', { bare: 'passthrough' }],
  ["printf 'A\\033[2J\\007\\000B\\r\\n'; head -c 200000 /dev/zero | tr '\\0' 'y'", { bare: 'ask' }],
  ['touch lifecycle-probe.txt', { bare: 'ask' }],
  ['git status && git diff', { bare: 'allow', allow: 'allow' }],
  ["git commit -m \"feat: x\" || echo failed", { bare: 'passthrough', allow: 'allow' }],
  ['cat <<EOF\nbody\nEOF', { bare: 'ask' }],
  ['cat <<< "here"', { bare: 'allow' }],
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
    behavior = (await checkReadOnlyConstraints({ command }, false)).behavior
  } catch {
    behavior = 'threw'
  }
  check(`read-only: ${JSON.stringify(command)} => ${behavior}`, behavior === expected, `expected ${expected}`)
}

section('§2 the seam ratchet — the rule road never learns the engine')
{
  const did: string[] = []
  const more = (which: string): unknown => new Proxy(() => undefined, { get: (_target, key) => (did.push(`read ${String(key)} of a ${which} argument`), undefined), apply: () => (did.push(`called a ${which} argument`), undefined) })
  await (bashToolHasPermission as (...args: unknown[]) => Promise<unknown>)({ command: 'npm run build' }, base, more('third'), more('fourth'))
  check(
    'at run time the rule entry counts two parameters and neither reads nor calls two more handed to it; TwoParameters in bashPermissions refuses a third parameter of any kind at typecheck',
    bashToolHasPermission.length === 2 && did.length === 0,
    `bashToolHasPermission declares ${bashToolHasPermission.length} parameters and, handed four arguments, ${did.join(', ') || 'used neither of the two more'}: its parameters are the input and the context, in the bashPermissions module of the Bash tool`,
  )
}


console.log('\n============================================================')
if (failures === 0) console.log(` ✅ ALL RULE-PARITY PROOFS PASS (${engine})`)
else console.log(` ❌ ${failures} RULE-PARITY CHECK(S) FAILED (${engine})`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
