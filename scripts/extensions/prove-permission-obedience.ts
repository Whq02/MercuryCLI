#!/usr/bin/env bun
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slashed } from '../lib/platformPath.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-perm-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const sources = await import('../../src/integrations/extensions/sources.ts')
const install = await import('../../src/integrations/extensions/install.ts')
const reloadMod = await import('../../src/integrations/extensions/reload.ts')
const loadServers = await import('../../src/integrations/extensions/load/servers.ts')
const health = await import('../../src/integrations/extensions/health.ts')
const { hasPermissionsToUseTool } = await import('../../src/permissions/rules/permissionDoor.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { connectToServer } = await import('../../src/integrations/mcp/client.ts')
const { classifyMcpToolRisk, getMaxExposedRiskForServer } = await import('../../src/integrations/mcp-shapes/toolPolicy.ts')
const { fireHooks } = await import('../../src/integrations/event-hooks/fire.ts')
const { startCommandHook } = await import('../../src/integrations/event-hooks/commandRunner.ts')
const state = await import('../../src/boot/process-state/processState.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')

function makeContext(mode: string, tools: unknown[] = []): { context: unknown; appState: { toolPermissionContext: Record<string, unknown> } } {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: mode as never }
  const appState = { toolPermissionContext }
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: { tools },
  }
  return { context, appState: appState as never }
}
const ASSISTANT = { message: { id: 'msg_perm' } } as never

console.log('============================================================')
console.log(' permission obedience — the kernel rule per contribution kind')
console.log('============================================================')

const added = await sources.addSource(FIXTURE, { label: 'fixture-source' })
check('the fixture source adds', added.ok, 'addSource in src/integrations/extensions/sources.ts refused scripts/extensions/fixtures/fixture-source: ' + JSON.stringify(added))
const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
check('kitchen-sink installs', installed.ok, 'installFromSource in src/integrations/extensions/install.ts refused kitchen-sink: ' + JSON.stringify(installed))
check('approve lands', install.approve('kitchen-sink@fixture-source').ok, 'approve in src/integrations/extensions/install.ts refused kitchen-sink@fixture-source')
await reloadMod.reloadExtensions({ cwd })

console.log('[1] the fixture server: own process, loopback stdio, through the real client')
const SERVER = 'ext:kitchen-sink:fixture'
const config = loadServers.getExtensionMcpServers()[SERVER]
check('the resolved config exists with the ext: name', config !== undefined && config.scope === 'dynamic' && config.extensionSource === 'kitchen-sink@fixture-source', 'getExtensionMcpServers in src/integrations/extensions/load/servers.ts must return ext:kitchen-sink:fixture with scope dynamic and extensionSource set; got ' + JSON.stringify(config))
const connection = await connectToServer(SERVER, config!)
check('the server connects (its own child process over stdio)', connection.type === 'connected', connection.type === 'failed' ? String((connection as { error?: string }).error) : connection.type + '; the fixture server config comes from getExtensionMcpServers in src/integrations/extensions/load/servers.ts and is started by connectToServer in src/integrations/mcp/client.ts')
const tools = connection.type === 'connected' ? (connection as unknown as { tools: Array<{ name: string; isReadOnly: () => boolean }> }).tools ?? [] : []
let readTool: { name: string } | undefined
let writeTool: { name: string } | undefined
const realToolName = (t: { name: string; mcpInfo?: { toolName?: string } }): string => t.mcpInfo?.toolName ?? t.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
if (connection.type === 'connected') {
  const { fetchToolsForClient } = await import('../../src/integrations/mcp/client.ts') as unknown as { fetchToolsForClient?: (c: unknown) => Promise<Array<{ name: string; isReadOnly: () => boolean }>> }
  let wrapped: Array<{ name: string; isReadOnly: () => boolean }> = tools
  if (wrapped.length === 0 && fetchToolsForClient) wrapped = await fetchToolsForClient(connection)
  readTool = wrapped.find(t => realToolName(t) === 'fixture_read')
  writeTool = wrapped.find(t => realToolName(t) === 'fixture_write')
  check('both tools arrive wrapped with the server-qualified names', readTool !== undefined && writeTool !== undefined, wrapped.map(t => t.name).join(',') + '; the MCP client in src/integrations/mcp/client.ts must wrap fixture_read and fixture_write')
  check('the annotations survive: read-only vs mutating', readTool !== undefined && writeTool !== undefined && (readTool as { isReadOnly: () => boolean }).isReadOnly() === true && (writeTool as { isReadOnly: () => boolean }).isReadOnly() === false, 'the MCP client in src/integrations/mcp/client.ts must carry the server tool annotations into isReadOnly')
}

