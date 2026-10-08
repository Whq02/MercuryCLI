#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'floor-decides-')))
const before = process.cwd()
mkdirSync(join(scratch, 'run'))
process.chdir(join(scratch, 'run'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
}
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
async function decide(command: string, allow: string[] = [], deny: string[] = [], ask: string[] = [], mode = 'default') {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { localSettings: allow }, alwaysDenyRules: { localSettings: deny }, alwaysAskRules: { localSettings: ask }, isBypassPermissionsModeAvailable: false }, tasks: {} }
  const context = { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), messages: [], options: {} }
  const result = await decideToolPermissionWithModes(bash as never, { command }, context as never, { message: { id: 'floor-decides' } } as never, 'toolu_floor_decides')
  return result.decision
}
const rows: Array<[string, string, string]> = [
  ['recursive delete substitution', 'rm -rf $(cat x)', 'ask'],
  ['destructive second statement', 'echo a; rm -rf /', 'ask'],
  ['changed directory before git', 'cd / && git status', 'ask'],
  ['process substitution', 'cat >(cat)', 'ask'],
  ['substitution in a write path', 'touch "prefix$(cat x)"', 'ask'],
  ['unquoted environment delete path', 'rm -rf $HOME/cache', 'ask'],
  ['expanding heredoc executes its substitution', 'cat <<EOF\n$(rm -rf /)\nEOF', 'ask'],
  ['single-quoted semicolon', "echo ';'", 'allow'],
  ['quoted exclamation remains text', 'echo "hi!"', 'allow'],
  ['quoted apostrophe remains text', `echo "a'b"`, 'allow'],
  ['listed version probe remains read-only', 'node -v', 'allow'],
  ['escaped find grouping remains read-only', 'find . \\( -name "*.ts" -o -name "*.js" \\)', 'allow'],
  ['single-quoted substitution is text', "echo '$(not run)'", 'allow'],
  ['quoted heredoc is data', "cat <<'EOF'\nrm -rf /\nEOF", 'allow'],
  ['git format punctuation is text', "git log --format='%h;%s'", 'allow'],
  ['grep punctuation is text', "grep ';' file", 'allow'],
  ['pipe continuation uses real words', 'wc -l file |\n head -n 1', 'allow'],
  ['bare xargs is not proven read-only', 'xargs', 'ask'],
  ['quoted mutating find flag is still a flag', `find . '-delete'`, 'ask'],
  ['concatenated mutating find flag is still a flag', `find . -de"lete"`, 'ask'],
  ['unbalanced quote', "echo 'unclosed", 'ask'],
  ['size guard', 'echo ' + 'x'.repeat(9996), 'ask'],
  ['protected redirect', 'echo value > /etc/mercury-floor-proof', 'ask'],
  ['redirect target is not a trailing argument', 'cat < /etc/mercury-floor-proof trailing', 'ask'],
  ['input descriptor still opens a file', 'cat 3< /etc/mercury-floor-proof', 'ask'],
  ['redirect glob needs a resolved path', 'cat < *.txt', 'ask'],
  ['startup environment changes execution', 'BASH_ENV=payload ls', 'ask'],
  ['lookup environment changes execution', 'PATH=payload ls', 'ask'],
  ['conditional assignment cannot retain a stale path', 'x=file; if true; then x=/etc/mercury-floor-proof; fi; cat "$x"', 'ask'],
  ['loop assignment cannot retain a stale path', 'x=file; for i in a; do x=/etc/mercury-floor-proof; done; cat "$x"', 'ask'],
]
for (const [label, command, expected] of rows) {
  const result = await decide(command)
  check(label, result.behavior === expected, JSON.stringify(result))
}
for (const command of ["echo 'unclosed", 'echo ' + 'x'.repeat(9996), 'rm -rf $(cat x)']) {
  const result = await decide(command, [`Bash(${command})`])
  check(`an exact allow cannot prove unreadable structure ${JSON.stringify(command.slice(0, 40))}`, result.behavior === 'ask', JSON.stringify(result))
}
const denied = await decide('echo a; rm -rf $(cat x)', [], ['Bash(rm *)'])
check('a structural ask never masks a deny on a visible command', denied.behavior === 'deny', JSON.stringify(denied))
for (const command of ['r"m" -rf x', 'r"m" -rf $(cat x)']) {
  const result = await decide(command, [], ['Bash(rm *)'])
  check(`quoted command names cannot hide a deny ${command}`, result.behavior === 'deny', JSON.stringify(result))
}
for (const command of ['echo a && echo b', 'echo a | cat']) {
  const result = await decide(command, [`Bash(${command})`], [], [`Bash(${command})`])
  check(`a full-command ask beats read-only parts ${command}`, result.behavior === 'ask', JSON.stringify(result))
}
const nestedAsks = await decide('echo a && echo b', ['Bash(echo a && echo b)'], [], ['Bash(echo *)'])
check('two subcommand ask rules beat a whole-command allow', nestedAsks.behavior === 'ask', JSON.stringify(nestedAsks))
const redirectDeny = await decide('echo data > secret | python3 -', [], [`Edit(/${join(process.cwd(), 'secret')})`])
check('a redirect deny survives an unrelated pipe ask', redirectDeny.behavior === 'deny', JSON.stringify(redirectDeny))
const arithmeticPath = await decide('cat "$((1+2))"', ['Bash(cat *)'], [`Read(/${join(process.cwd(), '3')})`])
check('an arithmetic spelling is not mistaken for its runtime path', arithmeticPath.behavior !== 'allow', JSON.stringify(arithmeticPath))
for (const command of ['x=cat; if true; then x=rm; $x victim; fi', 'x=rm; false && x=cat; $x victim', 'x=cat; false || x=rm; $x victim', 'x=cat; x=rm && false || $x victim']) {
  const result = await decide(command, ['Bash(cat *)'], ['Bash(rm *)'])
  check(`branch-dependent assignments never retain an allowed command name: ${command}`, result.behavior !== 'allow', JSON.stringify(result))
}
const { parseForSecurity } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
const { parseSedEditCommand } = await import('../../src/tools/BashTool/sedEditParser.js')
await parseForSecurity("sed -i 's/a/b/' file.txt")
check('the sed preview reads the already parsed single edit', parseSedEditCommand("sed -i 's/a/b/' file.txt")?.filePath === 'file.txt')
await parseForSecurity("sed -i 's/a/b/' file.txt; echo side-effect")
check('the sed preview never discards a second command', parseSedEditCommand("sed -i 's/a/b/' file.txt; echo side-effect") === null)
for (const command of ['exec tail -f log', "echo 'unclosed", 'echo ' + 'x'.repeat(9996)]) {
  const sovereign = await decide(command, [], [], [], 'sovereign')
  const granted = await decide(command, ['Bash'])
  check(`sovereign answers an ordinary unproven ask: ${command.slice(0, 30)}`, sovereign.behavior === 'allow', JSON.stringify(sovereign))
  check(`default mode retains its safety ask ahead of a whole-tool grant: ${command.slice(0, 30)}`, granted.behavior === 'ask', JSON.stringify(granted))
}
const unavailableProgram = `globalThis.MACRO={VERSION:'1.0.0'};
const {enableConfigs}=await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/config.ts'))});enableConfigs();
const {getEmptyToolPermissionContext}=await import(${JSON.stringify(join(import.meta.dir, '../../src/Tool.ts'))});
const {bashToolHasPermission}=await import(${JSON.stringify(join(import.meta.dir, '../../src/tools/BashTool/bashPermissions.ts'))});
const context={...getEmptyToolPermissionContext(),alwaysAllowRules:{localSettings:['Bash(echo literal)']}};
const result=await bashToolHasPermission({command:'echo literal'},context);
console.log(JSON.stringify(result));process.exit(result.behavior==='ask'&&result.decisionReason?.operatorOnly===false&&!('floor' in result.decisionReason)?0:1);`
const unavailable = spawnSync(process.execPath, ['-e', unavailableProgram], { env: { ...process.env, MERCURY_TREESITTER_VENDOR_DIR: join(scratch, 'absent-grammar') }, encoding: 'utf8', timeout: 30_000, windowsHide: true })
check('an unavailable grammar asks even with an exact allow rule', unavailable.status === 0, unavailable.stdout + unavailable.stderr)
process.chdir(before)
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `prove-floor-decides: ${failures} FAILURE(S)` : 'prove-floor-decides: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
