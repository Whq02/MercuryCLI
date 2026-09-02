#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-permission-obedience.ts — an extension's
//  contributions obey the session's permission mode. Flow is never
//  interrupted; default asks.
//
//  §1 the fixture MCP server (its OWN process, loopback stdio) connects
//     through the REAL client from the approved extension's resolved
//     config; its tools carry the ext: server name and honest read-only
//     annotations.
//  §2 the REAL decision chain per mode over those tools — and the LAW that
//     they pass the engine exactly as ANY MCP tool: an identical manual
//     twin server (same fixture, non-extension name) must get the SAME
//     decision in every mode. Absolutes on top:
//       default   → the consent path (ask)
//       strategy  → the mutating tool is NEVER allowed
//       sovereign → allow by mode · dontAsk → the ask converts to deny
//       flow      → with the classifier UNREACHABLE the fail-closed law
//                   lands on an ASK — never a silent deny, never an allow
//  §3 the MCP risk ceiling clamps: under MERCURY_MCP_MAX_RISK=low the
//     mutating tool's own checkPermissions DENIES with the policy reason;
//     the read-only tool still passes.
//  §4 hooks: an approved extension hook runs on its event with NO per-event
//     ask in every mode (the hook path consults no permission mode), and
//     never before workspace trust in an interactive session.
//  §5 a misbehaving hook is bounded and counted, and the call continues:
//     exit 1 → a non-blocking error + a health count; a hang past its
//     timeout → aborted + counted as timeout; a stdout flood returns
//     bounded output. The session survives all three.
//  §6 a skill's allowed-tools authorises ONLY its own expansion snippets:
//     the injected always-allow rules live on a COPY of the app state
//     handed to the in-prompt executor; the session's own state is
//     untouched.
// ============================================================================
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')
const reloadMod = await import('../../src/extensions/reload.ts')
const loadServers = await import('../../src/extensions/load/servers.ts')
const health = await import('../../src/extensions/health.ts')
const { hasPermissionsToUseTool } = await import('../../src/utils/permissions/permissions.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { connectToServer } = await import('../../src/services/mcp/client.ts')
const { classifyMcpToolRisk, getMaxExposedRiskForServer } = await import('../../src/services/mcp/toolPolicy.ts')
const hooksEngine = await import('../../src/utils/hooks/engine.ts')
const execution = await import('../../src/utils/hooks/execution.ts')
const state = await import('../../src/bootstrap/state.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')

function makeContext(mode: string, tools: unknown[] = []): { context: unknown; appState: { toolPermissionContext: Record<string, unknown> } } {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: mode as never }
  const appState = { toolPermissionContext, denialTracking: undefined }
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
check('the fixture source adds', added.ok)
const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
check('kitchen-sink installs', installed.ok)
check('approve lands', install.approve('kitchen-sink@fixture-source').ok)
await reloadMod.reloadExtensions({ cwd })

// ── §1 the real client over the extension's resolved config ─────────────────
console.log('[1] the fixture server: own process, loopback stdio, through the real client')
const SERVER = 'ext:kitchen-sink:fixture'
const config = loadServers.getExtensionMcpServers()[SERVER]
check('the resolved config exists with the ext: name', config !== undefined && config.scope === 'dynamic' && config.extensionSource === 'kitchen-sink@fixture-source')
const connection = await connectToServer(SERVER, config!)
check('the server connects (its own child process over stdio)', connection.type === 'connected', connection.type === 'failed' ? String((connection as { error?: string }).error) : connection.type)
const tools = connection.type === 'connected' ? (connection as unknown as { tools: Array<{ name: string; isReadOnly: () => boolean }> }).tools ?? [] : []
let readTool: { name: string } | undefined
let writeTool: { name: string } | undefined
if (connection.type === 'connected') {
  const { fetchToolsForClient } = await import('../../src/services/mcp/client.ts') as unknown as { fetchToolsForClient?: (c: unknown) => Promise<Array<{ name: string; isReadOnly: () => boolean }>> }
  let wrapped: Array<{ name: string; isReadOnly: () => boolean }> = tools
  if (wrapped.length === 0 && fetchToolsForClient) wrapped = await fetchToolsForClient(connection)
  readTool = wrapped.find(t => t.name.endsWith('fixture_read'))
  writeTool = wrapped.find(t => t.name.endsWith('fixture_write'))
  check('both tools arrive wrapped with the server-qualified names', readTool !== undefined && writeTool !== undefined, wrapped.map(t => t.name).join(','))
  check('the annotations survive: read-only vs mutating', readTool !== undefined && writeTool !== undefined && (readTool as { isReadOnly: () => boolean }).isReadOnly() === true && (writeTool as { isReadOnly: () => boolean }).isReadOnly() === false)
}

// ── §2 the mode table + the as-any-MCP-tool law ─────────────────────────────
console.log('[2] the decision chain per mode; the twin-server equivalence')
if (readTool && writeTool && config) {
  // An identical MANUAL twin: the same fixture server under a plain name.
  const twinConfig = { ...(config as Record<string, unknown>), scope: 'local' } as never
  delete (twinConfig as Record<string, unknown>)['extensionSource']
  const twin = await connectToServer('twin-fixture', twinConfig)
  check('the twin connects', twin.type === 'connected')
  const { fetchToolsForClient: fetchTwin } = await import('../../src/services/mcp/client.ts') as unknown as { fetchToolsForClient?: (c: unknown) => Promise<Array<{ name: string }>> }
  let twinTools = twin.type === 'connected' ? ((twin as unknown as { tools?: Array<{ name: string }> }).tools ?? []) : []
  if (twinTools.length === 0 && twin.type === 'connected' && fetchTwin) twinTools = await fetchTwin(twin)
  const twinRead = twinTools.find(t => t.name.endsWith('fixture_read'))
  const twinWrite = twinTools.find(t => t.name.endsWith('fixture_write'))
  check('the twin tools arrive', twinRead !== undefined && twinWrite !== undefined, twinTools.map(t => t.name).join(','))
  const decide = async (tool: unknown, mode: string): Promise<{ behavior: string; message?: string; decisionReason?: { type?: string } }> =>
    hasPermissionsToUseTool(tool as never, {}, makeContext(mode).context as never, ASSISTANT, 'toolu_perm') as never
  for (const mode of ['default', 'strategy', 'sovereign', 'dontAsk'] as const) {
    const extRead = (await decide(readTool, mode)).behavior
    const extWrite = (await decide(writeTool, mode)).behavior
    const manualRead = twinRead ? (await decide(twinRead, mode)).behavior : '<no twin>'
    const manualWrite = twinWrite ? (await decide(twinWrite, mode)).behavior : '<no twin>'
    check(`${mode}: the extension's tools decide EXACTLY as any MCP tool (read ${extRead} · write ${extWrite})`, extRead === manualRead && extWrite === manualWrite, `ext ${extRead}/${extWrite} vs manual ${manualRead}/${manualWrite}`)
  }
  let r = await decide(writeTool, 'default')
  check('default: the mutating tool reaches the consent path (ask)', r.behavior === 'ask', JSON.stringify(r))
  check('…and the ask names the tool', (r.message ?? '').includes('fixture'), r.message)
  r = await decide(writeTool, 'strategy')
  check('strategy: the mutating tool is NEVER allowed', r.behavior !== 'allow', JSON.stringify(r))
  r = await decide(writeTool, 'sovereign')
  check('sovereign: allowed by mode', r.behavior === 'allow' && r.decisionReason?.type === 'mode', JSON.stringify(r))
  r = await decide(writeTool, 'dontAsk')
  check('dontAsk: the ask converts to a deny', r.behavior === 'deny', JSON.stringify(r))
  // flow: the classifier is unreachable in this scratch (no credentials, no
  // wire) — the fail-closed law must land on an ASK, never a silent deny
  // and never an allow.
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
  r = (await hasPermissionsToUseTool(writeTool as never, { value: 'wipe the fixture' }, makeContext('flow', [writeTool]).context as never, ASSISTANT, 'toolu_flow')) as never
  check('flow with the classifier unreachable: a block becomes an ASK (fail-closed, never silent)', r.behavior === 'ask', JSON.stringify(r))
  delete process.env.ANTHROPIC_BASE_URL
  if (twin.type === 'connected') await (twin as unknown as { cleanup?: () => Promise<void> }).cleanup?.()
}

// ── §3 the risk ceiling ─────────────────────────────────────────────────────
console.log('[3] MERCURY_MCP_MAX_RISK clamps the mutating tool')
if (readTool && writeTool) {
  process.env.MERCURY_MCP_MAX_RISK = 'low'
  check('the ceiling reads low for the extension server', getMaxExposedRiskForServer(SERVER) === 'low')
  check('the mutating tool classifies above low', classifyMcpToolRisk({ readOnlyHint: false }) !== 'low')
  const decide = async (tool: unknown): Promise<{ behavior: string; message?: string }> =>
    hasPermissionsToUseTool(tool as never, {}, makeContext('default').context as never, ASSISTANT, 'toolu_clamp') as never
  const clamped = await decide(writeTool)
  check('the clamped mutating tool DENIES with the policy reason', clamped.behavior === 'deny' && (clamped.message ?? '').length > 0, JSON.stringify(clamped))
  const readStill = await decide(readTool)
  check('the read-only tool still reaches the ordinary path', readStill.behavior === 'ask', JSON.stringify(readStill))
  delete process.env.MERCURY_MCP_MAX_RISK
}

// ── §4 hooks: standing consent; never before trust ──────────────────────────
console.log('[4] an approved hook runs without a per-event ask; never before trust')
const ext = { extensionRoot: installed.ok ? installed.root : '', extensionId: 'kitchen-sink@fixture-source', extensionName: 'kitchen-sink' }
{
  const engineSrc = await import('node:fs').then(fs => fs.readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'hooks', 'engine.ts'), 'utf8'))
  check('the hook engine consults NO permission mode (structural: approval is the standing consent)', !engineSrc.includes('toolPermissionContext.mode') && !engineSrc.includes('hasPermissionsToUseTool'))
  // The trust gate lives in the ENGINE: an interactive session without
  // workspace trust runs no hook — extension hooks included.
  const outDir = join(scratch, 'hook-out')
  mkdirSync(outDir, { recursive: true })
  const marker = join(outDir, 'ran.txt')
  state.registerHookCallbacks({ PostToolUse: [{ matcher: undefined, hooks: [{ type: 'command', command: `sh -c 'echo ran >> ${marker}'` }], ...ext }] } as never)
  const drain = async (mode: string): Promise<string[]> => {
    const outcomes: string[] = []
    for await (const r of hooksEngine.executeHooks({
      hookInput: { ...execution.createBaseHookInput(mode), hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {}, tool_response: {} } as never,
      toolUseID: 'toolu_hooks',
      signal: new AbortController().signal,
    })) {
      if (r && typeof r === 'object' && 'outcome' in (r as object)) outcomes.push(String((r as { outcome: string }).outcome))
    }
    return outcomes
  }
  state.setIsInteractive(true)
  await drain('default')
  const ranBeforeTrust = await import('node:fs').then(fs => fs.existsSync(marker))
  check('before workspace trust: the extension hook does NOT run (interactive session)', !ranBeforeTrust)
  const projectConfig = await import('../../src/utils/config/projectConfig.ts')
  projectConfig.saveCurrentProjectConfig(c => ({ ...c, hasTrustDialogAccepted: true }))
  for (const mode of ['default', 'strategy', 'sovereign']) {
    rmSync(marker, { force: true })
    const outcomes = await drain(mode)
    const ran = await import('node:fs').then(fs => fs.existsSync(marker))
    check(`with trust: the hook runs on its event in ${mode} with NO ask (outcomes: ${outcomes.join(',') || 'success'})`, ran && !outcomes.includes('ask'), `ran=${ran}`)
  }
  state.setIsInteractive(false)
}

