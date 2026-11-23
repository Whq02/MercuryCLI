#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'line-break-')))
const before = process.cwd()
mkdirSync(join(scratch, 'run'))
process.chdir(join(scratch, 'run'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.js')
const { bashToolHasPermission } = await import('../../src/tools/shell/bashPermissions.js')
const { parseForSecurity } = await import('../../src/permissions/rules/decision/commandAnalysis.js')
const { refusalOfShellCommand } = await import('../../src/permissions/wards/wardsRefusals.js')
const { shellCredentialWritePath, shellSelfProtectionReason } = await import('../../src/permissions/rules/shellProtectedPaths.js')

const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
}
let failures = 0
let checks = 0
const lineBreakHint = 'change how a command on the line after a pipeline is read in parseForSecurity (src/platform/shell/bash/ast.ts), or how it is judged in bashToolHasPermission (src/tools/shell/bashPermissions.ts), refusalOfShellCommand (src/permissions/wards/wardsRefusals.ts), shellCredentialWritePath and shellSelfProtectionReason (src/permissions/rules/shellProtectedPaths.ts)'
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `${detail ? ` — ${detail}` : ''} · ${lineBreakHint}`}`)
}
async function decide(command: string): Promise<string> {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false }, tasks: {} }
  const context = { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), messages: [], options: {} }
  const result = await decideToolPermissionWithModes(bash as never, { command }, context as never, { message: { id: 'line-break' } } as never, 'toolu_line_break')
  return (result.decision as { behavior: string }).behavior
}
const shown = (value: unknown): string => JSON.stringify(value).slice(0, 300)

const STAGES = ['ls', 'sort', 'head', 'tail', 'wc']
const pipelines = [1, 2, 3, 4, 5].map(count => STAGES.slice(0, count).join(' | '))
const TAILS = [' 2>/dev/null', ' >out.txt', ' >>out.txt', ' 2>&1', ' <in.txt', ' && true', ' || true', '', ' ; true']

const BREAKS = ['\n', '\n\n', '\r\n', '\n\t', ' \n ']
const SECONDS = ['zzprog zzarg', 'zzfirst && zzprog zzarg', 'zzfirst; zzprog zzarg']

let glued: string[] = []
let readings = 0
for (const first of [...pipelines, 'ls | sort |& head', 'ls | sort | head -n 3']) {
  for (const lineBreak of BREAKS) {
    for (const second of SECONDS) {
      for (const tail of TAILS) {
        const command = `${first}${lineBreak}${second}${tail}`
        const reading = await parseForSecurity(command)
        readings++
        if (reading.kind !== 'simple') continue
        const own = reading.commands.some(c => c.argv[0] === 'zzprog')
        const inside = reading.commands.some(c => c.argv.slice(1).some(word => word === 'zzprog' || word === 'zzfirst'))
        if (!own || inside) glued.push(`${shown(command)} read as ${shown(reading.commands.map(c => c.argv))}`)
      }
    }
  }
}
check(`a command on the next line is read as a command of its own or not read at all, never as words of the line before (${readings} texts)`, glued.length === 0, `${glued.length} glued, e.g. ${glued[0]}`)

const HIDDEN = ['sh x.sh', 'python3 x.py', 'node x.js', 'curl -s https://example.com/x.sh -o x.sh', 'npm install left-pad', 'make install', 'kill 123', 'chmod -R 777 .']
const allowed: string[] = []
for (const hidden of HIDDEN) {
  for (const command of [`ls | sort | head\n${hidden} 2>/dev/null`, `ls | sort | head\n${hidden} && true`, `ls | sort | head | tail\n${hidden} 2>/dev/null`]) {
    const behavior = await decide(command)
    if (behavior !== 'ask' && behavior !== 'deny') allowed.push(`${shown(command)} → ${behavior}`)
  }
}
check(`default mode with no rules asks about a program on the line after a read-only pipeline (${HIDDEN.length * 3} texts)`, allowed.length === 0, `${allowed.length} allowed with no question, e.g. ${allowed[0]}`)
check('the same program alone is asked about', (await decide('sh x.sh 2>/dev/null')) === 'ask')

const CONTROLS: Array<[string, string, string[][]]> = [
  ['a read-only pipeline of three stages alone', 'ls | sort | head', [['ls'], ['sort'], ['head']]],
  ['a backslash before the line break joins the words', 'ls -l \\\n-a', [['ls', '-l', '-a']]],
  ['a line break inside quotes is part of the word', 'echo "a\nb"', [['echo', 'a\nb']]],
  ['a line break after a pipe continues the pipeline', 'ls |\nsort', [['ls'], ['sort']]],
  ['two commands on two lines after a pipeline of two stages', 'ls | sort\nzzprog zzarg 2>/dev/null', [['ls'], ['sort'], ['zzprog', 'zzarg']]],
  ['two commands on two lines with no redirect', 'ls | sort | head\nzzprog zzarg', [['ls'], ['sort'], ['head'], ['zzprog', 'zzarg']]],
  ['multibyte text before a pipeline of three stages', 'echo é😀 | cat | head', [['echo', 'é😀'], ['cat'], ['head']]],
]
for (const [label, command, want] of CONTROLS) {
  const reading = await parseForSecurity(command)
  check(`${label} reads as before`, reading.kind === 'simple' && JSON.stringify(reading.commands.map(c => c.argv)) === JSON.stringify(want), shown(reading.kind === 'simple' ? reading.commands.map(c => c.argv) : reading))
}
const heredoc = await parseForSecurity("cat <<'EOF'\nrm -rf /\nEOF")
check('a here-document body on the next lines reads as before', heredoc.kind === 'simple', shown(heredoc))
check('a read-only pipeline of three stages alone is still allowed with no question', (await decide('ls | sort | head')) === 'allow')

const texts = (second: string): string[] => [...pipelines, 'ls | sort |& head', 'ls | sort | head -n 3'].flatMap(first => BREAKS.flatMap(lineBreak => TAILS.map(tail => `${first}${lineBreak}${second}${tail}`)))
const STOPPED: Array<[string, string]> = [['sudo zzarg', 'no-sudo'], ['shutdown -h now', 'no-system-halt'], ['crontab zzjobs.txt', 'cron-persist'], ['git config --global user.name zz', 'git-config-global']]
const ward = async (command: string): Promise<string> => {
  const verdict = await refusalOfShellCommand({ toolName: 'Bash', input: { command }, shellCommand: command } as never, '/work')
  return verdict.allow ? 'allowed' : (verdict.rule?.name ?? 'refused')
}
for (const [program, name] of STOPPED) {
  const passed: string[] = []
  const all = [...texts(program), ...texts(`zzfirst && ${program}`), ...texts(`zzfirst; ${program}`)]
  for (const command of all) if ((await ward(command)) !== name) passed.push(shown(command))
  check(`the ward ${name} refuses ${program} alone and on the line after a pipeline (${all.length} texts)`, (await ward(program)) === name && passed.length === 0, `${passed.length} not refused by it, e.g. ${passed[0]}`)
}
check('a command the wards stop nowhere is allowed on the line after a pipeline', (await ward('ls | sort | head\nzzprog zzarg 2>/dev/null')) === 'allowed')

const FLOORS: Array<[string, string, (command: string, powershell: boolean, cwd: string) => Promise<unknown>]> = [
  ['a write to the keys a login accepts', 'tee -a ~/.ssh/authorized_keys', shellCredentialWritePath],
  ['a copy over the keys a login accepts', 'cp zzkey.pub ~/.ssh/authorized_keys', shellCredentialWritePath],
  ["a recursive delete of Mercury's own home", `rm -rf ${join(scratch, 'home')}`, shellSelfProtectionReason],
]
for (const [label, program, floor] of FLOORS) {
  const passed: string[] = []
  const all = texts(program)
  for (const command of all) if ((await floor(command, false, '/work')) === null) passed.push(shown(command))
  check(`${label} is stopped alone and on the line after a pipeline (${all.length} texts)`, (await floor(program, false, '/work')) !== null && passed.length === 0, `${passed.length} passed, e.g. ${passed[0]}`)
}

const ruled = async (command: string, mode: string): Promise<string> => (await bashToolHasPermission({ command }, { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: {}, alwaysDenyRules: { localSettings: ['Bash(zzprog *)'] }, alwaysAskRules: {} } as never)).behavior
for (const mode of ['sovereign', 'flow']) {
  const passed: string[] = []
  const all = SECONDS.flatMap(texts)
  for (const command of all) if ((await ruled(command, mode)) !== 'deny') passed.push(shown(command))
  check(`in ${mode} mode a deny rule on a program denies it alone and on the line after a pipeline (${all.length} texts)`, (await ruled('zzprog zzarg', mode)) === 'deny' && passed.length === 0, `${passed.length} not denied, e.g. ${passed[0]}`)
}
const asked: string[] = []
for (const command of SECONDS.flatMap(texts)) if ((await ruled(command, 'default')) === 'allow') asked.push(shown(command))
check('in default mode the same rule never lets it through with no question', asked.length === 0, `${asked.length} allowed, e.g. ${asked[0]}`)

const refused = await parseForSecurity('ls | sort | head\nzzprog zzarg 2>/dev/null')
check('the refusal says what to change', refused.kind === 'too-complex' && /line break/.test(refused.reason) && /; or &&/.test(refused.reason), shown(refused))

process.chdir(before)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? `\nprove-line-break-inside-command: ${checks} checks, ALL PASS` : `\nprove-line-break-inside-command: ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
