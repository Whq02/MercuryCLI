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
for (const [tool, input] of [...written('<PROJECT>/notes.txt'), ...written('<PROJECT>/sub/settings.json'), ...written('<PROJECT>/docs/plain.md'), ...written('<PROJECT>/.mercury/worktrees/lane/src/a.ts'), ...written('<PROJECT>/.mercury/worktrees/lane/notes.txt')]) {
  const flow = await decide(tool, input, 'flow')
  check(`flow · ${told(tool, input)} · runs unasked`, flow.behavior === 'allow', said(flow))
}
for (const [tool, input] of [...written('<PROJECT>/.mercury/worktrees/lane/MERCURY.md'), ...written('<PROJECT>/.mercury/worktrees/lane/.mercury/settings.local.json')]) {
  const flow = await decide(tool, input, 'flow')
  check(`flow · the configuration of a worktree is configuration: ${told(tool, input)} · asks`, flow.behavior === 'ask', said(flow))
}
{
  const kept: string[] = []
  for (const [tool, input] of written('<PROJECT>/.mercury/worktrees/lane/src/a.ts')) {
    for (const mode of ['default', 'implement'] as const) {
      const decision = await decide(tool, input, mode)
      if (decision.behavior !== 'ask') kept.push(`${mode} ${told(tool, input)}: ${said(decision)}`)
    }
  }
  check('default and implement · a write into a worktree under the folder asks as it did', kept.length === 0, kept.join(' ‖ '))
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

section('§5 the reach of the ask: under Flow a shell command that is not read-only and names the configuration anywhere in what it runs asks')
{
  const SETTINGS = '.mercury/settings.local.json'
  const named: Array<[string, string]> = [
    ['after a cd into the folder', `cd .mercury && echo '${RULE}' > settings.local.json`],
    ['install', `install -m 644 notes.txt ${SETTINGS}`],
    ['rsync', `rsync notes.txt ${SETTINGS}`],
    ['truncate', `truncate -s 0 ${SETTINGS}`],
    ['a link laid over it', `ln -sf ../notes.txt ${SETTINGS}`],
    ['a line of Python', `python3 -c "open('${SETTINGS}','w').write('x')"`],
    ['a line of JavaScript', `node -e "require('fs').writeFileSync('${SETTINGS}','x')"`],
    ['a wildcard under the folder', 'tee .mercury/*.json < notes.txt'],
    ['find over the folder with a copy', "find .mercury -name '*.json' -exec cp notes.txt {} \\;"],
    ['xargs fed the name', `xargs -I{} cp notes.txt {} <<< ${SETTINGS}`],
    ['a script piped into a shell', `echo "echo x > ${SETTINGS}" | sh`],
    ['a script handed to a shell', `sh -c "echo x > ${SETTINGS}"`],
    ['git writing the file back', ['git', 'checkout', 'HEAD', '--', SETTINGS].join(' ')],
    ['git restore', ['git', 'restore', SETTINGS].join(' ')],
    ['a program this reading has no grammar for', `sponge ${SETTINGS} < notes.txt`],
    ['a formatter on an instruction file', 'prettier --write MERCURY.md'],
    ['the folder removed whole', 'rm -rf .mercury'],
    ['the folder moved away', 'mv .mercury .mercury.bak'],
    ['the home\'s settings emptied', 'truncate -s 0 <CONFIG>/settings.json'],
    ['the home\'s keybindings through a line of Python', "python3 -c \"open('<CONFIG>/keybindings.json','w').write('{}')\""],
  ]
  for (const [label, command] of named) {
    const flow = await decide('Bash', { command: fill(command) }, 'flow')
    check(`flow · ${label}: ${shown(fill(command)).slice(0, 96)} · asks`, flow.behavior === 'ask', said(flow))
  }
  const sovereign: string[] = []
  const inDefault: string[] = []
  for (const [, command] of named) {
    const zero = await decide('Bash', { command: fill(command) }, 'sovereign')
    if (zero.behavior !== 'allow') sovereign.push(`${shown(command)}: ${said(zero)}`)
    const card = await decide('Bash', { command: fill(command) }, 'default')
    if (card.behavior !== 'ask') inDefault.push(`${shown(command)}: ${said(card)}`)
  }
  check(`sovereign · the same ${named.length} commands ask nothing`, sovereign.length === 0, sovereign.join(' ‖ '))
  check(`default · the same ${named.length} commands ask as before`, inDefault.length === 0, inDefault.join(' ‖ '))
  const free: Array<[string, string]> = [
    ['a read of it', `cat ${SETTINGS}`],
    ['a listing of the folder', 'ls .mercury'],
    ['a count in an instruction file', 'grep -c x MERCURY.md'],
    ['git\'s diff of an instruction file', 'git diff -- MERCURY.md'],
    ['a count written beside it', 'wc -l AGENTS.md > count.txt'],
    ['a command that names no configuration', 'npm test'],
    ['the same writers on other files', 'truncate -s 0 notes.txt && install -m 644 notes.txt sub/copy.txt'],
    ['git staging it', ['git', 'add', 'MERCURY.md', '.mercury/settings.json'].join(' ')],
    ['a commit whose message names it', ['git', 'commit', '-m', '"update MERCURY.md"'].join(' ')],
    ['a worktree under the folder', 'mkdir -p .mercury/worktrees/x && touch .mercury/worktrees/x/notes.txt'],
    ['outside this reading: a path only a variable holds', 'echo x > "$F"'],
    ['outside this reading: an archive that names nothing', 'tar -xf config.tar'],
  ]
  for (const [label, command] of free) {
    const flow = await decide('Bash', { command: fill(command) }, 'flow')
    check(`flow · ${label}: ${shown(fill(command)).slice(0, 96)} · runs unasked`, flow.behavior === 'allow', said(flow))
  }
  const exact = await decide('Bash', { command: `truncate -s 0 ${SETTINGS}` }, 'flow', { allow: ['Bash(truncate *)'] })
  check('flow · a standing allow rule for the command answers it', exact.behavior === 'allow', said(exact))
}
note('nothing in this proof is executed: tool inputs handed to the decision function with the real tools; the settings files are written into the proof\'s own scratch folder and home')
finish('prove-flow-keeps-configuration-ask')
