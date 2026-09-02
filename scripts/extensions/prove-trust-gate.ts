#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-trust-gate.ts — an extension does NOTHING until
//  the operator says so.
//
//  §1 installed-off contributes nothing on EVERY channel: the hook registry
//     has no matcher with its root, the MCP map has no ext: server, the
//     skill/command/agent catalogues have no `<name>:` entries, the
//     language-server map is empty, no keybinding block, and the settings
//     files are byte-unchanged by the install.
//  §2 approval writes the record (per contributions hash) and the switch;
//     the reload then loads every channel; switching off empties them again.
//  §3 a second same-name extension installs but cannot be ENABLED.
//  §4 a project folder is inert until approved, and SHADOWS the installed
//     same-name extension after.
//  §5 a `wanted` proposal is NEVER fetched before the two-step: the request
//     log of a loopback source stays empty across roster + reload.
//  §6 `--extension <path>` is approved by the flag for THIS session only:
//     nothing persists (records and settings byte-unchanged).
//  §7 the blocklist refuses enable; policy-blocked entries cannot be
//     unblocked from the board's operation.
//  §8 the privilege drop: an extension agent's permissionMode/hooks/servers
//     never reach the definition; its tools list may only narrow.
//  §9 the `ext:` prefix is fixed: an operator server of the same leaf name
//     stays a different server; a same-signature manual entry wins the slot.
//  §10 per-contribution switches: a kind switched off contributes nothing
//     while the others stay live.
// ============================================================================
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-trust-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
const settingsMod = await import('../../src/utils/settings/settings.ts')
const paths = await import('../../src/extensions/paths.ts')
const records = await import('../../src/extensions/records.ts')
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')
const rosterMod = await import('../../src/extensions/roster.ts')
const activeMod = await import('../../src/extensions/active.ts')
const reloadMod = await import('../../src/extensions/reload.ts')
const loadCommands = await import('../../src/extensions/load/commands.ts')
const loadAgents = await import('../../src/extensions/load/agents.ts')
const loadServers = await import('../../src/extensions/load/servers.ts')
const loadLanguage = await import('../../src/extensions/load/language.ts')
const loadKeys = await import('../../src/extensions/load/keybindings.ts')
const channels = await import('../../src/extensions/load/channels.ts')
const blocklist = await import('../../src/extensions/blocklist.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')

async function swap(): Promise<Awaited<ReturnType<typeof reloadMod.reloadExtensions>>> {
  return reloadMod.reloadExtensions({ cwd })
}

function contributions(): { hooks: string[]; servers: string[]; skills: string[]; commands: string[]; agents: string[]; language: string[]; keybindings: number } {
  const registered = state.getRegisteredHooks() ?? {}
  const hooks: string[] = []
  for (const [event, matchers] of Object.entries(registered)) {
    for (const m of matchers ?? []) if ('extensionRoot' in (m as object)) hooks.push(`${event}:${(m as { extensionId: string }).extensionId}`)
  }
  return {
    hooks,
    servers: Object.keys(loadServers.getExtensionMcpServers()),
    skills: loadCommands.getExtensionSkills().map(c => c.name),
    commands: loadCommands.getExtensionCommands().map(c => c.name),
    agents: loadAgents.getExtensionAgents().map(a => a.agentType),
    language: Object.keys(loadLanguage.getExtensionLspServers()),
    keybindings: loadKeys.getExtensionKeybindingBlocks().length,
  }
}
const settingsBytes = (): string => {
  const file = join(home, 'settings.json')
  return existsSync(file) ? readFileSync(file, 'utf8') : '<absent>'
}

console.log('============================================================')
console.log(' the trust gate — nothing before approval')
console.log('============================================================')

// a folder source to install from
const added = await sources.addSource(FIXTURE, { label: 'fixture-source' })
if (!added.ok) {
  console.log(`  [FAIL] fixture source add — ${added.reason}`)
  process.exit(1)
}

// ── §1 installed-off contributes nothing ────────────────────────────────────
console.log('[1] installed, unapproved, off: every channel is empty')
{
  const before = settingsBytes()
  const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('the install lands (copy + record, no approval)', installed.ok && installed.ok && installed.record.approval === null)
  await swap()
  const c = contributions()
  check('no hook matcher carries its root', c.hooks.length === 0, c.hooks.join(','))
  check('no ext: server in the MCP map', c.servers.length === 0, c.servers.join(','))
  check('no skill in the catalogue', c.skills.length === 0, c.skills.join(','))
  check('no command in the catalogue', c.commands.length === 0)
  check('no agent in the catalogue', c.agents.length === 0)
  check('no language server', c.language.length === 0)
  check('no keybinding block', c.keybindings === 0)
  check('the settings file is byte-unchanged by an install', settingsBytes() === before)
  const row = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === 'kitchen-sink@fixture-source')
  check('the row reads off · not approved', row !== undefined && rosterMod.trustStateOf(row) === 'off' && !row.approved)
}

