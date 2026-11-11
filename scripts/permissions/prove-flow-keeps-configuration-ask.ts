#!/usr/bin/env bun
import { check, decide, fill, finish, note, pageText, said, section, shown, type Rules } from './floorsKit.ts'

type Call = [tool: string, input: Record<string, unknown>]
const RULE = JSON.stringify({ guardrails: { allow: ['Bash(ls *)'] } })
const written = (path: string): Call[] => [
  ['Write', { file_path: fill(path), content: RULE }],
  ['Bash', { command: `echo '${RULE}' > ${fill(path)}` }],
  ['Bash', { command: `cp notes.txt ${fill(path)}` }],
]
const CONFIGURATION = [
  '<PROJECT>/.mercury/settings.local.json', '<PROJECT>/.mercury/settings.json', '<CONFIG>/settings.json',
  '<PROJECT>/.mercury/wards.json', '<PROJECT>/.mercury/mcp.json', '<PROJECT>/.mercury/keybindings.json', '<CONFIG>/keybindings.json',
  '<PROJECT>/MERCURY.md', '<PROJECT>/AGENTS.md',
]
const told = (tool: string, input: Record<string, unknown>): string => (tool === 'Bash' ? shown(String(input.command)).slice(0, 110) : `${tool} ${shown(String(input.file_path))}`)

section('the page, docs/TRUST.md')
check('sensitive files, such as credentials and Mercury configuration, retain their own permission checks', /Sensitive files, such as credentials and Mercury configuration, retain their own permission checks/.test(pageText()))

section('§1 under Flow a write to Mercury\'s own configuration keeps its ask, by a file tool and by a shell write alike')
for (const path of CONFIGURATION) {
  for (const [tool, input] of written(path)) {
    const flow = await decide(tool, input, 'flow')
    check(`flow · ${told(tool, input)} · asks`, flow.behavior === 'ask', said(flow))
  }
}

section('§2 the modes beside it: Default and Implement ask as before, Sovereign asks nothing')
for (const path of CONFIGURATION) {
  const wrong: string[] = []
  for (const [tool, input] of written(path)) {
    for (const [mode, behavior] of [['default', 'ask'], ['implement', 'ask'], ['sovereign', 'allow']] as const) {
      const decision = await decide(tool, input, mode)
      if (decision.behavior !== behavior) wrong.push(`${mode} ${told(tool, input)}: ${said(decision)}`)
    }
  }
  check(`${shown(fill(path))} · default and implement ask, sovereign allows, by the file tool and by both shell writes`, wrong.length === 0, wrong.join(' ‖ '))
}

section('§3 the ask reaches no further than the configuration')
for (const [tool, input] of [...written('<PROJECT>/notes.txt'), ...written('<PROJECT>/sub/settings.json'), ...written('<PROJECT>/docs/plain.md')]) {
  const flow = await decide(tool, input, 'flow')
  check(`flow · ${told(tool, input)} · runs unasked`, flow.behavior === 'allow', said(flow))
}
{
  const exact: Rules = { allow: ['Edit(.mercury/wards.json)'] }
  const granted = await decide('Write', { file_path: fill('<PROJECT>/.mercury/wards.json'), content: '{}' }, 'flow', exact)
  check('flow · a rule that names the file exactly grants the write', granted.behavior === 'allow', said(granted))
  const other = await decide('Write', { file_path: fill('<PROJECT>/.mercury/mcp.json'), content: '{}' }, 'flow', exact)
  check('flow · that rule reaches its own file alone', other.behavior === 'ask', said(other))
}

