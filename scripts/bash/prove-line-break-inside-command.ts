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
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { parseForSecurity } = await import('../../src/utils/permissions/decision/commandAnalysis.js')

const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
}
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
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

let glued: string[] = []
let readings = 0
for (const first of [...pipelines, 'ls | sort |& head', 'ls | sort | head -n 3']) {
  for (const tail of TAILS) {
    const command = `${first}\nzzprog zzarg${tail}`
    const reading = await parseForSecurity(command)
    readings++
    if (reading.kind !== 'simple') continue
    const own = reading.commands.some(c => c.argv[0] === 'zzprog')
    const inside = reading.commands.some(c => c.argv.indexOf('zzprog') > 0)
    if (!own || inside) glued.push(`${shown(command)} read as ${shown(reading.commands.map(c => c.argv))}`)
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

const refused = await parseForSecurity('ls | sort | head\nzzprog zzarg 2>/dev/null')
check('the refusal says what to change', refused.kind === 'too-complex' && /line break/.test(refused.reason) && /; or &&/.test(refused.reason), shown(refused))

process.chdir(before)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? `\nprove-line-break-inside-command: ${checks} checks, ALL PASS` : `\nprove-line-break-inside-command: ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
