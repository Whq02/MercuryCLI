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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const HINT_MATCH = 'change matchesPattern or matchHooks in src/integrations/event-hooks/matching.ts so the hooks picked for this tool name follow the match grammar (src/integrations/event-hooks/matcherGrammar.ts)'
const HINT_RULE = 'change argumentMatches or matchesPattern in src/integrations/event-hooks/matching.ts so the rule argument (command, path, crewmate type, domain, MCP server) is read as the permission rule says'
const HINT_LAYERS = 'change dedupeHooks or hooksFor in src/integrations/event-hooks/matching.ts, or settingsHooksFor in src/integrations/event-hooks/hooksConfigSnapshot.ts, so the layers run once each with the later layer as source'
const HINT_ONCE = 'change markHookSpent, forgetSpentHooks or matchHooks in src/integrations/event-hooks/matching.ts so a once hook is spent per session in memory only'
const HINT_SESSION = 'change addSessionHooks, removeSessionHooks, sessionHooksFor or pruneSkillSessionHooks in src/integrations/event-hooks/sessionHooks.ts, or registerAgentHooks or registerSkillHooks in src/integrations/event-hooks/registerFrontmatterHooks.ts'
const HINT_POLICY = 'change hooksDisabled, managedHooksOnly or settingsHooksFor in src/integrations/event-hooks/hooksConfigSnapshot.ts, or hooksFor in src/integrations/event-hooks/matching.ts'
const HINT_WORKSPACE = 'change settingsHooksFor (the cwd argument and the trust check) in src/integrations/event-hooks/hooksConfigSnapshot.ts, or hooksFor in src/integrations/event-hooks/matching.ts'
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { setIsInteractive, setSessionTrustAccepted, setProjectRoot, setOriginalCwd, registerHookCallbacks, clearRegisteredExtensionHooks } = await import('../../src/boot/process-state/processState.js')
const { setCwd } = await import('../../src/platform/shell/shellExec.js')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.js')
const { captureHooksSnapshot, refreshHooksSnapshot, hooksDisabled, managedHooksOnly } = await import('../../src/integrations/event-hooks/hooksConfigSnapshot.js')
const { matchHooks, hasHooksFor, markHookSpent, forgetSpentHooks, matchesPattern } = await import('../../src/integrations/event-hooks/matching.js')
const { addSessionHooks, removeSessionHooks, sessionHooksFor, pruneSkillSessionHooks } = await import('../../src/integrations/event-hooks/sessionHooks.js')
const { registerAgentHooks, registerSkillHooks } = await import('../../src/integrations/event-hooks/registerFrontmatterHooks.js')
const { listHooks } = await import('../../src/integrations/event-hooks/hooksSettings.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { setPathTrusted } = await import('../../src/platform/config/trust.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
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
  check('Bash matches the name, the everything entries, not the pipe or the regex', runs(await matchHooks('tool.before', toolPayload('Bash'), scope)) === 'names,everything,star', '', HINT_MATCH)
  check('Edit matches the pipe list', runs(await matchHooks('tool.before', toolPayload('Edit'), scope)) === 'pipe,everything,star', '', HINT_MATCH)
  check('mcp__x matches the regular expression', runs(await matchHooks('tool.before', toolPayload('mcp__x'), scope)) === 'regex,everything,star', '', HINT_MATCH)
  check('matchesPattern: the LSP family name covers the LSP tools', (await matchesPattern('LspRead', 'LSP')) && !(await matchesPattern('LspRead', '^LSP$')), '', 'change nameMatches in src/integrations/event-hooks/matching.ts (it calls lspFamilyMatches from src/integrations/lsp-family/toolFamily.ts)')
  check('an empty pipe-list member never widens a name matcher', !(await matchesPattern('Bash', 'Read|')) && (await matchesPattern('Read', 'Read|')), '', 'change matchesPattern in src/integrations/event-hooks/matching.ts so an empty member of a pipe list matches nothing')
  check('hasHooksFor answers the cheap question', hasHooksFor('tool.before', scope) && !hasHooksFor('turn.end', scope), '', 'change hasHooksFor or hooksFor in src/integrations/event-hooks/matching.ts')
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
  check('Bash(git *) fires for git status and for git -C /x log; Bash(git status) for the exact command only', (await bash('git status')) === 'git-only,exact-status,any-bash,bash-name' && (await bash('git -C /x log')) === 'git-only,any-bash,bash-name', `${await bash('git status')} / ${await bash('git -C /x log')}`, HINT_RULE)
  check('…and neither fires for ls: the hook is not run, only the name matchers are', (await bash('ls')) === 'any-bash,bash-name', await bash('ls'), HINT_RULE)
  check('a compound command matches any subcommand: cd x && git push is git *', (await bash('cd x && git push')) === 'git-only,any-bash,bash-name', await bash('cd x && git push'), HINT_RULE)
  check('Edit(src/**) fires for src/a.ts under the project, absolute or relative, and not for docs/b.md', (await file('Edit', join(PROJ, 'src/a.ts'))) === 'src-edits' && (await file('Edit', 'src/a.ts')) === 'src-edits' && (await file('Edit', join(PROJ, 'docs/b.md'))) === '', `${await file('Edit', join(PROJ, 'src/a.ts'))} / ${await file('Edit', 'src/a.ts')} / ${await file('Edit', join(PROJ, 'docs/b.md'))}`, HINT_RULE)
  check('Edit(*.rs)|Write(*.rs) fires for a .rs file through either tool; a Write of a .ts file fires neither clause', (await file('Edit', join(PROJ, 'src/lib.rs'))) === 'src-edits,rust-writes' && (await file('Write', join(PROJ, 'x/main.rs'))) === 'rust-writes' && (await file('Write', join(PROJ, 'src/x.ts'))) === '', `${await file('Edit', join(PROJ, 'src/lib.rs'))} / ${await file('Write', join(PROJ, 'x/main.rs'))} / ${await file('Write', join(PROJ, 'src/x.ts'))}`, HINT_RULE)
  check('matchesPattern reads the arguments it is handed, and a rule on one tool never claims another', (await matchesPattern('Bash', 'Bash(git *)', { command: 'git push' })) && !(await matchesPattern('Bash', 'Bash(git *)', { command: 'npm test' })) && !(await matchesPattern('Edit', 'Bash(git *)', { command: 'git push' })) && !(await matchesPattern('Bash', 'Bash(git *)')), '', HINT_RULE)
  check('a regex keeps its regex meaning: ^(Read|Edit)$ names the tool and is no rule', (await matchesPattern('Read', '^(Read|Edit)$')) && !(await matchesPattern('Bash', '^(Read|Edit)$')), '', HINT_MATCH)
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
    check(`${JSON.stringify(command)} selects ${expected || 'no hook'}`, runs(await matchHooks('tool.before', payload, scope)) === expected, '', HINT_RULE)
  }
  check('an exact rule also matches a subcommand', (await matchesPattern('Bash', 'Bash(git push)', { command: 'cd x && git push' })), '', HINT_RULE)
  const { pinnedCommandAnalysis } = await import('../../src/permissions/rules/decision/commandAnalysis.js')
  const parsePowerShell = pinnedCommandAnalysis.parsePowerShellCommand
  const seen: string[] = []
  pinnedCommandAnalysis.parsePowerShellCommand = Object.assign(async (command: string) => {
    seen.push(command)
    return { valid: true, variables: [], errors: [], hasStopParsing: false, originalCommand: command, statements: [{ statementType: 'PipelineAst', text: command, nestedCommands: [], redirections: [], commands: (command.startsWith('Set-Location') ? ['Set-Location x', 'git push origin main'] : [command]).map(text => ({ name: text.split(' ')[0]!, text, nameType: 'application' as const, args: [], elementType: 'CommandAst' })) }] }
  }, { cache: parsePowerShell.cache })
  try {
    check('PowerShell uses its permission parser for subcommands', await matchesPattern('PowerShell', 'PowerShell(git push *)', { command: 'Set-Location x; git push origin main' }), '', 'change the command case of argumentMatches in src/integrations/event-hooks/matching.ts so PowerShell subcommands come from pinnedCommandAnalysis.parsePowerShellCommand')
    check('PowerShell quoted command text is not a subcommand', !await matchesPattern('PowerShell', 'PowerShell(git push *)', { command: 'Write-Output "git push"' }), '', 'change the command case of argumentMatches in src/integrations/event-hooks/matching.ts so quoted text is not a subcommand')
    check('both PowerShell calls reached the existing parser', seen.join('|') === 'Set-Location x; git push origin main|Write-Output "git push"', '', 'change the command case of argumentMatches in src/integrations/event-hooks/matching.ts so it calls pinnedCommandAnalysis.parsePowerShellCommand once per PowerShell call')
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
    check(`${tool} ${JSON.stringify(input)} selects ${expected || 'no hook'}`, runs(await matchHooks('tool.before', { ...toolPayload(tool), input }, scope)) === expected, '', HINT_RULE)
  }
  check('new matcher families join existing rule clauses', (await matchesPattern('WebFetch', 'Crewmate(mercury-scout)|WebFetch(domain:example.com)|mcp__files__*', { url: 'https://example.com/' })) && (await matchesPattern('mcp__files__write', 'Crewmate(mercury-scout)|WebFetch(domain:example.com)|mcp__files__*')), '', HINT_RULE)
  check('an omitted crewmate type matches the launch default', await matchesPattern('Crewmate', 'Crewmate(mercury-crew)', {}), '', HINT_RULE)
  check('an anchored MCP regex retains regex semantics', !(await matchesPattern('mcp__files__read', '^mcp__files$')), '', HINT_MATCH)
  check('Crewmate types are exact, not a glob', !(await matchesPattern('Crewmate', 'Crewmate(mercury-*)', { crewmate_type: 'mercury-scout' })), '', HINT_RULE)
}