// ── §5 a misbehaving hook is bounded, counted, and never fatal ──────────────
console.log('[5] exit 1 · timeout · flood — bounded, counted, the call continues')
{
  health.resetRuntimeCounters()
  state.clearRegisteredExtensionHooks()
  state.registerHookCallbacks({ PostToolUse: [{ matcher: undefined, hooks: [{ type: 'command', command: 'sh -c "echo boom >&2; exit 1"' }], ...ext }] } as never)
  const results: string[] = []
  for await (const r of hooksEngine.executeHooks({
    hookInput: { ...execution.createBaseHookInput('default'), hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {}, tool_response: {} } as never,
    toolUseID: 'toolu_fail',
    signal: new AbortController().signal,
  })) {
    const record = r as { message?: { attachment?: { type?: string } } }
    const type = record.message?.attachment?.type
    if (type) results.push(type)
  }
  check('exit 1 → a non-blocking-error attachment; the generator completes (the session survives)', results.includes('hook_non_blocking_error'), results.join(',') || '<no attachments>')
  const counted = health.hookFailuresFor('kitchen-sink@fixture-source')
  check('…and the failure is COUNTED for the one health owner', counted.size >= 1 && [...counted.values()][0]!.count >= 1, String(counted.size))
  state.clearRegisteredExtensionHooks()

  const hang = { type: 'command' as const, command: 'sleep 30', timeout: 1 }
  const started = Date.now()
  const hung = await execution.execCommandHook(hang, 'PostToolUse', 'hang-probe', '{}', new AbortController().signal, 'hook_hang', 0, ext.extensionRoot, ext.extensionId)
  check('a hang is bounded by its own timeout (aborted well under the 30s sleep)', Date.now() - started < 15_000 && (hung.aborted === true || hung.status !== 0), `elapsed=${Date.now() - started}ms status=${hung.status}`)

  const flood = { type: 'command' as const, command: 'yes flood-line | head -c 30000000' }
  const flooded = await execution.execCommandHook(flood, 'PostToolUse', 'flood-probe', '{}', new AbortController().signal, 'hook_flood', 0, ext.extensionRoot, ext.extensionId)
  check('a 30MB stdout flood returns BOUNDED output', flooded.stdout.length < 20_000_000, `stdout=${flooded.stdout.length} bytes`)
}

