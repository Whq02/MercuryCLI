#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'hook-match-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'hook-match-proj-')))
const OTHER = realpathSync(mkdtempSync(join(tmpdir(), 'hook-match-other-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — fix: ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { setIsInteractive, setSessionTrustAccepted, setProjectRoot, setOriginalCwd, registerHookCallbacks, clearRegisteredExtensionHooks } = await import('../../src/bootstrap/state.js')
const { setCwd } = await import('../../src/utils/Shell.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { captureHooksSnapshot, refreshHooksSnapshot, hooksDisabled, managedHooksOnly } = await import('../../src/utils/hooks/hooksConfigSnapshot.js')
const { matchHooks, hasHooksFor, markHookSpent, forgetSpentHooks, matchesPattern } = await import('../../src/utils/hooks/matching.js')
const { addSessionHooks, removeSessionHooks, sessionHooksFor, pruneSkillSessionHooks } = await import('../../src/utils/hooks/sessionHooks.js')
const { registerAgentHooks, registerSkillHooks } = await import('../../src/utils/hooks/registerFrontmatterHooks.js')
const { listHooks } = await import('../../src/utils/hooks/hooksSettings.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { setPathTrusted } = await import('../../src/utils/config/trust.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

setCwd(PROJ)
setOriginalCwd(PROJ)
setProjectRoot(PROJ)
setIsInteractive(false)
setSessionTrustAccepted(true)
mkdirSync(join(PROJ, '.mercury'), { recursive: true })

const USER = join(HOME, 'settings.json')
const PROJECT = join(PROJ, '.mercury', 'settings.json')
const LOCAL = join(PROJ, '.mercury', 'settings.local.json')
const write = (path: string, settings: unknown): void => writeFileSync(path, JSON.stringify(settings))
const reload = (): void => {
  resetSettingsCache()
  refreshHooksSnapshot()
}

const appState = getDefaultAppState()
const setAppState = (updater: (prev: typeof appState) => typeof appState): void => {
  updater(appState)
}
const scope = { sessionId: 'session-1' }
const base = { session_id: 'session-1', transcript_path: '/t.jsonl', cwd: PROJ }
const toolPayload = (tool: string) => ({ ...base, event: 'tool.before' as const, tool, input: {}, call_id: 'c1' })
const runs = (hooks: ReadonlyArray<{ entry: { run?: string } }>): string => hooks.map(h => h.entry.run).join(',')
const sources = (hooks: ReadonlyArray<{ source: { kind: string; layer?: string } }>): string => hooks.map(h => (h.source.kind === 'settings' ? h.source.layer : h.source.kind)).join(',')

section('§1 the match: names, a pipe list, a regular expression, everything')
{
  write(USER, { events: { hooks: { 'tool.before': [
    { match: 'Bash', run: 'names' },
    { match: 'Read|Edit', run: 'pipe' },
    { match: '^mcp__', run: 'regex' },
    { run: 'everything' },
    { match: '*', run: 'star' },
  ] } } })
  reload()
  check('Bash matches the name, the everything entries, not the pipe or the regex', runs(await matchHooks('tool.before', toolPayload('Bash'), scope)) === 'names,everything,star', '', 'matchHooks in src/utils/hooks/matching.ts must select a name matcher, the match-less entry and the star entry for Bash')
  check('Edit matches the pipe list', runs(await matchHooks('tool.before', toolPayload('Edit'), scope)) === 'pipe,everything,star', '', 'matchesPattern in src/utils/hooks/matching.ts must treat Read|Edit as a pipe list of tool names')
  check('mcp__x matches the regular expression', runs(await matchHooks('tool.before', toolPayload('mcp__x'), scope)) === 'regex,everything,star', '', 'matchesPattern in src/utils/hooks/matching.ts must treat a ^-anchored matcher as a regular expression')
  check('matchesPattern: the LSP family name covers the LSP tools', (await matchesPattern('LspRead', 'LSP')) && !(await matchesPattern('LspRead', '^LSP$')), '', 'matchesPattern in src/utils/hooks/matching.ts must let the LSP family name cover LSP tools while an anchored regex stays exact')
  check('an empty pipe-list member never widens a name matcher', !(await matchesPattern('Bash', 'Read|')) && (await matchesPattern('Read', 'Read|')), '', 'matchesPattern in src/utils/hooks/matching.ts must drop empty pipe-list members')
  check('hasHooksFor answers the cheap question', hasHooksFor('tool.before', scope) && !hasHooksFor('turn.end', scope), '', 'hasHooksFor in src/utils/hooks/matching.ts must be true only for events that have hooks in scope')
}

section("§1b a permission rule in the match reads the call's arguments: a shell tool's command, a file tool's path")
{
  write(USER, { events: { hooks: { 'tool.before': [
    { match: 'Bash(git *)', run: 'git-only' },
    { match: 'Bash(git status)', run: 'exact-status' },
    { match: 'Edit(src/**)', run: 'src-edits' },
    { match: 'Edit(*.rs)|Write(*.rs)', run: 'rust-writes' },
    { match: 'Bash(*)', run: 'any-bash' },
    { match: 'Bash', run: 'bash-name' },
  ] } } })
  reload()
  const call = (tool: string, input: Record<string, unknown>) => ({ ...base, event: 'tool.before' as const, tool, input, call_id: 'c1' })
  const bash = async (command: string): Promise<string> => runs(await matchHooks('tool.before', call('Bash', { command }), scope))
  const file = async (tool: string, file_path: string): Promise<string> => runs(await matchHooks('tool.before', call(tool, { file_path }), scope))
  check('Bash(git *) fires for git status and for git -C /x log; Bash(git status) for the exact command only', (await bash('git status')) === 'git-only,exact-status,any-bash,bash-name' && (await bash('git -C /x log')) === 'git-only,any-bash,bash-name', `${await bash('git status')} / ${await bash('git -C /x log')}`, 'matchesPattern in src/utils/hooks/matching.ts must read the command of a Bash(...) rule with glob matching on subcommands')
  check('…and neither fires for ls: the hook is not run, only the name matchers are', (await bash('ls')) === 'any-bash,bash-name', await bash('ls'), 'matchesPattern in src/utils/hooks/matching.ts must not fire Bash(git *) for a command that is not git')
  check('a compound command matches any subcommand: cd x && git push is git *', (await bash('cd x && git push')) === 'git-only,any-bash,bash-name', await bash('cd x && git push'), 'matchesPattern in src/utils/hooks/matching.ts must test each subcommand of a compound command')
  check('Edit(src/**) fires for src/a.ts under the project, absolute or relative, and not for docs/b.md', (await file('Edit', join(PROJ, 'src/a.ts'))) === 'src-edits' && (await file('Edit', 'src/a.ts')) === 'src-edits' && (await file('Edit', join(PROJ, 'docs/b.md'))) === '', `${await file('Edit', join(PROJ, 'src/a.ts'))} / ${await file('Edit', 'src/a.ts')} / ${await file('Edit', join(PROJ, 'docs/b.md'))}`, 'matchesPattern in src/utils/hooks/matching.ts must match an Edit(path-glob) rule against the file path, absolute or relative to the project')
  check('Edit(*.rs)|Write(*.rs) fires for a .rs file through either tool; a Write of a .ts file fires neither clause', (await file('Edit', join(PROJ, 'src/lib.rs'))) === 'src-edits,rust-writes' && (await file('Write', join(PROJ, 'x/main.rs'))) === 'rust-writes' && (await file('Write', join(PROJ, 'src/x.ts'))) === '', `${await file('Edit', join(PROJ, 'src/lib.rs'))} / ${await file('Write', join(PROJ, 'x/main.rs'))} / ${await file('Write', join(PROJ, 'src/x.ts'))}`, 'matchesPattern in src/utils/hooks/matching.ts must test each pipe clause of Edit(*.rs)|Write(*.rs) against its own tool and path')
  check('matchesPattern reads the arguments it is handed, and a rule on one tool never claims another', (await matchesPattern('Bash', 'Bash(git *)', { command: 'git push' })) && !(await matchesPattern('Bash', 'Bash(git *)', { command: 'npm test' })) && !(await matchesPattern('Edit', 'Bash(git *)', { command: 'git push' })) && !(await matchesPattern('Bash', 'Bash(git *)')), '', 'matchesPattern in src/utils/hooks/matching.ts must read the input it is given, never match a rule across tools, and fail a rule with no input')
  check('a regex keeps its regex meaning: ^(Read|Edit)$ names the tool and is no rule', (await matchesPattern('Read', '^(Read|Edit)$')) && !(await matchesPattern('Bash', '^(Read|Edit)$')), '', 'matchesPattern in src/utils/hooks/matching.ts must keep regex meaning for a pattern that starts with ^')
}

section('§1c a push matcher sees compound subcommands, not quoted text or unrelated commands')
{
  write(USER, { events: { hooks: { 'tool.before': [{ match: 'Bash(git push *)', run: 'push' }] } } })
  reload()
  for (const [command, expected] of [
    ['cd x && git push', 'push'], ['git status || git push origin main', 'push'],
    ['git status; git push', 'push'], ['git status\ngit push', 'push'],
    ['git status | git push', 'push'], ['git status && ls', ''],
    ['echo "cd x && git push"', ''], ["printf '%s' 'git push'", ''],
  ]) {
    const payload = { ...toolPayload('Bash'), input: { command } }
    check(`${JSON.stringify(command)} selects ${expected || 'no hook'}`, runs(await matchHooks('tool.before', payload, scope)) === expected, '', 'matchesPattern in src/utils/hooks/matching.ts must split a compound Bash command into subcommands and ignore quoted text')
  }
  check('an exact rule also matches a subcommand', (await matchesPattern('Bash', 'Bash(git push)', { command: 'cd x && git push' })), '', 'matchesPattern in src/utils/hooks/matching.ts must match an exact Bash rule against each subcommand')
  const { pinnedCommandAnalysis } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
  const parsePowerShell = pinnedCommandAnalysis.parsePowerShellCommand
  const seen: string[] = []
  pinnedCommandAnalysis.parsePowerShellCommand = Object.assign(async (command: string) => {
    seen.push(command)
    return { valid: true, variables: [], errors: [], hasStopParsing: false, originalCommand: command, statements: [{ statementType: 'PipelineAst', text: command, nestedCommands: [], redirections: [], commands: (command.startsWith('Set-Location') ? ['Set-Location x', 'git push origin main'] : [command]).map(text => ({ name: text.split(' ')[0]!, text, nameType: 'application' as const, args: [], elementType: 'CommandAst' })) }] }
  }, { cache: parsePowerShell.cache })
  try {
    check('PowerShell uses its permission parser for subcommands', await matchesPattern('PowerShell', 'PowerShell(git push *)', { command: 'Set-Location x; git push origin main' }), '', 'matchesPattern in src/utils/hooks/matching.ts must split a PowerShell command through parsePowerShellCommand from src/utils/permissions/decision/commandAnalysis.ts')
    check('PowerShell quoted command text is not a subcommand', !await matchesPattern('PowerShell', 'PowerShell(git push *)', { command: 'Write-Output "git push"' }), '', 'matchesPattern in src/utils/hooks/matching.ts must not treat quoted PowerShell text as a subcommand')
    check('both PowerShell calls reached the existing parser', seen.join('|') === 'Set-Location x; git push origin main|Write-Output "git push"', seen.join('|'), 'matchesPattern in src/utils/hooks/matching.ts must call the permission parser parsePowerShellCommand once per PowerShell command')
  } finally {
    pinnedCommandAnalysis.parsePowerShellCommand = parsePowerShell
  }
}

section('§1d permission matcher families: crewmate type, fetch domain and MCP server')
{
  write(USER, { events: { hooks: { 'tool.before': [
    { match: 'Crewmate(mercury-scout)', run: 'scout' },
    { match: 'WebFetch(domain:example.com)', run: 'site' },
    { match: 'WebFetch(domain:*.example.com)', run: 'subdomain' },
    { match: 'mcp__files', run: 'server' },
    { match: 'mcp__files__*', run: 'server-star' },
    { match: 'mcp__files__read', run: 'read' },
  ] } } })
  reload()
  for (const [tool, input, expected] of [
    ['Crewmate', { crewmate_type: 'mercury-scout' }, 'scout'],
    ['Crewmate', { crewmate_type: 'mercury-builder' }, ''],
    ['Crewmate', {}, ''],
    ['WebFetch', { url: 'https://example.com/page' }, 'site'],
    ['WebFetch', { url: 'https://docs.example.com:8443/page' }, 'subdomain'],
    ['WebFetch', { url: 'https://example.com.evil.test/page' }, ''],
    ['WebFetch', { url: 'https://example.com@evil.test/page' }, ''],
    ['WebFetch', { url: 'not a URL' }, ''],
    ['mcp__files__read', {}, 'server,server-star,read'],
    ['mcp__files__write', {}, 'server,server-star'],
    ['mcp__files_other__read', {}, ''],
    ['mcp__other__read', {}, ''],
  ] as Array<[string, Record<string, unknown>, string]>) {
    check(`${tool} ${JSON.stringify(input)} selects ${expected || 'no hook'}`, runs(await matchHooks('tool.before', { ...toolPayload(tool), input }, scope)) === expected, '', 'matchesPattern in src/utils/hooks/matching.ts must support the Crewmate(type), WebFetch(domain:...) and mcp__server matcher families')
  }
  check('new matcher families join existing rule clauses', (await matchesPattern('WebFetch', 'Crewmate(mercury-scout)|WebFetch(domain:example.com)|mcp__files__*', { url: 'https://example.com/' })) && (await matchesPattern('mcp__files__write', 'Crewmate(mercury-scout)|WebFetch(domain:example.com)|mcp__files__*')), '', 'matchesPattern in src/utils/hooks/matching.ts must accept the new matcher families as clauses of a pipe list')
  check('an omitted crewmate type matches the launch default', await matchesPattern('Crewmate', 'Crewmate(mercury-crew)', {}), '', 'matchesPattern in src/utils/hooks/matching.ts must read an omitted crewmate_type as the launch default mercury-crew')
  check('an anchored MCP regex retains regex semantics', !(await matchesPattern('mcp__files__read', '^mcp__files$')), '', 'matchesPattern in src/utils/hooks/matching.ts must keep regex semantics for an anchored mcp__ pattern')
  check('Crewmate types are exact, not a glob', !(await matchesPattern('Crewmate', 'Crewmate(mercury-*)', { crewmate_type: 'mercury-scout' })), '', 'matchesPattern in src/utils/hooks/matching.ts must compare Crewmate(type) exactly, with no glob')
}

section('§2 the layers: every layer runs, an identical entry runs once, the later layer is its source')
{
  write(USER, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'shared' }, { match: 'Bash', run: 'user-only' }] } } })
  write(PROJECT, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'shared' }, { match: 'Bash', run: 'project-only' }] } } })
  write(LOCAL, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'local-only' }] } } })
  reload()
  const matched = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('user, project and local entries all run; the identical entry runs once', runs(matched) === 'user-only,shared,project-only,local-only', runs(matched), 'matchHooks and dedupeHooks in src/utils/hooks/matching.ts must run every layer and collapse an identical entry to one')
  check('the identical entry carries the later layer as its source', sources(matched) === 'user,project,project,local', sources(matched), 'dedupeHooks in src/utils/hooks/matching.ts must keep the later layer as the source of a collapsed entry')
  check('the ids are stable across reads', JSON.stringify(matched.map(h => h.id)) === JSON.stringify((await matchHooks('tool.before', toolPayload('Bash'), scope)).map(h => h.id)), '', 'hookId in src/utils/hooks/matching.ts must be derived from the hook identity only, not from read order or time')
  check('listHooks lists the same hooks with their sources for /hooks', listHooks(appState, 'session-1').filter(r => r.event === 'tool.before').length === 4, '', 'listHooks in src/utils/hooks/hooksSettings.ts must list the same four deduplicated hooks as matchHooks')
}

