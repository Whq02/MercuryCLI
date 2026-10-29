#!/usr/bin/env bun
import React from 'react'
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from './gridToPng.ts'

const root = resolve(import.meta.dir, '../..')
const sourceRef = pinSourceRef()
const before = sourceRef !== undefined
const home = pinScratchHome('everyday-words')
delete process.env.MERCURY_HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|XAI_|META_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|MISTRAL_|NOUS_|OPENCODE_|MINIMAX_|TOGETHER_|COHERE_|GROQ_|CEREBRAS_|FIREWORKS_|DASHSCOPE_)/.test(key)) delete process.env[key]
const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? undefined : resolve(process.argv[frameAt + 1]!)
if (frames) mkdirSync(frames, { recursive: true })
let networkCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = (() => { networkCalls++; throw new Error('Unexpected network in wording fixture') }) as typeof fetch
async function stub(path: string, values: Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...values }))
}
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
await stub('../../src/context/notifications.js', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('../../src/hooks/useCatalogueEpoch.js', { useCatalogueEpoch: () => 0 })
await stub('../../src/utils/model/computedDefault.js', { mostRecentSignInFamily: () => undefined })
await stub('../../src/utils/browser.js', { openBrowser: async () => { throw new Error('Unexpected browser') } })
await stub('../../src/components/tasks/useFocusedWork.js', { focusedRunnerPresence: () => 'live' })
const ids = ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek', 'xai', 'meta', 'mistral', 'local', 'openai-compat', 'nous', 'zen', 'minimax', 'together', 'cohere', 'groq', 'melious', 'orcarouter', 'cerebras', 'fireworks', 'qwen']
await stub('../../src/services/providers/providerUsability.js', { resolveProviderUsability: () => Object.fromEntries(ids.map(id => [id, { usable: false, credential: 'none', blockers: ['not signed in'], limit: 'allowed' }])) })
await stub('../../src/services/providers/accountSlots.js', { deriveFamilySlotGroups: () => ids.map(id => ({ family: { id, available: true, credentialed: false }, slots: [] })) })
await stub('../../src/services/providers/providerUsage.js', { activeSourceUsage: () => ({ tier: null }), providerFamilyPresences: () => [] })
await stub('../../src/services/providers/openai/openaiCatalogue.js', { liveGptContextWindow: () => 272000, liveGptContextCeiling: () => 1000000 })
await stub('../../src/components/mercury-ui/screens/anthropicLoginModel.js', { useAnthropicLoginModel: () => ({ flow: { name: 'idle' }, pastePromptUp: false, copied: false, shadowWarning: null, accountLabel: null }) })
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider, getDefaultAppState } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { call: logins } = await import('../../src/commands/login/login.js')
const { MercuryHealthCertificate } = await import('../../src/commands/health/HealthCertificate.js')
const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.js')
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/services/engine-connector/focusedConnector.js')
const { ExtensionsBoard } = await import('../../src/components/extensions/ExtensionsBoard.js')
const { renderToolResultMessage, renderToolUseMessage } = await import('../../src/tools/MCPTool/UI.js')
const { FallbackPermissionRequest } = await import('../../src/components/permissions/FallbackPermissionRequest.js')
const { Client, StdioClientTransport } = await import('../../src/services/mcp/sdk.js')
const { registerBundledAppInstall, bundledAppInstallPermission } = await import('../../src/extensions/installConsent.js')
const h = React.createElement
let checks = 0
function check(label: string, ok: unknown): void { assert.ok(ok, label); checks++; console.log(`PASS ${label}`) }
async function key(m: Mounted, data: string): Promise<void> { m.push(data); await settle(120) }
async function mount(body: React.ReactNode, cols: number, rows: number, initialState = getDefaultAppState()): Promise<Mounted> {
  const m = await mountOffscreen(h(AppStateProvider, { initialState, onChangeAppState() {} }, h(ThemeProvider, {}, h(KeybindingSetup, {}, h(Box, { width: cols, height: rows, flexDirection: 'column' }, body)))), cols, rows)
  await settle(180)
  return m
}
async function save(m: Mounted, name: string, cols: number, rows: number): Promise<void> {
  check(`${name} ${cols}x${rows} rendered`, m.screen().trim().length > 0)
  if (!frames) return
  const lines = m.lines()
  const grid = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => {
    const style = m.styleAt(x, y)
    return { c: Array.from(lines[y] ?? '')[x] ?? ' ', bg: style?.bg, fg: style?.fg, bold: style?.bold, rev: style?.inverse }
  }))
  const base = join(frames, `${name}-${cols}x${rows}`)
  writeFileSync(`${base}.txt`, lines.join('\n') + '\n')
  writeFileSync(`${base}.json`, JSON.stringify({ cols, rows, grid }))
  await gridToPng(`${base}.json`, `${base}.png`)
}
const context = { messages: [], options: {}, onChangeAPIKey() {}, setMessages() {}, getAppState: () => ({}), setAppState() {} } as never
const cert = { verdict: 'caution', ranAt: new Date().toISOString(), head: { sha: '123456789', branch: 'fixture', dirty: false }, version: '1.0.0', durationMs: 12, depth: 'fast', sections: [{ id: 'runtime', title: 'RUNTIME', checks: [
  { id: 'runtime', label: 'Runtime', status: 'ok', evidence: 'runtime fixture evidence', detail: 'Runtime detail retained.' },
  { id: 'path', label: 'Shell', status: 'warn', evidence: 'shell executable missing', detail: 'PATH has no configured shell.', fix: 'Choose a shell in Settings.' },
] }] }
const work = { id: 'scout', kind: 'agent', name: 'scout', status: 'running', startTime: Date.now() - 2000, model: 'fixture-model', phase: { phase: 'first-byte', sinceMs: Date.now() - 2000, budgetMs: 45000 }, description: 'Review the changed screens', totalTokens: 1200, pendingAsks: 0 }
const roster = { rows: [work], mission: [], reported: true }
const noAsks: never[] = []
const connector = { carrier: 'daemon', sessionId: () => 'wording-fixture', workRoster: () => roster, subscribeWork: () => () => {}, subscribeRecords: () => () => {}, asks: () => noAsks, subscribeAsks: () => () => {}, identity: () => ({ consoleBilling: false, firstPartyApi: false, claudeAiBilling: true, accountEmail: null }) }
const ext = { id: 'filmcraft@mercury', name: 'filmcraft', version: '0.1.0', description: 'Edit the open FilmCraft project.', label: 'mercury', home: 'bundled', root: null, manifest: { name: 'filmcraft', version: '0.1.0', description: 'Edit the open FilmCraft project.' }, manifestWarnings: [], manifestErrors: [], record: null, source: null, contributionsHash: null, approved: true, changedSinceApproval: false, switchedOn: true, switchScope: 'everywhere', blockedBy: null, shadowedBy: null, pending: null, availableVersion: null, noLongerOffered: false, sourceRemoved: false, changedOnDisk: false, proposal: null, previous: null, bundledUpdatedWith: 'updated with Mercury 1.0.0' }
const delivered = join(home, 'filmcraft')
cpSync(join(root, 'src/extensions/bundled/filmcraft'), delivered, { recursive: true })
cpSync(join(root, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
if (sourceRef) writeFileSync(join(delivered, 'shared/bootstrap.mjs'), execFileSync('git', ['-C', root, 'show', `${sourceRef}:src/extensions/bundled/shared/bootstrap.mjs`], { encoding: 'utf8' }))
const { adapter } = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
const { planInstall, hostPlatform } = await import(pathToFileURL(join(delivered, 'shared/install.mjs')).href)
const { bootstrapTools } = await import(pathToFileURL(join(delivered, 'shared/bootstrap.mjs')).href)
const dataDir = join(home, 'applications')
const pinnedPlatforms = Object.keys((adapter.pins?.[0]?.platforms ?? {}) as Record<string, unknown>)
if (pinnedPlatforms.length > 0 && !pinnedPlatforms.includes(hostPlatform())) process.env.MERCURY_CRAFT_PLATFORM = pinnedPlatforms[0]
const plan = planInstall(adapter, { dataDir })
const tools = bootstrapTools(adapter, plan)
registerBundledAppInstall('ext:filmcraft:app', delivered, dataDir)
const tool = { name: 'mcp__ext_filmcraft_app__craft_install', mcpInfo: { serverName: 'ext:filmcraft:app', toolName: 'craft_install' }, userFacingName: () => 'FilmCraft install (MCP)', renderToolUseMessage }
const permission = await bundledAppInstallPermission(tool as never, {})
check('install consent retains exact bytes and destination', permission?.behavior === 'ask' && permission.message.includes(plan.bytes.toLocaleString('en-US')) && permission.message.includes(plan.destination))
const client = new Client({ name: 'everyday-words', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(delivered, 'server/bridge.mjs')], env: { ...process.env, MERCURY_EXTENSION_DATA: dataDir } as Record<string, string>, stderr: 'pipe' }))
try {
  const discovered = await client.listTools()
  check('Craft retains all three bootstrap actions', discovered.tools.map(t => t.name).join(',') === 'craft_status,craft_install,craft_connect')
  const status = await client.callTool({ name: 'craft_status', arguments: {} })
  const content = status.content as Array<{ type: 'text'; text: string }>
  const agentResult = JSON.stringify(content)
  assert.deepEqual(JSON.parse(content[0]!.text), { app: 'FilmCraft', version: adapter.version, state: 'absent', destination: plan.destination, bytes: plan.bytes })
  check('Craft status keeps the complete machine result', !status.isError)
  const denied = await client.callTool({ name: 'craft_install', arguments: {} })
  check('unapproved install remains an error', denied.isError === true)
  if (!before) {
    const { renderToString } = await import('../../src/utils/staticRender.js')
    const base = JSON.parse(content[0]!.text)
    const paint = (value: unknown) => renderToString(renderToolResultMessage([{ type: 'text', text: JSON.stringify(value) }], [], { verbose: false }), 120)
    for (const [patch, words] of [
      [{ state: 'installed' }, 'is installed. Use craft_connect'],
      [{ state: 'invalid', reason: 'Fixture installation is damaged.' }, 'installation invalid. Fixture installation is damaged.'],
      [{ state: 'installed', attached: { identity: 'filmcraft', version: adapter.version, project: 'scene.fcproj' } }, 'attached: scene.fcproj'],
      [{ state: 'installed', attached: { identity: 'filmcraft', version: adapter.version, project: 'scene.fcproj', headless: true } }, 'headless session: scene.fcproj'],
    ] as const) check(`Craft status retains ${words}`, (await paint({ ...base, ...patch })).includes(words))
    check('unfamiliar Craft states keep raw detail', (await paint({ ...base, state: 'unfamiliar' })).includes('destination'))
    check('other apps keep raw detail', (await paint({ ...base, app: 'Other App' })).includes('destination'))
    check('application errors remain visible', (await renderToString(renderToolResultMessage(denied.content as never, [], { verbose: false }), 120)).includes('Installation declined'))
  }
  for (const [cols, rows] of [[80, 24], [120, 40]]) {
    let selected = ''
    let m = await mount(h(MercuryModelPicker, { models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', tag: '', ctx: '272k', group: 'OpenAI', door: 'subscription' }], current: 'gpt-6-astra', ctxPct: 12, onSelect: (id: string) => { selected = id } }), cols!, rows!)
    await key(m, '\x17')
    await save(m, 'model', cols!, rows!)
    check('model context choice keeps both window sizes', m.screen().includes('272k ctx active') && m.screen().includes('1M'))
    await key(m, KEY.enter)
    const { withGptServedWindowSuffix } = await import('../../src/services/providers/openai/openaiCatalogue.js')
    check('model selection keeps the served-window choice', selected === withGptServedWindowSuffix('gpt-6-astra'))
    m.unmount()

    m = await mount(h(SettingsPopupSlot, { overlay: true }), cols!, rows!)
    popup.openSettingsPopup(configPopupRequest(context))
    check('Settings opens', await waitFor(() => m.screen().includes('Mercury · config'), 3000))
    await key(m, 'ping')
    await key(m, KEY.down)
    await save(m, 'settings', cols!, rows!)
    check('Settings keeps the selected setting and explanation', m.screen().includes('Ping') && m.screen().includes(before ? 'one ping' : 'Notify when'))
    popup.closeSettingsPopup(); m.unmount()

    m = await mount(h(SettingsPopupSlot, { overlay: true }), cols!, rows!)
    await logins(() => {}, context, '')
    check('Logins opens', await waitFor(() => m.screen().includes('Mercury · logins'), 3000))
    await save(m, 'logins', cols!, rows!)
    await key(m, KEY.enter)
    await save(m, 'logins-choice', cols!, rows!)
    check('Logins keeps subscription and API key actions', m.screen().includes('ChatGPT subscription') && m.screen().includes('OpenAI API key'))
    popup.closeSettingsPopup(); m.unmount()

    m = await mount(h(MercuryHealthCertificate, { onClose() {}, report: (async () => cert) as never }), cols!, rows!)
    check('Health fixture settles', await waitFor(() => m.screen().includes('RUNTIME'), 3000))
    await save(m, 'health', cols!, rows!)
    if (!before) check('Health keeps evidence behind detail', !m.screen().includes('runtime fixture evidence') && m.screen().includes('warn'))
    await key(m, KEY.enter)
    await save(m, 'health-detail', cols!, rows!)
    check('Health detail retains evidence', m.screen().includes('runtime fixture evidence') && m.screen().includes('Runtime detail retained.'))
    m.unmount()

    setFocusedSessionConnector(connector as never)
    m = await mount(h(CrewView, { onClose() {} }), cols!, rows!)
    await save(m, 'crew', cols!, rows!)
    check('Crew row retains active status', m.screen().includes('scout') && m.screen().includes(before ? 'first byte' : 'running'))
    await key(m, KEY.enter)
    await save(m, 'crew-detail', cols!, rows!)
    check('Crew detail retains phase facts', m.screen().includes('first byte'))
    m.unmount(); _resetFocusedSessionConnectorForTesting()

    const state = getDefaultAppState()
    state.extensions = { ...state.extensions, roster: [ext] as never, health: { [ext.id]: { outcome: 'partial', reasons: ['Command server unavailable; open extension details.'], notes: [] } } }
    m = await mount(h(ExtensionsBoard, { onClose() {}, route: { kind: 'board', section: 'installed' }, appendTranscript() {} }), cols!, rows!, state)
    await save(m, 'extensions', cols!, rows!)
    check('Extension row keeps partial status and detail action', m.screen().includes('partial') && (before || m.screen().includes('↵ details')))
    m.unmount()

    let consent = ''
    m = await mount(h(FallbackPermissionRequest, { toolUseConfirm: { tool, input: {}, description: tools[1].description, permissionResult: permission, toolUseID: 'craft-fixture', onAllow: () => { consent = 'allow' }, onReject: () => { consent = 'deny' } }, onDone() {}, onReject() {} } as never), cols!, rows!)
    await save(m, 'craft-install', cols!, rows!)
    if (!before) {
      check('Craft permission paints exact download size', m.screen().includes(plan.bytes.toLocaleString('en-US')))
      check('Craft permission paints the complete destination', m.lines().map(line => line.replace(/[│]/g, '').trim()).join('').includes(plan.destination))
    }
    await key(m, KEY.enter)
    check('Craft consent selection still calls allow', consent === 'allow')
    m.unmount()

    m = await mount(renderToolResultMessage(content, [], { verbose: false }), cols!, rows!)
    await save(m, 'craft-status', cols!, rows!)
    if (!before) check('Craft normal result omits raw path and JSON', m.screen().includes('not installed') && !m.screen().includes('destination'))
    m.unmount()
    m = await mount(renderToolResultMessage(content, [], { verbose: true }), cols!, rows!)
    await save(m, 'craft-status-detail', cols!, rows!)
    check('Craft detail preserves raw fields', m.screen().includes('destination') && m.screen().includes('bytes'))
    m.unmount()
    check('display never mutates the structured agent result', JSON.stringify(content) === agentResult)
  }
  check('no external fetches', networkCalls === 0)
  console.log(`Everyday wording: ${checks} checks passed${before ? ` at ${sourceRef}` : ''}`)
} finally {
  await client.close()
  popup.closeSettingsPopup()
  _resetFocusedSessionConnectorForTesting()
  globalThis.fetch = originalFetch
  await releaseScratchHome(home)
}
process.exit(0)
