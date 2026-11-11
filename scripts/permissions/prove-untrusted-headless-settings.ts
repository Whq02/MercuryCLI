#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'untrusted-headless-settings-')))
const HOME = join(SCRATCH, 'home')
const FOLDER = join(SCRATCH, 'folder')
const PLANTED = join(SCRATCH, 'planted-memory')
for (const dir of [HOME, join(FOLDER, '.mercury'), PLANTED]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
for (const key of ['MERCURY_HOME', 'MERCURY_BARE']) delete process.env[key]
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

const hookNamed = (name: string): Record<string, unknown> => ({ hooks: { 'session.start': [{ name, run: 'true' }] } })
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ media: { host: 'host-of-the-user' }, events: hookNamed('the hook of the user') }))
writeFileSync(join(FOLDER, '.mercury', 'settings.json'), JSON.stringify({ extensions: { enabled: { 'probe@scene': true } }, events: hookNamed('the shared hook of the folder') }))
writeFileSync(
  join(FOLDER, '.mercury', 'settings.local.json'),
  JSON.stringify({
    memory: { directory: PLANTED },
    media: { enabled: true, host: 'host-of-the-folder' },
    extensions: { enabled: { 'mercury-media@mercury': true, 'probe@scene': true } },
    kit: { trustProjectServers: true },
    events: { disabled: true, ...hookNamed('the local hook of the folder') },
  }),
)
writeFileSync(join(FOLDER, '.mercury', 'mcp.json'), JSON.stringify({ mcpServers: { fixsrv: { command: 'node', args: ['-e', 'setTimeout(()=>{},100)'] } } }))
mkdirSync(join(FOLDER, '.mercury', 'agents'), { recursive: true })
mkdirSync(join(FOLDER, '.mercury', 'workflows'), { recursive: true })
writeFileSync(join(FOLDER, '.mercury', 'agents', 'folder-agent.md'), '---\nname: folder-agent\ndescription: an agent the folder ships\n---\nDo what the folder says.\n')
writeFileSync(join(FOLDER, '.mercury', 'workflows', 'folder-flow.js'), "export const meta = { name: 'folder-flow', description: 'a workflow the folder ships', phases: [{ title: 'Hold' }] }\n")

const state = await import(join(SRC, 'bootstrap/state.ts'))
const { setCwd } = await import(join(SRC, 'utils/Shell.ts'))
setCwd(FOLDER)
state.setOriginalCwd(FOLDER)
state.setProjectRoot(FOLDER)
const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const { getEnabledSettingSources, isSettingSourceEnabled } = await import(join(SRC, 'utils/settings/constants.ts'))
const { resetTrustDialogAcceptedCacheForTesting, untrustedWorkspaceHeadless } = await import(join(SRC, 'utils/config/trust.ts'))
const settings = (await import(join(SRC, 'utils/settings/settings.ts'))) as Record<string, unknown> & {
  getSettingsForSource: (source: string) => Record<string, any> | null
}
const { resetSettingsCache } = await import(join(SRC, 'utils/settings/settingsCache.ts'))
const mneme = await import(join(SRC, 'mneme/paths.ts'))
const media = await import(join(SRC, 'services/media/settings.ts'))
const install = await import(join(SRC, 'extensions/install.ts'))
const mcpUtils = await import(join(SRC, 'services/mcp/utils.ts'))
const mcpConfig = await import(join(SRC, 'services/mcp/config.ts'))
const hooks = await import(join(SRC, 'utils/hooks/hooksConfigSnapshot.ts'))
const markdown = await import(join(SRC, 'utils/markdownConfigLoader.ts'))
const workflows = await import(join(SRC, 'tools/WorkflowTool/registry.ts'))
enableConfigs()

type Posture = 'window' | 'untrusted run' | 'trusted run'
function stand(posture: Posture): void {
  state.setSessionTrustAccepted(posture === 'trusted run')
  resetTrustDialogAcceptedCacheForTesting()
  state.setIsInteractive(posture === 'window')
  resetSettingsCache()
  mneme.getMnemeHome.cache?.clear?.()
  markdown.clearMarkdownFileCache()
  hooks.resetHooksSnapshot()
}

console.log('============================================================')
console.log(' a headless run in a folder nobody trusted reads none of that folder\'s settings')
console.log('============================================================')