section('§3 once is once per session, in memory; the settings file is never edited')
{
  write(USER, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'one-shot', once: true }, { match: 'Bash', run: 'always' }] } } })
  rmSync(PROJECT)
  rmSync(LOCAL)
  reload()
  const before = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('both hooks match before the one-shot ran', runs(before) === 'one-shot,always', runs(before), 'matchHooks in src/utils/hooks/matching.ts must return a once entry until markHookSpent marks it')
  const raw = JSON.stringify(JSON.parse(String(Bun.file(USER).size > 0 ? await Bun.file(USER).text() : '{}')))
  markHookSpent(before[0]!.id, scope)
  const after = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('after it ran, the one-shot stands down for the rest of the session', runs(after) === 'always', runs(after), 'markHookSpent in src/utils/hooks/matching.ts must make matchHooks skip that hook for the rest of the session')
  check('another session still gets it', runs(await matchHooks('tool.before', toolPayload('Bash'), { sessionId: 'session-2' })) === 'one-shot,always', '', 'the spent set in src/utils/hooks/matching.ts must be keyed by session id')
  check('the settings file is byte-identical: Mercury never edits it', JSON.stringify(JSON.parse(await Bun.file(USER).text())) === raw, '', 'markHookSpent in src/utils/hooks/matching.ts must keep once state in memory and never write the settings file')
  forgetSpentHooks()
}