console.log('[2] the decision chain per mode; the twin-server equivalence')
if (readTool && writeTool && config) {
  const twinConfig = { ...(config as Record<string, unknown>), scope: 'local' } as never
  delete (twinConfig as Record<string, unknown>)['extensionSource']
  const twin = await connectToServer('twin-fixture', twinConfig)
  check('the twin connects', twin.type === 'connected', 'connectToServer in src/integrations/mcp/client.ts failed for the same fixture server declared as a manual local server')
  const { fetchToolsForClient: fetchTwin } = await import('../../src/integrations/mcp/client.ts') as unknown as { fetchToolsForClient?: (c: unknown) => Promise<Array<{ name: string }>> }
  let twinTools = twin.type === 'connected' ? ((twin as unknown as { tools?: Array<{ name: string }> }).tools ?? []) : []
  if (twinTools.length === 0 && twin.type === 'connected' && fetchTwin) twinTools = await fetchTwin(twin)
  const twinRead = twinTools.find(t => realToolName(t) === 'fixture_read')
  const twinWrite = twinTools.find(t => realToolName(t) === 'fixture_write')
  check('the twin tools arrive', twinRead !== undefined && twinWrite !== undefined, twinTools.map(t => t.name).join(',') + '; the MCP client in src/integrations/mcp/client.ts must wrap fixture_read and fixture_write')
  const decide = async (tool: unknown, mode: string): Promise<{ behavior: string; message?: string; decisionReason?: { type?: string } }> =>
    hasPermissionsToUseTool(tool as never, {}, makeContext(mode).context as never, ASSISTANT, 'toolu_perm') as never
  for (const mode of ['default', 'sovereign', 'dontAsk'] as const) {
    const extRead = (await decide(readTool, mode)).behavior
    const extWrite = (await decide(writeTool, mode)).behavior
    const manualRead = twinRead ? (await decide(twinRead, mode)).behavior : '<no twin>'
    const manualWrite = twinWrite ? (await decide(twinWrite, mode)).behavior : '<no twin>'
    check(`${mode}: the extension's tools decide EXACTLY as any MCP tool (read ${extRead} · write ${extWrite})`, extRead === manualRead && extWrite === manualWrite, `ext ${extRead}/${extWrite} vs manual ${manualRead}/${manualWrite}; hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must not treat an extension server's tool differently from a manual MCP tool`)
  }
  let r = await decide(writeTool, 'default')
  check('default: the mutating tool reaches the consent path (ask)', r.behavior === 'ask', JSON.stringify(r) + '; hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must ask for a mutating MCP tool in default mode')
  check('…and the ask names the tool', (r.message ?? '').includes('fixture'), (r.message ?? '') + ' (the ask message from hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must name the tool)')
  r = await decide(writeTool, 'sovereign')
  check('sovereign: allowed by mode', r.behavior === 'allow' && r.decisionReason?.type === 'mode', JSON.stringify(r) + '; hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must allow by mode under sovereign')
  r = await decide(writeTool, 'dontAsk')
  check('dontAsk: the ask converts to a deny', r.behavior === 'deny', JSON.stringify(r) + '; hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must convert the ask to a deny under dontAsk')
  r = (await hasPermissionsToUseTool(writeTool as never, { value: 'wipe the fixture' }, makeContext('flow', [writeTool]).context as never, ASSISTANT, 'toolu_flow')) as never
  check('flow: the mutating MCP tool runs by mode — none of the five name an MCP call, as under sovereign', r.behavior === 'allow' && r.decisionReason?.type === 'mode', JSON.stringify(r) + '; hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must allow an MCP tool by mode under flow')
  if (twin.type === 'connected') await (twin as unknown as { cleanup?: () => Promise<void> }).cleanup?.()
}

