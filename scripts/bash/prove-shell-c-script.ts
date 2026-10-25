import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shell-c-script-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { setCwd } = await import('../../src/utils/Shell.js')
const { setOriginalCwd } = await import('../../src/bootstrap/state.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { checkReadOnlyConstraints, prepareBashReadOnly, preparedBashReadsOnly } = await import('../../src/tools/BashTool/readOnlyValidation.js')
const { shellCommandText } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.js')
const { z } = await import('zod/v4')
const project = join(scratch, 'project')
mkdirSync(join(project, 'sub'), { recursive: true })
writeFileSync(join(project, 'file'), 'needle\n')
setCwd(project)
setOriginalCwd(project)
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const permission = (allow: string[] = [], deny: string[] = [], ask: string[] = []) => ({
  ...getEmptyToolPermissionContext(), alwaysAllowRules: { session: allow }, alwaysDenyRules: { session: deny }, alwaysAskRules: { session: ask },
})
const wrap = (script: string, shell = 'bash', flag = '-c') => shellCommandText([shell, flag, script])
try {
  for (const shell of ['bash', 'sh', 'zsh', '/bin/bash', '/usr/bin/sh', '/bin/zsh']) {
    for (const flag of ['-c', '-lc']) {
      const input = { command: wrap('grep needle file && git status', shell, flag) }
      const read = await checkReadOnlyConstraints(input, false)
      const verdict = await bashToolHasPermission(input, permission())
      await prepareBashReadOnly(input)
      check(`${shell} ${flag}: read-only commands are read-only`, read.behavior === 'allow' && preparedBashReadsOnly(input), read)
      check(`${shell} ${flag}: permission preserves the original wrapper`, verdict.behavior === 'allow' && verdict.updatedInput.command === input.command, verdict)
      const denied = await bashToolHasPermission({ command: wrap('rm -rf victim', shell, flag) }, permission(['Bash(*)'], ['Bash(rm *)']))
      check(`${shell} ${flag}: the inner destructive deny wins`, denied.behavior === 'deny', denied)
    }
  }
  for (const script of ['touch output', 'cat < /etc/mercury-shell-proof', 'cd sub && git status', 'cd sub && touch file', 'cd sub && cat < file', 'git log --output=file', 'cat .env', 'rm -rf /', 'sed -i s/a/b/ file']) {
    const bare = await bashToolHasPermission({ command: script }, permission())
    const wrapped = await bashToolHasPermission({ command: wrap(script) }, permission())
    check(`inner safeguards: ${script}`, wrapped.behavior !== 'allow' && (bare.behavior !== 'deny' || wrapped.behavior === 'deny'), { bare, wrapped })
  }
  for (const behavior of ['deny', 'ask'] as const) {
    for (const rule of ['Bash(bash *)', `Bash(${wrap('grep needle file')})`, 'Bash(grep *)']) {
      const result = await bashToolHasPermission({ command: wrap('grep needle file') }, permission(['Bash(*)'], behavior === 'deny' ? [rule] : [], behavior === 'ask' ? [rule] : []))
      check(`${behavior} rule survives: ${rule}`, result.behavior === behavior, result)
    }
  }
  const allowed = await bashToolHasPermission({ command: wrap('custom-command arg') }, permission(['Bash(custom-command *)']))
  check('an inner allow rule covers the wrapped command', allowed.behavior === 'allow', allowed)
  const compound = `${wrap('custom-command one')} && ${wrap('custom-command two')}`
  const asked = await bashToolHasPermission({ command: compound }, permission([`Bash(${compound})`], [], ['Bash(custom-command *)']))
  check('multiple inner asks survive a whole-command allow', asked.behavior === 'ask', asked)
  for (const command of ["bash -c 'cat /etc/mercury-shell-proof' > result", "bash -c 'cat .env' > /dev/null", "bash -c 'cat file' 2>&1"]) {
    const result = await bashToolHasPermission({ command }, permission())
    check(`an output redirect cannot hide unchecked inner paths: ${command}`, result.behavior !== 'allow', result)
  }
  const secret = join(project, 'file')
  const readDenied = await bashToolHasPermission({ command: wrap('cat file') }, permission([], [`Read(/${secret})`]))
  check('inner relative path deny survives', readDenied.behavior === 'deny', readDenied)
  for (const command of ["bash -c 'grep needle file' extra", "bash -c 'grep needle file' > result", "BASH_ENV=payload bash -c 'grep needle file'", "bash -c 'grep $PATTERN file'", 'cmd.exe /c "echo hello"']) {
    check(`unsupported wrapper is not read-only: ${command}`, (await checkReadOnlyConstraints({ command }, false)).behavior !== 'allow')
  }
  for (const command of ['cmd.exe /c "echo hello"', 'cmd /c "echo hello"', `cmd.exe /c "${wrap('grep needle file')}"`]) {
    const read = await checkReadOnlyConstraints({ command }, false)
    check(`the cmd.exe road is not unwrapped: ${command}`, read.behavior !== 'allow' && read.notReadOnly?.word === command.split(' ')[0], read)
  }
  for (const target of ['/', '/etc', '~']) {
    const bare = await bashToolHasPermission({ command: `rm -rf ${target}` }, permission(['Bash(*)']))
    const wrapped = await bashToolHasPermission({ command: wrap(`rm -rf ${target}`) }, permission(['Bash(*)']))
    check(`the removal floor holds inside a wrapper under a whole-tool allow: rm -rf ${target}`, bare.behavior !== 'allow' && wrapped.behavior === bare.behavior && 'message' in wrapped && 'message' in bare && wrapped.message === bare.message, { bare, wrapped })
  }
  const wrapperRule = await bashToolHasPermission({ command: wrap('custom-unknown') }, permission(['Bash(bash -c *)']))
  check('an allow rule written for the wrapper still answers an unlisted inner command', wrapperRule.behavior === 'allow', wrapperRule)
  const wrapperRuleAsk = await bashToolHasPermission({ command: wrap('cat /etc/mercury-shell-proof') }, permission(['Bash(bash -c *)']))
  const bareRuleAsk = await bashToolHasPermission({ command: 'cat /etc/mercury-shell-proof' }, permission(['Bash(cat *)']))
  check('an inner path ask still wins over an allow rule, as it does for the bare command', wrapperRuleAsk.behavior === 'ask' && bareRuleAsk.behavior === 'ask', { wrapperRuleAsk, bareRuleAsk })
  const unanswered = await bashToolHasPermission({ command: wrap('custom-unknown') }, permission())
  const suggested = 'suggestions' in unanswered ? unanswered.suggestions?.flatMap(update => update.type === 'addRules' ? update.rules.map(rule => rule.ruleContent) : []) ?? [] : []
  const saved = await bashToolHasPermission({ command: wrap('custom-unknown') }, permission(suggested.map(content => `Bash(${content})`)))
  check('the rule offered for an unanswered wrapped command allows it once saved', unanswered.behavior === 'passthrough' && suggested.length === 1 && saved.behavior === 'allow', { unanswered, suggested, saved })
  let nested = 'grep needle file'
  for (let depth = 1; depth <= 5; depth++) {
    nested = wrap(nested)
    const result = await checkReadOnlyConstraints({ command: nested }, false)
    const verdict = await bashToolHasPermission({ command: nested }, permission())
    check(`wrapper depth ${depth}`, (result.behavior === 'allow') === (depth <= 4) && (verdict.behavior === 'allow') === (depth <= 4), { result, verdict })
  }
  const pipeline = await bashToolHasPermission({ command: `cd sub | ${wrap('git status')}` }, permission())
  check('a wrapped git command keeps the cross-segment cd guard', pipeline.behavior === 'ask', pipeline)
  const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: any) => bashToolHasPermission(input, context.getAppState().toolPermissionContext) }
  for (const mode of ['default', 'implement', 'dontAsk', 'flow', 'sovereign'] as const) {
    const state = { toolPermissionContext: { ...permission(['Bash(*)'], ['Bash(rm *)']), mode }, tasks: {} }
    const context = { getAppState: () => state, setAppState() {}, abortController: new AbortController(), messages: [], options: {} }
    const result = await decideToolPermissionWithModes(tool as never, { command: wrap('rm -rf victim') }, context as never, { message: { id: 'shell-c-script' } } as never, 'shell-c-script')
    check(`${mode}: wrapped destructive deny survives the full decision chain`, result.decision.behavior === 'deny', result.decision)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`shell-c-script: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