section('§4 extensions, skills and agents are their own sources; an agent\'s hooks fire on its crewmate only')
{
  write(USER, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'from-settings' }] } } })
  reload()
  clearRegisteredExtensionHooks()
  registerHookCallbacks({ 'tool.before': [{ hooks: [{ match: 'Bash', run: 'from-settings' }, { run: 'from-extension' }], extensionName: 'ext', extensionRoot: '/ext/root', extensionId: 'ext-id' }] } as never)
  writeFileSync(join(PROJ, 'SKILL.md'), '# lint\n')
  registerSkillHooks(setAppState, scope, { 'tool.before': [{ run: 'from-skill' }] }, { name: 'lint', root: PROJ })
  registerAgentHooks(setAppState, { sessionId: 'session-1', crewmateId: 'crew-1' }, { 'tool.before': [{ run: 'from-agent' }], 'turn.answer': [{ question: 'done?' }] }, 'verifier')
  const main = await matchHooks('tool.before', toolPayload('Bash'), scope, { appState })
  check('the main thread runs the settings, extension and skill hooks, never the agent\'s', runs(main) === 'from-settings,from-settings,from-extension,from-skill', runs(main), 'hooksFor in src/utils/hooks/matching.ts and sessionHooksFor in src/utils/hooks/sessionHooks.ts must serve settings, extension and skill hooks to the main thread and agent hooks only to their crewmate')
  check('an extension entry identical to a settings entry is NOT collapsed (its own namespace)', main.filter(h => h.entry.run === 'from-settings').length === 2, '', 'sourceKey in src/utils/hooks/matching.ts must keep an extension entry in its own namespace so dedupeHooks does not collapse it')
  check('the sources are named', sources(main) === 'user,extension,extension,skill', sources(main), 'the hook sources built by extensionHooksFor in src/utils/hooks/matching.ts and by the session hooks in src/utils/hooks/sessionHooks.ts must name settings layer, extension and skill')
  const crew = await matchHooks('tool.before', { ...toolPayload('Bash'), crewmate_id: 'crew-1', crewmate_type: 'verifier' }, { sessionId: 'session-1', crewmateId: 'crew-1' }, { appState })
  check('the crewmate\'s road runs the agent\'s hooks beside the settings and extension ones, not the main thread\'s skill hooks', runs(crew) === 'from-settings,from-settings,from-extension,from-agent', runs(crew), 'hooksFor in src/utils/hooks/matching.ts and sessionHooksFor in src/utils/hooks/sessionHooks.ts must add the agent hooks registered by registerAgentHooks for that crewmate and not the main thread skill hooks')
  check('the agent\'s turn.answer hook is registered on its road', sessionHooksFor(appState, { sessionId: 'session-1', crewmateId: 'crew-1' }, 'turn.answer').length === 1, '', 'registerAgentHooks in src/utils/hooks/registerFrontmatterHooks.ts must register every event of the agent hooks, turn.answer included')
  removeSessionHooks(setAppState, { sessionId: 'session-1', crewmateId: 'crew-1' })
  check('the teardown removes the crewmate\'s hooks', sessionHooksFor(appState, { sessionId: 'session-1', crewmateId: 'crew-1' }).length === 0, '', 'removeSessionHooks in src/utils/hooks/sessionHooks.ts must remove all hooks of that crewmate scope')
  rmSync(join(PROJ, 'SKILL.md'))
  check('a skill whose SKILL.md is gone is not served (the registry checks at read time)', (await matchHooks('tool.before', toolPayload('Bash'), scope, { appState })).every(h => h.entry.run !== 'from-skill'), '', 'sessionHooksFor in src/utils/hooks/sessionHooks.ts must skip a skill hook set whose SKILL.md is gone, checked at read time (setIsLive)')
  writeFileSync(join(PROJ, 'SKILL.md'), '# lint\n')
  check('…and is served again once SKILL.md is back', (await matchHooks('tool.before', toolPayload('Bash'), scope, { appState })).some(h => h.entry.run === 'from-skill'), '', 'sessionHooksFor in src/utils/hooks/sessionHooks.ts must serve the skill hook set again once SKILL.md exists (setIsLive)')
  rmSync(join(PROJ, 'SKILL.md'))
  const removed = pruneSkillSessionHooks(setAppState, 'session-1', new Set())
  check('pruneSkillSessionHooks removes a skill that left the table and names its root', removed.length === 1 && removed[0] === PROJ && sessionHooksFor(appState, scope).length === 0, JSON.stringify(removed), 'pruneSkillSessionHooks in src/utils/hooks/sessionHooks.ts must remove skills missing from the live set and return their roots')
  check('…and is idempotent', pruneSkillSessionHooks(setAppState, 'session-1', new Set()).length === 0, '', 'pruneSkillSessionHooks in src/utils/hooks/sessionHooks.ts must return an empty list when nothing is left to prune')
  clearRegisteredExtensionHooks()
}