console.log('[3] MERCURY_MCP_MAX_RISK clamps the mutating tool')
if (readTool && writeTool) {
  process.env.MERCURY_MCP_MAX_RISK = 'low'
  check('the ceiling reads low for the extension server', getMaxExposedRiskForServer(SERVER) === 'low', 'getMaxExposedRiskForServer in src/integrations/mcp-shapes/toolPolicy.ts must read MERCURY_MCP_MAX_RISK for the extension server')
  check('the mutating tool classifies above low', classifyMcpToolRisk({ readOnlyHint: false }) !== 'low', 'classifyMcpToolRisk in src/integrations/mcp-shapes/toolPolicy.ts must rate a non-read-only tool above low')
  const decide = async (tool: unknown): Promise<{ behavior: string; message?: string }> =>
    hasPermissionsToUseTool(tool as never, {}, makeContext('default').context as never, ASSISTANT, 'toolu_clamp') as never
  const clamped = await decide(writeTool)
  check('the clamped mutating tool DENIES with the policy reason', clamped.behavior === 'deny' && (clamped.message ?? '').length > 0, JSON.stringify(clamped) + '; hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must deny with a reason when the tool risk is above the ceiling from src/integrations/mcp-shapes/toolPolicy.ts')
  const readStill = await decide(readTool)
  check('the read-only tool still reaches the ordinary path', readStill.behavior === 'ask', JSON.stringify(readStill) + '; a read-only tool must stay on the ordinary ask path under the clamp (src/permissions/rules/permissionDoor.ts)')
  delete process.env.MERCURY_MCP_MAX_RISK
}

console.log('[4] an approved hook runs without a per-event ask; never before trust')
const ext = { extensionRoot: installed.ok ? installed.root : '', extensionId: 'kitchen-sink@fixture-source', extensionName: 'kitchen-sink' }
{
  const outDir = join(scratch, 'hook-out')
  mkdirSync(outDir, { recursive: true })
  const marker = join(outDir, 'ran.txt')
  state.registerHookCallbacks({ 'tool.after': [{ hooks: [{ name: 'ran mark', run: `sh -c 'echo ran >> "${slashed(marker)}"'` }], ...ext }] } as never)
  const drain = async (mode: string): Promise<string[]> => {
    const result = await fireHooks('tool.after', { tool: 'Write', input: {}, output: {}, call_id: 'toolu_hooks', ok: true, cut: false }, { scope: { sessionId: 'obedience' }, permissionMode: mode })
    return result.outcomes.map(outcome => outcome.state.kind)
  }
  state.setIsInteractive(true)
  await drain('default')
  const ranBeforeTrust = await import('node:fs').then(fs => fs.existsSync(marker))
  check('before workspace trust: the extension hook does NOT run (interactive session)', !ranBeforeTrust, 'fireHooks in src/integrations/event-hooks/fire.ts must run no hook while workspaceUntrustedForHooks() is true')
  const projectConfig = await import('../../src/platform/config/projectConfig.ts')
  projectConfig.saveCurrentProjectConfig(c => ({ ...c, hasTrustDialogAccepted: true }))
  for (const mode of ['default', 'sovereign']) {
    rmSync(marker, { force: true })
    const outcomes = await drain(mode)
    const ran = await import('node:fs').then(fs => fs.existsSync(marker))
    check(`with trust: the hook runs on its event in ${mode} with NO ask (outcomes: ${outcomes.join(',') || 'success'})`, ran && !outcomes.includes('ask'), `ran=${ran}; fireHooks in src/integrations/event-hooks/fire.ts must run an approved extension hook after workspace trust without an ask`)
  }
  state.setIsInteractive(false)
}

