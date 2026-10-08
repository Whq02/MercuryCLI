import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'floor-review-')))
const before = process.cwd()
mkdirSync(join(scratch, 'run'))
writeFileSync(join(scratch, 'run', 'f'), 'data\n')
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
const { checkReadOnlyConstraints } = await import('../../src/tools/BashTool/readOnlyValidation.js')
const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
}
type Rules = { allow?: string[]; deny?: string[]; ask?: string[]; mode?: string; cliAllow?: string[] }
async function decide(command: string, rules: Rules = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: rules.mode ?? 'default', alwaysAllowRules: { localSettings: rules.allow ?? [], cliArg: rules.cliAllow ?? [] }, alwaysDenyRules: { localSettings: rules.deny ?? [] }, alwaysAskRules: { localSettings: rules.ask ?? [] }, isBypassPermissionsModeAvailable: false }, tasks: {} }
  const context = { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), messages: [], options: {} }
  return (await decideToolPermissionWithModes(bash as never, { command }, context as never, { message: { id: 'floor-review' } } as never, 'toolu_floor_review')).decision
}
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const group = process.argv[2]
if (!group || group === 'writers') {
  const mutations = [
    'x=cat; read x <<< rm; $x -rf victim',
    'x=cat; read -rp prompt x <<< rm; $x -rf victim',
    'x=cat; read -ax <<< rm; $x -rf victim',
    'x=cat; read -ra x <<< rm; $x -rf victim',
    'REPLY=cat; read <<< rm; $REPLY -rf victim',
    'x=cat; printf -v x %s rm; $x -rf victim',
    'x=cat; printf -vx %s rm; $x -rf victim',
    'x=cat; getopts r x -r; $x victim',
    'OPTARG=cat; getopts r: flag -r rm; $OPTARG victim',
    'x=cat; wait -p x 1; $x victim',
    'x=cat; wait -npx 1; $x victim',
    'x=CAT; declare -l x; $x f',
    'declare -l x; x=CAT; $x f',
    'x=cat; typeset -u x; $x f',
    'x=cat; if true; then read x <<< rm; fi; $x victim',
    'x=cat; if true; then printf -v x %s rm; fi; $x victim',
    'x=cat; true && read x <<< rm; $x victim',
    'x=cat; false || printf -v x %s rm; $x victim',
    'x=cat; for i in a b; do $x victim; read x <<< rm; done',
    'x=cat; while read x; do $x victim; done',
    'read PATH <<< payload; ls',
    'printf -v IFS %s a; x=cat; $x f',
  ]
  const allow = ['Bash(cat *)', 'Bash(CAT *)', 'Bash(read *)', 'Bash(printf *)', 'Bash(getopts *)', 'Bash(wait *)', 'Bash(declare *)', 'Bash(typeset *)', 'Bash(true)', 'Bash(false)']
  for (const command of mutations) {
    const result = await decide(command, { allow })
    check(`writers: ${command}`, result.behavior === 'ask' && result.decisionReason?.type === 'safetyCheck' && result.decisionReason.operatorOnly === false && !('floor' in result.decisionReason), result)
    const read = await checkReadOnlyConstraints({ command }, false)
    check(`writers stay out of read-only admission: ${command}`, read.behavior !== 'allow', read)
  }
  for (const command of ['x=cat; read y <<< data; $x f', 'x=cat; read -p x y <<< data; $x f', 'x=cat; if true; then read y <<< data; fi; $x f', 'x=cat; printf %s data; $x f']) {
    const result = await decide(command, { allow })
    check(`unrelated variables stay known: ${command}`, result.behavior === 'allow', result)
  }
}
process.chdir(before)
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `floor-review: ${failures} FAILURE(S)` : 'floor-review: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