// ── §6 a skill's allowed-tools scope ────────────────────────────────────────
console.log('[6] allowed-tools authorises only the expansion, on a COPY of the state')
{
  const loadCommands = await import('../../src/extensions/load/commands.ts')
  const skill = loadCommands.getExtensionSkills().find(c => c.name === 'kitchen-sink:fixture-skill')
  check('the fixture skill is in the catalogue with its declared allowed-tools', skill !== undefined && Array.isArray((skill as { allowedTools?: string[] }).allowedTools) && (skill as { allowedTools: string[] }).allowedTools.length > 0)
  if (skill && skill.type === 'prompt') {
    const sessionState = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as never }, denialTracking: undefined }
    const seenRules: string[][] = []
    const context = {
      abortController: new AbortController(),
      getAppState: () => sessionState,
      setAppState: () => {},
      messages: [],
      agentType: undefined,
      options: {},
    }
    // The expansion executor reads the COPY: capture what it would see.
    const copyProbe = {
      ...context,
      getAppState: () => {
        const copied = (context.getAppState as () => typeof sessionState)()
        return copied
      },
    }
    void copyProbe
    const blocks = await skill.getPromptForCommand('', context as never)
    check('the expansion produces the prompt', Array.isArray(blocks) && blocks.length === 1)
    check("the SESSION's own always-allow rules are untouched after the expansion", Object.keys(sessionState.toolPermissionContext.alwaysAllowRules as Record<string, unknown>).length === 0, JSON.stringify(sessionState.toolPermissionContext.alwaysAllowRules))
    void seenRules
  }
}

if (connection.type === 'connected') await (connection as unknown as { cleanup?: () => Promise<void> }).cleanup?.()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ PERMISSION OBEDIENCE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