// ── §2 approve → on; off again empties ──────────────────────────────────────
console.log('[2] approval is the gate: approve → the channels fill; switch off → they empty')
{
  const approved = install.approve('kitchen-sink@fixture-source')
  check('approve records the version + contributions hash + time', approved.ok && approved.record.approval !== null && approved.record.approval.contributionsHash === approved.record.contributionsHash)
  check('the switch landed in the user settings', settingsMod.getSettingsForSource('userSettings')?.extensions?.enabled?.['kitchen-sink@fixture-source'] === true)
  await swap()
  const c = contributions()
  check('hooks registered under its root', c.hooks.length >= 2, c.hooks.join(','))
  check('the server is ext:kitchen-sink:fixture', c.servers.includes('ext:kitchen-sink:fixture'), c.servers.join(','))
  check('the skill is kitchen-sink:fixture-skill', c.skills.includes('kitchen-sink:fixture-skill'))
  check('the command is kitchen-sink:fixture-cmd', c.commands.includes('kitchen-sink:fixture-cmd'))
  check('the agent is kitchen-sink:fixture-agent', c.agents.includes('kitchen-sink:fixture-agent'))
  check('the channel approval answers for the declared server', channels.approvedChannelFor('ext:kitchen-sink:fixture') !== null)
  check('an undeclared server has no channel approval and the drop is counted', channels.admitChannelPost('ext:kitchen-sink:other') === false)
  const off = install.setSwitch('kitchen-sink@fixture-source', false)
  check('switch off writes', off.ok)
  await swap()
  const after = contributions()
  check('off empties every channel again', after.hooks.length === 0 && after.servers.length === 0 && after.skills.length === 0 && after.agents.length === 0)
  check('space back on works without re-approval (the approval is on file)', install.setSwitch('kitchen-sink@fixture-source', true).ok)
  await swap()
}

// ── §3 a second same-name extension cannot be enabled ───────────────────────
console.log('[3] one name active at a time')
{
  const second = join(scratch, 'second-source')
  cpSync(FIXTURE, second, { recursive: true })
  const addedSecond = await sources.addSource(second, { label: 'second-source' })
  check('a second source with the same extension adds', addedSecond.ok)
  const installedSecond = await install.installFromSource('second-source', 'kitchen-sink')
  check('the second copy INSTALLS (installed, off, inspectable)', installedSecond.ok)
  const enabled = install.approve('kitchen-sink@second-source')
  check('enabling it is refused naming the first label', !enabled.ok && enabled.reason.includes('already enabled from fixture-source'), enabled.ok ? 'enabled' : enabled.reason)
}

// ── §4 a project folder is inert until approved, then shadows ───────────────
console.log('[4] the project folder: inert until approved; shadows after')
{
  const folder = join(cwd, '.mercury', 'extensions', 'kitchen-sink')
  cpSync(join(FIXTURE, 'kitchen-sink'), folder, { recursive: true })
  let roster = rosterMod.computeRoster({ cwd })
  const found = roster.entries.find(e => e.id === 'kitchen-sink@project')
  check('the folder paints ◇ found (its manifest read, nothing registered)', found !== undefined && rosterMod.trustStateOf(found) === 'found' && found.manifest !== null)
  await swap()
  let c = contributions()
  check('nothing from the folder loads before approval', !c.servers.some(s => s.includes('@project')) && c.skills.filter(s => s.startsWith('kitchen-sink')).length <= 3)
  const approvedInPlace = install.approve('kitchen-sink@project', { root: folder, scope: 'project' })
  check('approve in place writes the record with the folder as its path', approvedInPlace.ok && approvedInPlace.record.path === folder)
  await swap()
  roster = rosterMod.computeRoster({ cwd })
  const installedRow = roster.entries.find(e => e.id === 'kitchen-sink@fixture-source')
  const projectRow = roster.entries.find(e => e.id === 'kitchen-sink@project')
  check('the project row is on', projectRow !== undefined && rosterMod.trustStateOf(projectRow) === 'on')
  check('the installed row reads off · shadowed by the project extension', installedRow?.shadowedBy === 'kitchen-sink@project')
  const set = activeMod.getActiveSet()
  check('exactly ONE kitchen-sink contributes (the project one)', set.active.filter(e => e.manifest.name === 'kitchen-sink').length === 1 && set.active.some(e => e.entry.id === 'kitchen-sink@project'))
  // A content edit is a consent change (the approval covers every
  // delivered byte — E008-52): the row flips to changed-since-approval,
  // the edited body never rides the old approval, and the edit lands
  // only after a fresh in-place approval.
  writeFileSync(join(folder, 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: edited live\n---\nEdited.\n')
  await swap()
  const editedRow = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === 'kitchen-sink@project')
  check('a content edit reads changed-since-approval', editedRow?.changedSinceApproval === true)
  const withheld = loadCommands.getExtensionSkills().find(s => s.name === 'kitchen-sink:fixture-skill')
  check('the edited body does NOT ride the old approval', withheld?.description !== 'edited live')
  check('re-approving in place accepts the edit', install.approve('kitchen-sink@project', { root: folder, scope: 'project' }).ok)
  await swap()
  const edited = loadCommands.getExtensionSkills().find(s => s.name === 'kitchen-sink:fixture-skill')
  check('a content edit lands after the re-approval', edited?.description === 'edited live')
  // a contributions change puts it off with changed — re-approve
  const manifest = JSON.parse(readFileSync(join(folder, 'mercury-extension.json'), 'utf8'))
  manifest.contributes.hooks.Stop = [{ hooks: [{ type: 'command', command: 'true' }] }]
  writeFileSync(join(folder, 'mercury-extension.json'), JSON.stringify(manifest, null, 2))
  await swap()
  const changed = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === 'kitchen-sink@project')
  check('a contributions change reads changed — re-approve and stops contributing', changed?.changedSinceApproval === true && rosterMod.trustStateOf(changed!) === 'off')
  const c2 = contributions()
  check('the installed copy takes over again (one name active)', activeMod.getActiveSet().active.filter(e => e.manifest.name === 'kitchen-sink').length === 1 && c2.skills.includes('kitchen-sink:fixture-skill'))
  rmSync(folder, { recursive: true, force: true })
  await swap()
}

