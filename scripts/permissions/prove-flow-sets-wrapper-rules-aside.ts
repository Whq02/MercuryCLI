#!/usr/bin/env bun
import { check, fill, finish, note, pageText, section } from './floorsKit.ts'

const { mkdirSync, writeFileSync } = await import('node:fs')
const { dirname } = await import('node:path')
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const setup = await import('../../src/utils/permissions/permissionSetup.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { MonitorTool } = await import('../../src/tools/MonitorTool/MonitorTool.ts')
const { permissionRuleValueFromString, permissionRuleValueToString } = await import('../../src/utils/permissions/permissionRuleParser.ts')

type Maps = { mode: string; alwaysAllowRules: Record<string, string[] | undefined>; strippedDangerousRules?: Record<string, string[]> }
type Answer = { behavior: string; message?: string }
const PUSH = ['git', 'push', 'origin', 'main'].join(' ')
const told = (answer: Answer): string => `${answer.behavior}${answer.message ? `: ${answer.message.slice(0, 140)}` : ''}`
const contextWith = (allow: string[]): Maps => ({ ...(getEmptyToolPermissionContext() as unknown as Maps), mode: 'flow', alwaysAllowRules: { userSettings: allow } })
const aside = (written: string): { kept: boolean; stashed: boolean; back: boolean } => {
  const rule = permissionRuleValueToString(permissionRuleValueFromString(written))
  const stripped = setup.stripDangerousPermissionsForFlow(contextWith([rule, 'Read(docs/**)']) as never) as unknown as Maps
  const restored = setup.restoreDangerousPermissions(stripped as never) as unknown as Maps
  return {
    kept: (stripped.alwaysAllowRules.userSettings ?? []).includes(rule),
    stashed: (stripped.strippedDangerousRules?.userSettings ?? []).includes(rule),
    back: (restored.alwaysAllowRules.userSettings ?? []).includes(rule),
  }
}

section('the page, docs/TRUST.md')
check('broad dangerous allow rules are set aside while Flow is on', /Broad\s+dangerous\s+allow\s+rules\s+are\s+set\s+aside\s+while\s+Flow\s+is\s+on/.test(pageText()))

section('§1 an allow rule whose program runs another program is set aside while Flow is on, and comes back when Flow is left')
for (const rule of ['Bash(nice *)', 'Bash(timeout *)', 'Bash(timeout 5 *)', 'Bash(nohup *)', 'Bash(command *)', 'Bash(find *)', 'Bash(time *)', 'Bash(stdbuf *)', 'Bash(setsid *)', 'Bash(watch *)', 'Bash(flock *)', 'Bash(nice)', 'Bash(nice*)']) {
  const read = aside(rule)
  check(`${rule} · set aside under Flow, back when Flow is left`, !read.kept && read.stashed && read.back, JSON.stringify(read))
}

section('§2 a whole-tool allow of a tool that starts programs is set aside the same way')
for (const rule of ['Monitor', 'Service', 'Journey', 'Debug', 'Eval', 'Launch', 'Test', 'Monitor(*)', 'Monitor(nice *)', 'Monitor(bash *)']) {
  const read = aside(rule)
  check(`${rule} · set aside under Flow, back when Flow is left`, !read.kept && read.stashed && read.back, JSON.stringify(read))
}

section('§3 a rule that names what it allows stays in force')
for (const rule of ['Bash(git push *)', 'Bash(git *)', 'Bash(npm test *)', 'Bash(find src -name notes.txt)', 'Bash(timeout 5 npm test)', 'Monitor(npm run dev)', 'Service(start web)', 'Read(docs/**)', 'Edit(src/**)', 'WebFetch']) {
  const read = aside(rule)
  check(`${rule} · stays in force under Flow`, read.kept && !read.stashed, JSON.stringify(read))
}

section('§4 a Flow session booted with such a rule: the push behind the wrapper asks')
{
  setSessionTrustAccepted(true)
  const user = fill('<CONFIG>/settings.json')
  const boot = async (allow: string[]): Promise<(tool: unknown, input: Record<string, unknown>) => Promise<Answer>> => {
    mkdirSync(dirname(user), { recursive: true })
    writeFileSync(user, JSON.stringify({ guardrails: { allow } }))
    resetSettingsCache()
    const init = await setup.initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode: 'flow', allowDangerouslySkipPermissions: false } as never)
    const context = init.dangerousPermissions.length > 0 ? setup.stripDangerousPermissionsForFlow(init.toolPermissionContext) : init.toolPermissionContext
    const state = { toolPermissionContext: { ...(context as unknown as Record<string, unknown>), mode: 'flow' } }
    return async (tool, input) => {
      const use = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: { tools: [] }, readFileState: new Map() } as never
      return (await decideToolPermissionWithModes(tool as never, input as never, use, { message: { id: 'flow-wrappers' } } as never, 'flow-wrappers')).decision as Answer
    }
  }
  for (const [rule, command] of [['Bash(nice *)', `nice ${PUSH}`], ['Bash(timeout *)', `timeout 60 ${PUSH}`], ['Bash(nohup *)', `nohup ${PUSH}`], ['Bash(command *)', `command ${PUSH}`], ['Bash(find *)', `find . -maxdepth 0 -exec ${PUSH} ;`]] as const) {
    const judge = await boot([rule])
    const answer = await judge(BashTool, { command })
    check(`${rule} in the home's settings · ${command} · Flow asks before the push`, answer.behavior === 'ask' && /Flow asks before git push/.test(answer.message ?? ''), told(answer))
  }
  {
    const judge = await boot(['Monitor'])
    const answer = await judge(MonitorTool, { command: PUSH, description: 'watch the push' })
    check('a whole-tool allow of Monitor · a push handed to Monitor · Flow asks before the push', answer.behavior === 'ask' && /Flow asks before git push/.test(answer.message ?? ''), told(answer))
  }
  {
    const judge = await boot(['Bash(git push *)'])
    const answer = await judge(BashTool, { command: PUSH })
    check('control · a rule that names the push answers it, as the page says', answer.behavior === 'allow', told(answer))
    const plain = await judge(BashTool, { command: 'nice npm test' })
    check('control · nice npm test runs unasked under Flow with no rule for it', plain.behavior === 'allow', told(plain))
  }
  writeFileSync(user, JSON.stringify({}))
  resetSettingsCache()
}
note('nothing in this proof is executed: rules handed to the functions that set them aside, and tool inputs handed to the decision function with the real tools')
finish('prove-flow-sets-wrapper-rules-aside')