section('§5 the policy locks: disabled, managedOnly, the headless untrusted workspace')
{
  write(USER, { events: { hooks: { 'tool.before': [{ run: 'user' }], 'session.start': [{ run: 'u-start' }] }, disabled: true } })
  write(PROJECT, { events: { hooks: { 'tool.before': [{ run: 'project' }] } } })
  reload()
  check('events.disabled in the user layer turns off every hook that is not managed', (await matchHooks('tool.before', toolPayload('Bash'), scope)).length === 0 && managedHooksOnly() && !hooksDisabled(), '', 'the snapshot in src/utils/hooks/hooksConfigSnapshot.ts must keep only managed hooks when a non-managed layer sets events.disabled')
  write(USER, { events: { hooks: { 'tool.before': [{ run: 'user' }] } } })
  reload()
  check('…and without it the user and project hooks are back', runs(await matchHooks('tool.before', toolPayload('Bash'), scope)) === 'user,project', '', 'src/utils/hooks/hooksConfigSnapshot.ts must load the user and project hooks again once events.disabled is gone')
  const { setSessionTrustAccepted: setTrust } = await import('../../src/bootstrap/state.js')
  setTrust(false)
  const { resetTrustDialogAcceptedCacheForTesting } = await import('../../src/utils/config/trust.js')
  resetTrustDialogAcceptedCacheForTesting()
  reload()
  const untrusted = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('a headless run in an untrusted workspace loads the user layer and not the checkout\'s', runs(untrusted) === 'user', runs(untrusted), 'the snapshot in src/utils/hooks/hooksConfigSnapshot.ts must skip checkout layers (project, local) on a headless run in an untrusted workspace')
  setTrust(true)
  reload()
}