console.log('[5] exit 1 · timeout · flood — bounded, counted, the call continues')
{
  health.resetRuntimeCounters()
  state.clearRegisteredExtensionHooks()
  state.registerHookCallbacks({ 'tool.after': [{ hooks: [{ name: 'boom', run: 'sh -c "echo boom >&2; exit 1"' }], ...ext }] } as never)
  const fired = await fireHooks('tool.after', { tool: 'Write', input: {}, output: {}, call_id: 'toolu_fail', ok: true, cut: false }, { scope: { sessionId: 'obedience' } })
  const results = fired.outcomes.map(outcome => outcome.state.kind)
  check('exit 1 → a failed outcome with its one line; the fire completes (the session survives)', results.includes('failed') && fired.outcomes.some(outcome => outcome.state.kind === 'failed' && outcome.state.line.includes('boom')), (results.join(',') || '<no outcomes>') + '; fireHooks in src/integrations/event-hooks/fire.ts must return a failed outcome carrying the hook stderr line when a hook exits 1')
  const counted = health.hookFailuresFor('kitchen-sink@fixture-source')
  check('…and the failure is COUNTED for the one health owner', counted.size >= 1 && [...counted.values()][0]!.count >= 1, String(counted.size) + '; a failed hook must be counted through src/integrations/extensions/health.ts (hookFailuresFor)')
  state.clearRegisteredExtensionHooks()

  const source = { kind: 'extension' as const, id: ext.extensionId, root: ext.extensionRoot }
  const started = Date.now()
  const hung = await (await startCommandHook({ command: 'sleep 30', shell: 'bash', name: 'hang-probe', event: 'tool.after', index: 0, payloadJson: '{}', timeoutMs: 1_000, source })).result
  check('a hang is bounded by its own timeout (killed well under the 30s sleep)', Date.now() - started < 15_000 && hung.kind === 'ended' && hung.ending.class === 'timed_out', `elapsed=${Date.now() - started}ms ${hung.kind}; startCommandHook in src/integrations/event-hooks/commandRunner.ts must kill the hook at timeoutMs and end it as timed_out`)

  const flooded = await (await startCommandHook({ command: 'yes flood-line | head -c 30000000', shell: 'bash', name: 'flood-probe', event: 'tool.after', index: 0, payloadJson: '{}', timeoutMs: 60_000, source })).result
  check('a 30MB stdout flood returns BOUNDED output', flooded.stdout.length < 20_000_000, `stdout=${flooded.stdout.length} bytes; startCommandHook in src/integrations/event-hooks/commandRunner.ts must cap captured stdout (HOOK_OUTPUT_MAX_BYTES)`)
}

console.log('[6] allowed-tools authorises only the expansion, on a COPY of the state')
{
  const loadCommands = await import('../../src/integrations/extensions/load/commands.ts')
  const skill = loadCommands.getExtensionSkills().find(c => c.name === 'kitchen-sink:fixture-skill')
  check('the fixture skill is in the catalogue with its declared allowed-tools', skill !== undefined && Array.isArray((skill as { allowedTools?: string[] }).allowedTools) && (skill as { allowedTools: string[] }).allowedTools.length > 0, 'getExtensionSkills in src/integrations/extensions/load/commands.ts did not return kitchen-sink:fixture-skill with its allowed-tools')
  if (skill && skill.type === 'prompt') {
    const sessionState = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as never } }
    const seenRules: string[][] = []
    const context = {
      abortController: new AbortController(),
      getAppState: () => sessionState,
      setAppState: () => {},
      messages: [],
      agentType: undefined,
      options: {},
    }
    const copyProbe = {
      ...context,
      getAppState: () => {
        const copied = (context.getAppState as () => typeof sessionState)()
        return copied
      },
    }
    void copyProbe
    const blocks = await skill.getPromptForCommand('', context as never)
    check('the expansion produces the prompt', Array.isArray(blocks) && blocks.length === 1, 'getPromptForCommand of the extension skill (src/integrations/extensions/load/commands.ts) must return one block')
    check("the SESSION's own always-allow rules are untouched after the expansion", Object.keys(sessionState.toolPermissionContext.alwaysAllowRules as Record<string, unknown>).length === 0, JSON.stringify(sessionState.toolPermissionContext.alwaysAllowRules) + '; the skill expansion in src/integrations/extensions/load/commands.ts must apply allowed-tools to a copy of the app state, not the session state')
    void seenRules
  }
}

if (connection.type === 'connected') await (connection as unknown as { cleanup?: () => Promise<void> }).cleanup?.()
removeScratch(scratch)
console.log(failures === 0 ? '\n ✅ PERMISSION OBEDIENCE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