section('§2 the layers: every layer runs, an identical entry runs once, the later layer is its source')
{
  write(USER, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'shared' }, { match: 'Bash', run: 'user-only' }] } } })
  write(PROJECT, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'shared' }, { match: 'Bash', run: 'project-only' }] } } })
  write(LOCAL, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'local-only' }] } } })
  reload()
  const matched = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('user, project and local entries all run; the identical entry runs once', runs(matched) === 'user-only,shared,project-only,local-only', runs(matched), HINT_LAYERS)
  check('the identical entry carries the later layer as its source', sources(matched) === 'user,project,project,local', sources(matched), HINT_LAYERS)
  check('the ids are stable across reads', JSON.stringify(matched.map(h => h.id)) === JSON.stringify((await matchHooks('tool.before', toolPayload('Bash'), scope)).map(h => h.id)), '', 'change hookId in src/integrations/event-hooks/matching.ts so the id depends only on the hook identity')
  check('listHooks lists the same hooks with their sources for /hooks', listHooks(appState, 'session-1').filter(r => r.event === 'tool.before').length === 4, '', 'change listHooks in src/integrations/event-hooks/hooksSettings.ts')
}

section('§3 once is once per session, in memory; the settings file is never edited')
{
  write(USER, { events: { hooks: { 'tool.before': [{ match: 'Bash', run: 'one-shot', once: true }, { match: 'Bash', run: 'always' }] } } })
  rmSync(PROJECT)
  rmSync(LOCAL)
  reload()
  const before = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('both hooks match before the one-shot ran', runs(before) === 'one-shot,always', '', HINT_ONCE)
  const raw = JSON.stringify(JSON.parse(String(Bun.file(USER).size > 0 ? await Bun.file(USER).text() : '{}')))
  markHookSpent(before[0]!.id, scope)
  const after = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('after it ran, the one-shot stands down for the rest of the session', runs(after) === 'always', runs(after), HINT_ONCE)
  check('another session still gets it', runs(await matchHooks('tool.before', toolPayload('Bash'), { sessionId: 'session-2' })) === 'one-shot,always', '', HINT_ONCE)
  check('the settings file is byte-identical: Mercury never edits it', JSON.stringify(JSON.parse(await Bun.file(USER).text())) === raw, '', HINT_ONCE)
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
  check('the main thread runs the settings, extension and skill hooks, never the agent\'s', runs(main) === 'from-settings,from-settings,from-extension,from-skill', runs(main), HINT_SESSION)
  check('an extension entry identical to a settings entry is NOT collapsed (its own namespace)', main.filter(h => h.entry.run === 'from-settings').length === 2, '', 'change sourceKey or hookIdentity in src/integrations/event-hooks/matching.ts so each extension keeps its own namespace')
  check('the sources are named', sources(main) === 'user,extension,extension,skill', sources(main), HINT_SESSION)
  const crew = await matchHooks('tool.before', { ...toolPayload('Bash'), crewmate_id: 'crew-1', crewmate_type: 'verifier' }, { sessionId: 'session-1', crewmateId: 'crew-1' }, { appState })
  check('the crewmate\'s road runs the agent\'s hooks beside the settings and extension ones, not the main thread\'s skill hooks', runs(crew) === 'from-settings,from-settings,from-extension,from-agent', runs(crew), HINT_SESSION)
  check('the agent\'s turn.answer hook is registered on its road', sessionHooksFor(appState, { sessionId: 'session-1', crewmateId: 'crew-1' }, 'turn.answer').length === 1, '', HINT_SESSION)
  removeSessionHooks(setAppState, { sessionId: 'session-1', crewmateId: 'crew-1' })
  check('the teardown removes the crewmate\'s hooks', sessionHooksFor(appState, { sessionId: 'session-1', crewmateId: 'crew-1' }).length === 0, '', HINT_SESSION)
  rmSync(join(PROJ, 'SKILL.md'))
  check('a skill whose SKILL.md is gone is not served (the registry checks at read time)', (await matchHooks('tool.before', toolPayload('Bash'), scope, { appState })).every(h => h.entry.run !== 'from-skill'), '', HINT_SESSION)
  writeFileSync(join(PROJ, 'SKILL.md'), '# lint\n')
  check('…and is served again once SKILL.md is back', (await matchHooks('tool.before', toolPayload('Bash'), scope, { appState })).some(h => h.entry.run === 'from-skill'), '', HINT_SESSION)
  rmSync(join(PROJ, 'SKILL.md'))
  const removed = pruneSkillSessionHooks(setAppState, 'session-1', new Set())
  check('pruneSkillSessionHooks removes a skill that left the table and names its root', removed.length === 1 && removed[0] === PROJ && sessionHooksFor(appState, scope).length === 0, '', HINT_SESSION)
  check('…and is idempotent', pruneSkillSessionHooks(setAppState, 'session-1', new Set()).length === 0, '', HINT_SESSION)
  clearRegisteredExtensionHooks()
}