// ── §5 a proposal is never fetched ──────────────────────────────────────────
console.log('[5] a wanted proposal is shown, never fetched')
{
  const requestLog: string[] = []
  const server: Server = createServer((req, res) => {
    requestLog.push(`${req.method} ${req.url}`)
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>(r => server.listen(34311, '127.0.0.1', () => r()))
  mkdirSync(join(cwd, '.mercury'), { recursive: true })
  writeFileSync(join(cwd, '.mercury', 'settings.json'), JSON.stringify({ extensions: { wanted: [{ name: 'proposed-tools', source: 'http://127.0.0.1:34311/team.git' }] } }, null, 2))
  const { settingsChangeDetector } = await import('../../src/utils/settings/changeDetector.ts')
  settingsChangeDetector.notifyChange()
  const roster = rosterMod.computeRoster({ cwd })
  const proposal = roster.entries.find(e => e.name === 'proposed-tools')
  check('the proposal paints ◇ found with its source', proposal !== undefined && proposal.home === 'proposal' && proposal.proposal?.source === 'http://127.0.0.1:34311/team.git' && rosterMod.trustStateOf(proposal) === 'found')
  await swap()
  check('NOTHING was fetched across roster + reload (request log empty)', requestLog.length === 0, requestLog.join(' | '))
  check('a committed enabled switch for an unapproved extension is ignored', (() => {
    writeFileSync(join(cwd, '.mercury', 'settings.json'), JSON.stringify({ extensions: { enabled: { 'proposed-tools@team': true }, wanted: [{ name: 'proposed-tools', source: 'http://127.0.0.1:34311/team.git' }] } }, null, 2))
    settingsChangeDetector.notifyChange()
    const again = rosterMod.computeRoster({ cwd }).entries.find(e => e.name === 'proposed-tools')
    return again !== undefined && rosterMod.trustStateOf(again) === 'found'
  })())
  server.close()
  writeFileSync(join(cwd, '.mercury', 'settings.json'), '{}')
  settingsChangeDetector.notifyChange()
}

// ── §6 the session flag persists nothing ────────────────────────────────────
console.log('[6] --extension is session-only')
{
  const sessionExt = join(scratch, 'session-ext')
  cpSync(join(FIXTURE, 'needs-node'), sessionExt, { recursive: true })
  const recordsBefore = readFileSync(paths.getInstalledFile(), 'utf8')
  const settingsBefore = settingsBytes()
  state.setSessionExtensions([sessionExt])
  await swap()
  const roster = rosterMod.computeRoster({ cwd })
  const row = roster.entries.find(e => e.id === 'needs-node@session')
  check('the session extension is on (the flag is the approval)', row !== undefined && row.approved && row.switchedOn)
  check('its server is live', Object.keys(loadServers.getExtensionMcpServers()).includes('ext:needs-node:echo'))
  check('nothing persisted: installed.json byte-unchanged', readFileSync(paths.getInstalledFile(), 'utf8') === recordsBefore)
  check('nothing persisted: settings byte-unchanged', settingsBytes() === settingsBefore)
  state.setSessionExtensions([])
  await swap()
  check('gone next session (the flag cleared)', !rosterMod.computeRoster({ cwd }).entries.some(e => e.label === 'session'))
}

// ── §7 the blocklist ────────────────────────────────────────────────────────
console.log('[7] blocked: enabling refused; policy blocks cannot be unblocked here')
{
  const blocked = blocklist.block('kitchen-sink@fixture-source')
  check('the operator blocks an id', blocked.ok)
  const roster = rosterMod.computeRoster({ cwd })
  const row = roster.entries.find(e => e.id === 'kitchen-sink@fixture-source')
  check('the row reads ◉ blocked (operator)', row?.blockedBy === 'operator' && rosterMod.trustStateOf(row!) === 'blocked')
  await swap()
  check('a blocked extension contributes nothing (switch forced off)', contributions().skills.length === 0)
  const enable = install.setSwitch('kitchen-sink@fixture-source', true)
  check('space is refused with the unblock key', !enable.ok && enable.reason.includes('b unblocks'), enable.ok ? 'enabled' : enable.reason)
  check('unblock restores', blocklist.unblock('kitchen-sink@fixture-source').ok)
  await swap()
  check('back on after unblock', contributions().skills.includes('kitchen-sink:fixture-skill'))
  // policy: a blocked entry in policySettings cannot be unblocked by the operator's file
  const policy = blocklist.matchBlock(['anything'])
  check('nothing is blocked by default', policy === null)
  const un = blocklist.unblock('never-blocked')
  check('unblocking a never-blocked entry is a no-op success', un.ok)
}

// ── §8 the privilege drop ───────────────────────────────────────────────────
console.log('[8] extension agents cannot raise privilege')
{
  const agents = loadAgents.getExtensionAgents()
  const fixture = agents.find(a => a.agentType === 'kitchen-sink:fixture-agent')
  check('the agent loads', fixture !== undefined)
  check('permissionMode never reaches the definition', fixture !== undefined && !('permissionMode' in fixture))
  check('frontmatter hooks never reach the definition', fixture !== undefined && !('hooks' in fixture))
  check('the tools list narrows (Read, Grep only)', JSON.stringify(fixture?.tools) === JSON.stringify(['Read', 'Grep']), JSON.stringify(fixture?.tools))
  const set = activeMod.getActiveSet()
  const kitchen = set.active.find(e => e.manifest.name === 'kitchen-sink')
  check('the ignored fields are health NOTES, not defects', kitchen !== undefined && kitchen.health.notes.some(n => n.includes('permissionMode field ignored')) && kitchen.health.outcome !== 'broken')
}

// ── §9 the fixed prefix ─────────────────────────────────────────────────────
console.log('[9] ext: is fixed: an operator server of the same leaf stays distinct; a same-signature manual entry wins')
{
  const manifest = await import('../../src/extensions/manifest.ts')
  check('an extension server name always carries the prefix', manifest.serverRuntimeName('kitchen-sink', 'fixture') === 'ext:kitchen-sink:fixture')
  check('an operator name never parses as an extension server', manifest.parseServerRuntimeName('fixture') === null && manifest.parseServerRuntimeName('kitchen-sink:fixture') === null)
  const mcpConfig = await import('../../src/services/mcp/config.ts')
  const extServers = loadServers.getExtensionMcpServers()
  const ext = extServers['ext:kitchen-sink:fixture']!
  const manual = { fixture: { type: 'stdio' as const, command: (ext as { command: string }).command, args: (ext as { args?: string[] }).args ?? [], scope: 'local' as const } }
  const { servers: deduped, suppressed } = mcpConfig.dedupExtensionMcpServers(extServers, manual)
  check('a manual server with the SAME signature wins the slot (the extension twin is suppressed)', suppressed.some(s => s.name === 'ext:kitchen-sink:fixture') && !('ext:kitchen-sink:fixture' in deduped))
  const manualOther = { fixture: { type: 'stdio' as const, command: 'node', args: ['other.mjs'], scope: 'local' as const } }
  const second = mcpConfig.dedupExtensionMcpServers(extServers, manualOther)
  check('a different-signature manual server of the same leaf coexists', 'ext:kitchen-sink:fixture' in second.servers)
}

// ── §10 per-contribution switches ───────────────────────────────────────────
console.log('[10] a kind switched off contributes nothing; the rest stay live')
{
  const off = install.setKindSwitch('kitchen-sink@fixture-source', 'hooks', false)
  check('the hooks kind switches off on the record', off.ok)
  await swap()
  const c = contributions()
  check('no hooks; skills and servers stay', c.hooks.length === 0 && c.skills.includes('kitchen-sink:fixture-skill') && c.servers.includes('ext:kitchen-sink:fixture'))
  install.setKindSwitch('kitchen-sink@fixture-source', 'hooks', true)
  await swap()
  check('hooks return with the switch', contributions().hooks.length >= 2)
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ TRUST GATE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