section('§0 the page: docs/TRUST.md says a headless run in an untrusted folder keeps the user\'s own configuration and managed policy')
{
  const page = readFileSync(join(ROOT, 'docs', 'TRUST.md'), 'utf8')
  check('the page says nothing a workspace config file asked for executes before trust', /Until you grant trust for\s+the directory, nothing a workspace config file asked for gets to execute/.test(page))
  check('the page says the user\'s own configuration and managed policy still apply there', /The user's\s+own configuration and managed policy still apply/.test(page))
}

section('§1 a window, where the trust card stands before anything runs, keeps every allowed layer')
stand('window')
{
  const sources = getEnabledSettingSources()
  check('the window is not the untrusted headless case', untrustedWorkspaceHeadless() === false)
  check('its enabled layers hold the project and local layers', sources.includes('projectSettings') && sources.includes('localSettings') && sources.includes('userSettings'), sources.join(','))
}

section('§2 a headless run in a folder with no trust grant')
stand('untrusted run')
{
  const sources = getEnabledSettingSources()
  check('the run is the untrusted headless case (the scratch home holds no grant for the scratch folder)', untrustedWorkspaceHeadless() === true)
  check('its enabled layers are the user, flag and policy layers alone', sources.join(',') === 'userSettings,flagSettings,policySettings', sources.join(','))
  check('the project layer and the local layer each read as not enabled', !isSettingSourceEnabled('projectSettings') && !isSettingSourceEnabled('localSettings') && isSettingSourceEnabled('userSettings'))
}

section('§3 --config-layers still narrows what is left')
{
  const before = state.getAllowedSettingSources()
  state.setAllowedSettingSources(['projectSettings', 'localSettings'])
  const sources = getEnabledSettingSources()
  check('with the user layer taken out by the flag, only flag and policy remain', sources.join(',') === 'flagSettings,policySettings', sources.join(','))
  state.setAllowedSettingSources(before)
}

section('§4 the same run once the folder is trusted')
stand('trusted run')
{
  const sources = getEnabledSettingSources()
  check('the run is no longer the untrusted headless case', untrustedWorkspaceHeadless() === false)
  check('its enabled layers hold the project and local layers again', sources.includes('projectSettings') && sources.includes('localSettings') && sources.includes('userSettings'), sources.join(','))
}

section('§5 the four readers that take a layer by name: the folder\'s memory directory, media switch, extension switch and server approval')
{
  const enabledLayer = settings.getEnabledSettingsForSource as ((source: string) => Record<string, any> | null) | undefined
  const SERVER = { command: '/usr/bin/true', args: [] as string[] }
  const read = (): { memory: string; media: { enabled?: boolean; host?: string }; mediaSwitch: { on: boolean; scope: string }; probeSwitch: { on: boolean; scope: string; committedProposal: boolean | null }; server: string } => ({
    memory: String(mneme.getMnemeHome()),
    media: media.readMediaSettings(),
    mediaSwitch: install.readSwitch('mercury-media@mercury'),
    probeSwitch: install.readSwitch('probe@scene'),
    server: String(mcpUtils.getProjectMcpServerStatus('probe', SERVER)),
  })

  stand('untrusted run')
  const untrusted = read()
  check('untrusted run: the memory directory is the user\'s own store, never the directory the folder names', !untrusted.memory.startsWith(PLANTED) && untrusted.memory.startsWith(HOME), untrusted.memory)
  check('untrusted run: media is off and its host is the user\'s', untrusted.media.enabled === false && untrusted.media.host === 'host-of-the-user', JSON.stringify(untrusted.media))
  check('untrusted run: the media extension reads off', untrusted.mediaSwitch.on === false && untrusted.mediaSwitch.scope === 'everywhere', JSON.stringify(untrusted.mediaSwitch))
  check('untrusted run: an extension the folder switches on reads off, and the folder\'s checked-in proposal is not read', untrusted.probeSwitch.on === false && untrusted.probeSwitch.scope === 'off' && untrusted.probeSwitch.committedProposal === null, JSON.stringify(untrusted.probeSwitch))
  check('untrusted run: the folder\'s kit.trustProjectServers approves no project server', untrusted.server === 'pending', untrusted.server)
  check('the reader of an enabled layer answers nothing for the folder\'s layers and still answers for the user\'s', typeof enabledLayer === 'function' && enabledLayer('localSettings') === null && enabledLayer('projectSettings') === null && enabledLayer('userSettings')?.media?.host === 'host-of-the-user', typeof enabledLayer)
  check('the reader a writer goes through still reads the folder\'s file as it is (a write keeps what the file holds)', settings.getSettingsForSource('localSettings')?.memory?.directory === PLANTED, JSON.stringify(settings.getSettingsForSource('localSettings')?.memory ?? null))

  stand('trusted run')
  const trusted = read()
  check('trusted run: the memory directory is the one the folder\'s local settings name', trusted.memory.startsWith(PLANTED), trusted.memory)
  check('trusted run: media is on with the folder\'s host', trusted.media.enabled === true && trusted.media.host === 'host-of-the-folder', JSON.stringify(trusted.media))
  check('trusted run: both switches read on for the project, with the checked-in proposal', trusted.mediaSwitch.on === true && trusted.mediaSwitch.scope === 'project' && trusted.probeSwitch.on === true && trusted.probeSwitch.scope === 'project' && trusted.probeSwitch.committedProposal === true, `${JSON.stringify(trusted.mediaSwitch)} ${JSON.stringify(trusted.probeSwitch)}`)
  check('trusted run: kit.trustProjectServers in the local settings approves the server', trusted.server === 'approved', trusted.server)

  stand('window')
  const window = read()
  check('a window reads the four as before', window.memory.startsWith(PLANTED) && window.media.enabled === true && window.probeSwitch.on === true && window.server === 'approved', JSON.stringify(window))
}

section('§6 what the run still names of what it holds back, and what the folder cannot switch off')
{
  const hookNames = (): string => {
    hooks.captureHooksSnapshot()
    return (hooks.settingsHooksFor('session.start') as Array<{ entry: { name?: string } }>).map(hook => hook.entry.name).join(' · ') || '(none)'
  }
  stand('trusted run')
  await mcpConfig.addMcpConfig('own-server', { command: '/usr/bin/true', args: [] }, 'local')

  stand('untrusted run')
  const named = Object.keys(mcpConfig.getProjectMcpConfigsFromCwd().servers).join(',')
  const serversLine = String(mcpConfig.mcpServersSkippedForTrustLine())
  check('untrusted run: the folder\'s server is still read by name, so the run can say it was held back', named === 'fixsrv' && /its 1 project MCP server was not loaded from \.mercury\/mcp\.json/.test(serversLine), `${named || '(none)'} / ${serversLine}`)
  check('untrusted run: a server the user added for this folder to his own store still loads', Object.keys(mcpConfig.getMcpConfigsByScope('local').servers).join(',') === 'own-server', Object.keys(mcpConfig.getMcpConfigsByScope('local').servers).join(',') || '(none)')
  const untrustedHooks = hookNames()
  const hooksLine = String(hooks.hooksSkippedForTrustLine())
  check('untrusted run: the folder\'s two hooks are counted and said, never loaded', hooks.hooksSnapshot().skippedForTrust === 2 && /its 2 project and local hooks were not loaded/.test(hooksLine), `${hooks.hooksSnapshot().skippedForTrust} / ${hooksLine}`)
  check('untrusted run: the folder\'s events.disabled does not switch the user\'s own hook off', untrustedHooks === 'the hook of the user' && hooks.hooksDisabled() === false && hooks.managedHooksOnly() === false, untrustedHooks)
  const untrustedAgents = ((await markdown.loadMarkdownFilesForSubdir('agents', FOLDER)) as Array<{ filePath: string }>).filter(file => file.filePath.startsWith(FOLDER)).length
  const untrustedFlows = ((await workflows.listWorkflows(FOLDER)) as Array<{ name: string }>).filter(flow => flow.name === 'folder-flow').length
  check('untrusted run: the folder\'s agent definition and its workflow are not offered', untrustedAgents === 0 && untrustedFlows === 0, `${untrustedAgents} agent file(s), ${untrustedFlows} workflow(s)`)

  stand('trusted run')
  const trustedHooks = hookNames()
  check('trusted run: nothing is said to be held back, and the folder\'s events.disabled is honoured', mcpConfig.mcpServersSkippedForTrustLine() === null && hooks.hooksSkippedForTrustLine() === null && trustedHooks === '(none)' && hooks.managedHooksOnly() === true, `${String(mcpConfig.mcpServersSkippedForTrustLine())} / ${String(hooks.hooksSkippedForTrustLine())} / ${trustedHooks}`)
  const trustedAgents = ((await markdown.loadMarkdownFilesForSubdir('agents', FOLDER)) as Array<{ filePath: string }>).filter(file => file.filePath.startsWith(FOLDER)).length
  const trustedFlows = ((await workflows.listWorkflows(FOLDER)) as Array<{ name: string }>).filter(flow => flow.name === 'folder-flow').length
  check('trusted run: the folder\'s agent definition and its workflow are offered', trustedAgents === 1 && trustedFlows === 1, `${trustedAgents} agent file(s), ${trustedFlows} workflow(s)`)
}

stand('untrusted run')
rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ untrusted headless settings: ${checks} checks, 0 failures` : ` ❌ untrusted headless settings: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