section('§4 a rule that arrives by a settings change while the session runs answers none of Flow\'s five until the next session')
{
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  const { applySettingsChange } = await import('../../src/utils/settings/applySettingsChange.ts')
  const { initializeToolPermissionContext } = await import('../../src/utils/permissions/permissionSetup.ts')
  const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
  const { applyPermissionUpdates, persistPermissionUpdates } = await import('../../src/utils/permissions/PermissionUpdate.ts')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
  type Answer = { behavior: string; message?: string }
  type State = { toolPermissionContext: Record<string, unknown> }
  setSessionTrustAccepted(true)
  const PUSH = ['git', 'push', 'origin', 'main'].join(' ')
  const PUSH_RULE = 'Bash(git push *)'
  const local = fill('<PROJECT>/.mercury/settings.local.json')
  const user = fill('<CONFIG>/settings.json')
  const put = (file: string, allow: string[]): void => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ guardrails: { allow } }))
  }
  const session = async () => {
    resetSettingsCache()
    const boot = await initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode: 'flow', allowDangerouslySkipPermissions: false } as never)
    const state: State = { toolPermissionContext: { ...(boot.toolPermissionContext as unknown as Record<string, unknown>), mode: 'flow' } }
    const judge = async (command: string, mode = 'flow'): Promise<Answer> => {
      const seen = { toolPermissionContext: { ...state.toolPermissionContext, mode } }
      const use = { abortController: new AbortController(), getAppState: () => seen, setAppState: () => {}, messages: [], options: { tools: [] }, readFileState: new Map() } as never
      return (await decideToolPermissionWithModes(BashTool as never, { command } as never, use, { message: { id: 'flow-start' } } as never, 'flow-start')).decision as Answer
    }
    const changed = (source: string): void => {
      resetSettingsCache()
      applySettingsChange(source as never, ((updater: (previous: State) => State) => { Object.assign(state, updater(state)) }) as never)
    }
    const inForce = (): string => JSON.stringify(state.toolPermissionContext.alwaysAllowRules)
    return { state, judge, changed, inForce }
  }
  const told = (answer: Answer): string => `${answer.behavior}${answer.message ? `: ${answer.message.slice(0, 140)}` : ''}`
  check('the page says which allow rules answer one of the five', /An allow rule answers one of the five ahead of the\s+ask only if it stood when the session started or you granted it in this\s+session; a rule that arrives by a settings change while the session runs\s+answers none of the five until the next session\./.test(pageText()))

  put(user, [])
  put(local, [])
  const first = await session()
  const before = await first.judge(PUSH)
  check('control · a Flow session with no rule: the push asks', before.behavior === 'ask' && /Flow asks before git push/.test(before.message ?? ''), told(before))
  const buildBefore = await first.judge('npm run build', 'default')
  check('control · the same session in Default: npm run build asks', buildBefore.behavior === 'ask', told(buildBefore))
  put(local, [PUSH_RULE, 'Bash(npm run build *)'])
  first.changed('localSettings')
  const after = await first.judge(PUSH)
  check('with a rule for the push written into the folder\'s settings.local.json and the settings change applied, the push still asks', after.behavior === 'ask' && /Flow asks before git push/.test(after.message ?? ''), `${told(after)} · allow rules in force: ${first.inForce()}`)
  check('that rule is in force all the same: the change brought it into the session', first.inForce().includes(PUSH_RULE), first.inForce())
  const buildAfter = await first.judge('npm run build', 'default')
  check('every other effect of the change is live: the build rule that arrived with it answers in Default', buildAfter.behavior === 'allow', told(buildAfter))
  put(user, ['Bash(git push origin *)'])
  first.changed('userSettings')
  const fromHome = await first.judge(PUSH)
  check('a rule for the push that arrives in the home\'s settings.json answers none of the five either', fromHome.behavior === 'ask', `${told(fromHome)} · ${first.inForce()}`)
  const grant = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push *' }], behavior: 'allow', destination: 'localSettings' }] as never
  persistPermissionUpdates(grant)
  first.state.toolPermissionContext = applyPermissionUpdates(first.state.toolPermissionContext as never, grant) as never
  const grantedNow = await first.judge(PUSH)
  check('a rule the user grants on a card in this session answers the push from then on', grantedNow.behavior === 'allow', told(grantedNow))
  first.changed('localSettings')
  const grantedStill = await first.judge(PUSH)
  check('and the settings change its own write causes leaves it answering', grantedStill.behavior === 'allow', told(grantedStill))

  put(user, [])
  put(local, [PUSH_RULE])
  const next = await session()
  const nextSession = await next.judge(PUSH)
  check('the next session reads the rule as it stands at its start: the push runs unasked', nextSession.behavior === 'allow', `${told(nextSession)} · ${next.inForce()}`)
  put(local, [])
  next.changed('localSettings')
  put(local, [PUSH_RULE])
  next.changed('localSettings')
  const returned = await next.judge(PUSH)
  check('a rule taken out and put back while the session runs arrives by a settings change: the push asks', returned.behavior === 'ask', `${told(returned)} · ${next.inForce()}`)
  put(local, [])
  put(user, [])
  resetSettingsCache()
}
note('nothing in this proof is executed: tool inputs handed to the decision function with the real tools; the settings files are written into the proof\'s own scratch folder and home')
finish('prove-flow-keeps-configuration-ask')