section('§6 the daemon road: scope.cwd reads another workspace\'s hooks when that workspace is trusted')
{
  write(USER, { events: { hooks: { 'session.state': [{ match: 'needs-you', run: 'user-ping' }] } } })
  mkdirSync(join(OTHER, '.mercury'), { recursive: true })
  write(join(OTHER, '.mercury', 'settings.json'), { events: { hooks: { 'session.state': [{ match: 'needs-you|stalled', run: 'other-ping' }] } } })
  reload()
  const payload = { ...base, event: 'session.state' as const, state: 'needs-you', from: 'working', workspace: OTHER }
  const before = await matchHooks('session.state', payload, { sessionId: 'hosted-1', cwd: OTHER })
  check('an untrusted workspace contributes nothing: the user layer alone', runs(before) === 'user-ping', runs(before), 'settingsHooksFor in src/utils/hooks/hooksConfigSnapshot.ts must load a workspace layer only when isPathTrusted(scope.cwd)')
  setPathTrusted(OTHER)
  const after = await matchHooks('session.state', payload, { sessionId: 'hosted-1', cwd: OTHER })
  check('a trusted workspace\'s project hooks ride beside the user layer', runs(after) === 'user-ping,other-ping', runs(after), 'settingsHooksFor in src/utils/hooks/hooksConfigSnapshot.ts must add the trusted workspace hooks of scope.cwd beside the user layer')
  check('the match still filters on the state', runs(await matchHooks('session.state', { ...payload, state: 'completed' }, { sessionId: 'hosted-1', cwd: OTHER })) === '', '', 'matchHooks in src/utils/hooks/matching.ts must still filter session.state hooks on their match value')
  check('the runner\'s own project is untouched by the other workspace', runs(await matchHooks('session.state', payload, scope)) === 'user-ping', '', 'settingsHooksFor in src/utils/hooks/hooksConfigSnapshot.ts must read only the scope cwd workspace, not another workspace')
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
rmSync(OTHER, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-hook-matching: all green' : `\nprove-hook-matching: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