section('§5 the policy locks: disabled, managedOnly, the headless untrusted workspace')
{
  write(USER, { events: { hooks: { 'tool.before': [{ run: 'user' }], 'session.start': [{ run: 'u-start' }] }, disabled: true } })
  write(PROJECT, { events: { hooks: { 'tool.before': [{ run: 'project' }] } } })
  reload()
  check('events.disabled in the user layer turns off every hook that is not managed', (await matchHooks('tool.before', toolPayload('Bash'), scope)).length === 0 && managedHooksOnly() && !hooksDisabled(), '', HINT_POLICY)
  write(USER, { events: { hooks: { 'tool.before': [{ run: 'user' }] } } })
  reload()
  check('…and without it the user and project hooks are back', runs(await matchHooks('tool.before', toolPayload('Bash'), scope)) === 'user,project', '', HINT_POLICY)
  const { setSessionTrustAccepted: setTrust } = await import('../../src/boot/process-state/processState.js')
  setTrust(false)
  const { resetTrustDialogAcceptedCacheForTesting } = await import('../../src/platform/config/trust.js')
  resetTrustDialogAcceptedCacheForTesting()
  reload()
  const untrusted = await matchHooks('tool.before', toolPayload('Bash'), scope)
  check('a headless run in an untrusted workspace loads the user layer and not the checkout\'s', runs(untrusted) === 'user', runs(untrusted), HINT_POLICY)
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
  check('an untrusted workspace contributes nothing: the user layer alone', runs(before) === 'user-ping', runs(before), HINT_WORKSPACE)
  setPathTrusted(OTHER)
  const after = await matchHooks('session.state', payload, { sessionId: 'hosted-1', cwd: OTHER })
  check('a trusted workspace\'s project hooks ride beside the user layer', runs(after) === 'user-ping,other-ping', runs(after), HINT_WORKSPACE)
  check('the match still filters on the state', runs(await matchHooks('session.state', { ...payload, state: 'completed' }, { sessionId: 'hosted-1', cwd: OTHER })) === '', '', HINT_MATCH)
  check('the runner\'s own project is untouched by the other workspace', runs(await matchHooks('session.state', payload, scope)) === 'user-ping', '', HINT_WORKSPACE)
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
rmSync(OTHER, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-hook-matching: all green' : `\nprove-hook-matching: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
