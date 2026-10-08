#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
await import('../../src/Tool.js')
const { pinnedCommandAnalysis, PARSE_ABORTED, parseForSecurity, ParsedCommand } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
const { parseCommandRaw } = pinnedCommandAnalysis
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'parser-corpus-parity.json'), 'utf8')) as { entries: { command: string }[] }
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
let trees = 0
const absent: string[] = []
for (const { command } of fixture.entries) {
  const root = await parseCommandRaw(command)
  if (command === '' || command.length > 10_000) continue
  if (root && root !== PARSE_ABORTED) trees++
  else absent.push(command)
}
check('the product produces trees throughout the parser corpus', absent.length === 0, `${absent.length} absent; first ${JSON.stringify(absent[0])}`)
check('the corpus exercised real parses', trees > 1000, String(trees))
for (const command of ['ls -la', "echo '$(not run); text'", 'git log --format=\'%h;%s\'', "cat <<'EOF'\nrm -rf /\nEOF", 'echo é😀 | cat']) {
  const result = await parseForSecurity(command)
  check(`ordinary structure ${JSON.stringify(command)}`, result.kind === 'simple', JSON.stringify(result))
}
for (const command of ['echo \u0007bell', 'echo a\u200bb', 'echo a\\ b', 'echo ~[x]', 'echo =ls', 'echo {a,"b"}']) {
  const result = await parseForSecurity(command)
  check(`pre-check ${JSON.stringify(command)}`, result.kind === 'too-complex', JSON.stringify(result))
}
const broken = await parseForSecurity("echo 'unclosed")
check('an incomplete quote cannot become a simple command', broken.kind === 'too-complex', JSON.stringify(broken))
check('the 10000-character guard remains', await parseCommandRaw('x'.repeat(10_001)) === null)
const one = parseCommandRaw('echo memo')
const two = parseCommandRaw('echo memo')
check('concurrent identical parses share the same detached tree', (await one) === (await two) && await one !== null)
const unicode = await ParsedCommand.parse('echo é😀 | cat > résultat.txt')
check('multibyte pipe spans slice on the measured string coordinates', JSON.stringify(unicode?.getPipeSegments()) === JSON.stringify(['echo é😀', 'cat > résultat.txt']), JSON.stringify(unicode?.getPipeSegments()))
check('multibyte redirection removal preserves the preceding source', unicode?.withoutOutputRedirections() === 'echo é😀 | cat', unicode?.withoutOutputRedirections())
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
async function decision(command: string, allow: string[] = [], deny: string[] = [], ask: string[] = []) {
  return bashToolHasPermission({ command }, {
    ...getEmptyToolPermissionContext(), mode: 'default',
    alwaysAllowRules: { localSettings: allow }, alwaysDenyRules: { localSettings: deny }, alwaysAskRules: { localSettings: ask },
  } as never)
}
for (const command of ['echo a && echo b', 'echo a | cat']) {
  const result = await decision(command, [`Bash(${command})`], [], [`Bash(${command})`])
  check(`a full-command ask beats read-only parts: ${command}`, result.behavior === 'ask', JSON.stringify(result))
}
const subAsks = await decision('echo a && echo b', ['Bash(echo a && echo b)'], [], ['Bash(echo *)'])
check('subcommand asks beat a whole-command allow', subAsks.behavior === 'ask', JSON.stringify(subAsks))
const redirectDeny = await decision('echo data > secret | python3 -', [], [`Edit(/${join(process.cwd(), 'secret')})`])
check('redirect denies survive a pipe asking for another reason', redirectDeny.behavior === 'deny', JSON.stringify(redirectDeny))
for (const command of ['HOME=/outside cat ~/file', 'CDPATH=/outside cd project', 'GIT_WORK_TREE=/outside git status']) {
  const result = await decision(command, [`Bash(${command})`])
  check(`an assignment cannot silently change the path context: ${command}`, result.behavior === 'ask', JSON.stringify(result))
}
const echoedStatus = await parseForSecurity('echo "rc=$?"')
check('runtime status text is data in an echo argument, not a path', echoedStatus.kind === 'simple' && pinnedCommandAnalysis.checkSemantics(echoedStatus.commands).ok)
const nestedDelete = await decision('echo "prefix$(rm -rf /)"', [], ['Bash(rm *)'])
check('echo data handling never hides a nested executable command', nestedDelete.behavior === 'deny', JSON.stringify(nestedDelete))
for (const command of ['cat "$((1+2))"', 'cat $((1+2))']) {
  const result = await decision(command, ['Bash(cat *)'], [`Read(/${join(process.cwd(), '3')})`])
  check(`an expansion is not its source spelling as a path: ${command}`, result.behavior === 'ask', JSON.stringify(result))
}
const ruledGlob = await decision('cat *', ['Bash(cat *)'], [`Read(/${join(process.cwd(), '3')})`])
check('a saved allow rule answers a wildcard operand the floor cannot resolve to a path, as it did last release', ruledGlob.behavior === 'allow', JSON.stringify(ruledGlob))
console.log(failures ? `prove-floor-parses: ${failures} FAILURE(S)` : 'prove-floor-parses: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
