#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { getPlatform } from '../../src/utils/platform.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DESKTOP_DRIVER = 'fake'
process.env.BROWSER = '/usr/bin/true'
for (const key of ['MERCURY_COMPUTER_USE', 'MERCURY_COMPUTER_ACCESS', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_DESKTOP_FAKE_SCENE']) delete process.env[key]

const ROOT = resolve(import.meta.dir, '..', '..')
const source = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermission, postureBypassesAsks } = await import('../../src/utils/permissions/decision/engine.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { hasPermissionsToUseTool } = await import('../../src/utils/permissions/permissions.ts')
const { resolveHookPermissionDecision } = await import('../../src/services/tools/toolHooks.ts')
const { resolveComputerAccess, COMPUTER_ACCESS_VALUES } = await import('../../src/substrate/startupMenu.ts')
const { resolveSessionPermissionMode, validateModeEntry } = await import('../../src/utils/permissions/permissionSetup.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { PowerShellTool } = await import('../../src/tools/PowerShellTool/PowerShellTool.tsx')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const desktop = await import('../../src/services/desktop/desktopSession.ts')
const { toolContext, withScreenshot, ownerOf } = await import('../computer/computerToolKit.ts')
const { createRunnerAsks } = await import('../../src/cli/headless/runnerAsks.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')
const { z } = await import('zod/v4')

type Mode = 'default' | 'sovereign'
type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; road?: string; mode?: string } }
type Outcome = { decision: Decision; trace: { decidedBy: string } }

function contextOf(mode: Mode, rules: { ask?: string[]; allow?: string[]; deny?: string[] } = {}) {
  const permission = {
    ...getEmptyToolPermissionContext(),
    mode,
    isBypassPermissionsModeAvailable: mode === 'sovereign',
    alwaysAskRules: rules.ask ? { localSettings: rules.ask } : {},
    alwaysAllowRules: rules.allow ? { localSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { localSettings: rules.deny } : {},
  }
  const state = { toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages: [],
    readFileState: new Map(),
    getAppState: () => state,
    setAppState: () => undefined,
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
  } as never
}

const stubTool = (name: string, verdict: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ name, inputSchema: z.object({}).passthrough(), checkPermissions: async () => verdict, ...extra }) as never

const decide = (tool: unknown, input: Record<string, unknown>, context: unknown): Promise<Outcome> =>
  decideToolPermission(tool as never, input, context as never) as unknown as Promise<Outcome>

const SHARE = String.raw`\\fileserver\projects\notes.txt`
const assistant = { message: { id: 'zero-cards' } } as never

section('§0 the law in source: one posture predicate, one card road')
{
  check('the posture predicate is the shared modeBypassesPermissions read on the permission context', postureBypassesAsks({ mode: 'sovereign' }) === true && postureBypassesAsks({ mode: 'default' }) === false && postureBypassesAsks({ mode: 'flow' }) === false)
  const pushers: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry) && /\bpushToQueue\(/.test(readFileSync(path, 'utf8'))) pushers.push(path.slice(ROOT.length + 1))
    }
  }
  walk(join(ROOT, 'src'))
  check('the permission card has ONE pusher in src (the interactive handler) besides the queue definition', pushers.sort().join(',') === 'src/hooks/toolPermission/PermissionContext.ts,src/hooks/toolPermission/handlers/interactiveHandler.ts', pushers.join(','))
  const declaring: string[] = []
  const walkTools = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walkTools(path)
      else if (/\.(ts|tsx)$/.test(entry) && /requiresUserInteraction\(\)\s*(?::\s*boolean\s*)?\{/.test(readFileSync(path, 'utf8'))) declaring.push(path.slice(ROOT.length + 1))
    }
  }
  walkTools(join(ROOT, 'src', 'tools'))
  check('exactly three tools declare an interaction-mandatory ask: the two model questions and the Computer tool', declaring.sort().join(',') === 'src/tools/ApolloReviewTool/ApolloReviewTool.tsx,src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx,src/tools/ComputerTool/ComputerTool.ts', declaring.join(','))
  check('the Computer tool reads the posture in its own verdict (the one predicate)', source('src/tools/ComputerTool/ComputerTool.ts').includes('postureBypassesAsks('))
  check('the hook seam reads the posture before it can force an ask', source('src/services/tools/toolHooks.ts').includes('postureBypassesAsks('))
  check('the engine has no bypass-immune safety floor: no ask survives the posture at 1g', !/floor/.test(source('src/utils/permissions/decision/engine.ts')))
  check('the safetyCheck reason carries no floor field', !/floor/.test(source('src/types/permissions.ts')))
  for (const file of ['src/utils/permissions/filesystem.ts', 'src/utils/permissions/pathValidation.ts', 'src/tools/BashTool/bashPermissions.ts']) {
    check(`${file} marks no verdict as a floor`, !/floor: true/.test(source(file)))
  }
}

section('§1 the roads that already stand down: every plain ask verdict is ALLOWED under the posture, named in the reason')
{
  const roads: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ['a passthrough verdict (the ordinary ask)', { behavior: 'passthrough', message: 'Permission?' }, {}, 'bypassPosture'],
    ['an ask the tool cannot classify (other)', { behavior: 'ask', message: 'needs approval', decisionReason: { type: 'other', reason: 'unclassified' } }, {}, 'bypassPosture'],
    ['an ask outside the starting folder (workingDir)', { behavior: 'ask', message: 'outside', decisionReason: { type: 'workingDir', reason: 'the path is outside the starting folder' } }, {}, 'bypassPosture'],
    ['a plain operator-only safety check', { behavior: 'ask', message: 'sensitive', decisionReason: { type: 'safetyCheck', reason: 'sensitive', operatorOnly: true } }, {}, 'safetyCheckAsk'],
    ['a content ask rule', { behavior: 'ask', message: 'rule', decisionReason: { type: 'rule', rule: { source: 'localSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'Stub', ruleContent: 'x' } } } }, {}, 'contentAskRule'],
    ['the MCP org ask ceiling', { behavior: 'passthrough', message: 'org' }, { mcpInfo: { effectiveMaxPermission: 'ask' } }, 'orgAskCeiling'],
    ['the Browser provision consent (a plain ask with the plan as its reason)', { behavior: 'ask', message: 'Browser provision: download Chrome for Testing', decisionReason: { type: 'other', reason: 'build 140 · 160 MB' }, updatedInput: { op: 'provision', buildId: '140' } }, {}, 'bypassPosture'],
  ]
  for (const [label, verdict, extra, stage] of roads) {
    const tool = stubTool(extra.mcpInfo ? 'mcp__org__stub' : 'Stub', verdict, extra)
    const under = await decide(tool, { op: 'x' }, contextOf('sovereign'))
    check(`${label}: allowed at ${stage} under sovereign`, under.decision.behavior === 'allow' && under.trace.decidedBy === stage, JSON.stringify({ decidedBy: under.trace.decidedBy, decision: under.decision }))
    const outside = await decide(tool, { op: 'x' }, contextOf('default'))
    check(`${label}: still asks in default mode`, outside.decision.behavior === 'ask', JSON.stringify(outside.decision))
  }
  const askRule = stubTool('Stub', { behavior: 'allow', updatedInput: {} })
  const carried = await decide(askRule, {}, contextOf('sovereign', { ask: ['Stub'] }))
  check('a whole-tool ask rule is carried past the verdict and allowed (the carry is the road)', carried.decision.behavior === 'allow' && carried.trace.decidedBy === 'toolAskRuleCarried' && carried.decision.decisionReason?.type === 'bypassedAsk', JSON.stringify(carried))
  const denied = await decide(askRule, {}, contextOf('sovereign', { deny: ['Stub'] }))
  check('a deny rule still refuses under sovereign (a refusal is not a card)', denied.decision.behavior === 'deny' && denied.trace.decidedBy === 'toolDenyRule')
  const wrapped = await decideToolPermissionWithModes(stubTool('Stub', { behavior: 'ask', message: 'ask', decisionReason: { type: 'other', reason: 'x' } }), { op: 'x' }, contextOf('sovereign'), assistant, 'toolu_wrapped')
  check('the mode wrapper adds no ask of its own under sovereign (its floors are Flow\'s)', wrapped.decision.behavior === 'allow' && wrapped.wrapper.decidedBy === 'engine', JSON.stringify(wrapped.wrapper))
}

section('§2 the Windows share road (A2): a UNC path asks on Windows and never on the Mac — under sovereign it must not ask on either')
{
  getPlatform.cache.set(undefined, 'windows')
  const fileRoads: Array<[string, unknown, Record<string, unknown>]> = [
    ['Edit', FileEditTool, { file_path: SHARE, old_string: 'old', new_string: 'new' }],
    ['Write', FileWriteTool, { file_path: SHARE, content: 'new' }],
    ['Read', FileReadTool, { file_path: SHARE }],
    ['Glob', GlobTool, { path: SHARE, pattern: '*' }],
    ['Grep', GrepTool, { path: SHARE, pattern: 'text' }],
    ['ChangeSet', ChangeSetTool, { op: 'preview', changes: [{ file_path: SHARE, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '1', replace: 'new' }] }] }],
    ['Bash', BashTool, { command: String.raw`type \\fileserver\projects\notes.txt` }],
    ['PowerShell', PowerShellTool, { command: String.raw`Get-Content \\fileserver\projects\notes.txt` }],
  ]
  for (const [name, tool, input] of fileRoads) {
    const outside = await decide(tool, input, contextOf('default'))
    check(`${name} ${SHARE}: asks in default mode on Windows with the share sentence (unchanged)`, outside.decision.behavior === 'ask' && (outside.decision.message ?? '').includes('SMB/WebDAV'), JSON.stringify(outside.decision))
    const under = await decide(tool, input, contextOf('sovereign'))
    check(`${name} ${SHARE}: ALLOWED under sovereign — the share sentence rides the allowance, no card`, under.decision.behavior === 'allow' && under.decision.decisionReason?.type === 'bypassedAsk' && under.decision.decisionReason.road === 'safetyCheckAsk', JSON.stringify({ decidedBy: under.trace.decidedBy, decision: under.decision }))
  }
  const shareSpellings: Array<[string, string]> = [
    ['forward-slash UNC', '//fileserver/projects/notes.txt'],
    ['WSL share', String.raw`\\wsl.localhost\Ubuntu\home\alice\proj\notes.txt`],
    ['WSL share, forward slashes', '//wsl.localhost/Ubuntu/home/alice/proj/notes.txt'],
    ['legacy WSL share', String.raw`\\wsl$\Ubuntu\home\alice\proj\notes.txt`],
    ['administrative share on this box', String.raw`\\localhost\C$\Users\Alice\m34-play\share\notes.txt`],
    ['extended-length UNC', String.raw`\\?\UNC\fileserver\projects\notes.txt`],
  ]
  for (const [label, spelling] of shareSpellings) {
    const outside = await decide(FileReadTool, { file_path: spelling }, contextOf('default'))
    check(`Read ${label} ${spelling}: asks in default mode on Windows with the share sentence`, outside.decision.behavior === 'ask' && (outside.decision.message ?? '').includes('SMB/WebDAV'), JSON.stringify(outside.decision))
    const under = await decide(FileReadTool, { file_path: spelling }, contextOf('sovereign'))
    check(`Read ${label}: ALLOWED under sovereign, the share sentence on the allowance`, under.decision.behavior === 'allow' && under.decision.decisionReason?.type === 'bypassedAsk' && under.decision.decisionReason.road === 'safetyCheckAsk', JSON.stringify(under.decision))
    const shell = await decide(PowerShellTool, { command: `Get-Content ${spelling}` }, contextOf('sovereign'))
    check(`PowerShell Get-Content ${label}: no card under sovereign`, shell.decision.behavior === 'allow', JSON.stringify(shell.decision))
  }
  for (const [label, spelling] of [['a mapped drive, forward slashes', 'Z:/proj/notes.txt'], ['a local path with forward slashes', 'C:/Users/Alice/proj/notes.txt']] as const) {
    const read = await decide(FileReadTool, { file_path: spelling }, contextOf('sovereign'))
    check(`Read ${label} ${spelling}: a drive letter carries no host, so no share question and no card under sovereign (the backslash spelling Z:\\proj needs a win32 path.resolve — the Windows box's check)`, read.decision.behavior === 'allow' && read.decision.decisionReason?.type !== 'bypassedAsk', JSON.stringify(read.decision))
  }
  getPlatform.cache.set(undefined, 'macos')
  const mac = await decide(FileEditTool, { file_path: SHARE, old_string: 'old', new_string: 'new' }, contextOf('sovereign'))
  check('on the Mac the same spelling never raised the share question; under sovereign it is allowed too (whatever does not ask on the Mac must not ask on Windows)', mac.decision.behavior === 'allow', JSON.stringify(mac.decision))
  getPlatform.cache.delete(undefined)
}

section('§3 the Computer first-act card (A1): a saved access type never asks under sovereign')
{
  for (const saved of COMPUTER_ACCESS_VALUES) {
    const access = resolveComputerAccess(saved, true)
    check(`access saved as ${saved}: under sovereign the access is full, by sovereign mode`, access.value === 'full' && access.source === 'sovereign mode', JSON.stringify(access))
    const off = resolveComputerAccess(saved, false)
    check(`access saved as ${saved}: with sovereign off the saved value stands`, off.value === saved && off.source === 'saved', JSON.stringify(off))
  }
  check('unset access follows the posture: asks with it off, full with it on', resolveComputerAccess(null, false).value === 'asks' && resolveComputerAccess(null, true).value === 'full')
  const scenes: Array<['asks' | 'permissive', Mode, string, string]> = [
    ['asks', 'default', 'ask', 'userInteractionAsk'],
    ['asks', 'sovereign', 'allow', 'bypassPosture'],
    ['permissive', 'sovereign', 'allow', 'bypassPosture'],
  ]
  for (const [saved, mode, behavior, stage] of scenes) {
    delete process.env.MERCURY_DESKTOP_FAKE_SCENE
    resetDesktopDriverForTest()
    const base = toolContext()
    const owner = ownerOf(base)
    desktop.forgetDesktopOwner(owner)
    const shot = await withScreenshot(ComputerTool as never, base, `toolu_zero_cards_${saved}_${mode}`)
    check(`${saved} · ${mode}: the opening screenshot succeeds`, shot.outcome === 'succeeded', shot.result)
    process.env.MERCURY_COMPUTER_ACCESS = saved
    const permission = shot.context.getAppState().toolPermissionContext as { mode: string; isBypassPermissionsModeAvailable?: boolean }
    permission.mode = mode
    permission.isBypassPermissionsModeAvailable = mode === 'sovereign'
    const first = await decide(ComputerTool, { action: 'click', x: 812, y: 300 }, shot.context)
    check(`${saved} · ${mode}: the first act in the application in front is ${behavior === 'ask' ? 'asked' : 'allowed'} at ${stage}`, first.decision.behavior === behavior && first.trace.decidedBy === stage, JSON.stringify({ decidedBy: first.trace.decidedBy, decision: first.decision }))
    if (mode === 'sovereign') {
      const typedIntoTerminal = await decide(ComputerTool, { action: 'type', text: 'hi' }, shot.context)
      check(`${saved} · ${mode}: the act runs as full access (no per-application grant written)`, desktop.appApproved(owner, 'com.example.TextEdit') === false)
      void typedIntoTerminal
    }
    delete process.env.MERCURY_COMPUTER_ACCESS
    desktop.forgetDesktopOwner(owner)
  }
  resetDesktopDriverForTest()
}

section('§4 the hook ask (B): a tool.before hook answering ask forces a card in every posture today — under sovereign it must not')
{
  const canUseTool = (async (tool: never, input: never, context: never, message: never, id: never, forced?: Decision) =>
    forced ?? (await hasPermissionsToUseTool(tool, input, context, message, id))) as never
  const tool = stubTool('Stub', { behavior: 'allow', updatedInput: {} })
  const hookAsk = { behavior: 'ask' as const, message: 'A hook (gate) asks this Stub call', decisionReason: { type: 'hook' as const, hookName: 'gate' } }
  const under = await resolveHookPermissionDecision(hookAsk, tool, { op: 'x' }, contextOf('sovereign'), canUseTool, assistant, 'toolu_hook_sov')
  check('under sovereign the hook\'s ask is no card: the engine decides and allows', under.decision.behavior === 'allow', JSON.stringify(under.decision))
  const outside = await resolveHookPermissionDecision(hookAsk, tool, { op: 'x' }, contextOf('default'), canUseTool, assistant, 'toolu_hook_default')
  check('in default mode the hook\'s ask still reaches the card (unchanged)', outside.decision.behavior === 'ask' && outside.decision.message === hookAsk.message, JSON.stringify(outside.decision))
  const rewritten = await resolveHookPermissionDecision({ ...hookAsk, updatedInput: { op: 'rewritten' } }, tool, { op: 'x' }, contextOf('sovereign'), canUseTool, assistant, 'toolu_hook_rewrite')
  check('the hook\'s rewritten input still rides the allowed call', rewritten.decision.behavior === 'allow' && JSON.stringify(rewritten.input) === JSON.stringify({ op: 'rewritten' }), JSON.stringify(rewritten))
  const deniedByRule = await resolveHookPermissionDecision(hookAsk, tool, { op: 'x' }, contextOf('sovereign', { deny: ['Stub'] }), canUseTool, assistant, 'toolu_hook_deny')
  check('a deny rule still refuses the call the hook asked about', deniedByRule.decision.behavior === 'deny', JSON.stringify(deniedByRule.decision))
  const hookDeny = await resolveHookPermissionDecision({ behavior: 'deny', message: 'blocked by the hook' }, tool, { op: 'x' }, contextOf('sovereign'), canUseTool, assistant, 'toolu_hook_block')
  check('a hook\'s block still refuses under sovereign (a refusal is not a card)', hookDeny.decision.behavior === 'deny' && hookDeny.decision.message === 'blocked by the hook')
}

section('§5 the hosted runner and the daemon-hosted cockpit (E): the runner parks an ask on its host and the cockpit mirrors it — under sovereign nothing is parked')
{
  getPlatform.cache.set(undefined, 'windows')
  const toHost = new PassThrough()
  const toRunner = new PassThrough()
  const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
  const host = createPeer({ input: toHost, output: toRunner, side: 'host', log() {} })
  const capabilities = { holds_asks: true, elicitation: false, partial_rows: false }
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'zero-cards' }))
  await host.request('initialize', { protocol: 1, host: { name: 'proof', version: '1' }, capabilities })
  const runnerAsks = createRunnerAsks(runner, () => capabilities)
  let seen: unknown = null
  host.onRequest('permission/request', params => {
    seen = params
    return new Promise(() => {}) as never
  })
  const context = contextOf('sovereign') as { abortController: AbortController }
  const decision = runnerAsks.createCanUseTool()(FileEditTool as never, { file_path: SHARE, old_string: 'old', new_string: 'new' }, context as never, assistant, 'toolu_hosted')
  const result = await Promise.race([decision, sleep(800).then(() => null)])
  check('the share edit under sovereign is allowed by the runner itself — nothing travels to the host, nothing is parked', result !== null && (result as Decision).behavior === 'allow' && runnerAsks.parkedAsks() === 0 && seen === null, JSON.stringify({ result, parked: runnerAsks.parkedAsks(), seen }))
  context.abortController.abort()
  host.end()
  runner.end()
  getPlatform.cache.delete(undefined)
  check('the daemon-hosted cockpit paints only what the runner parked (readAsks → buildConfirm reads no posture of its own: an empty projection is an empty queue)', /readSessionAsks\(this\.record\.sessionId\)/.test(source('src/services/engine-connector/daemonConnector.ts')) && /private buildConfirm\(row: SessionAskProjectionV1\)/.test(source('src/services/engine-connector/daemonConnector.ts')))
}

section('§6 the arming of sovereign is untouched: the launch flag or the Boot Menu row, never a typed mode or a saved setting')
{
  const typed = resolveSessionPermissionMode({ permissionModeCli: 'sovereign', dangerouslySkipPermissions: false })
  check('--mode sovereign without the flag does not arm the posture', typed.mode !== 'sovereign' && typeof typed.notification === 'string', JSON.stringify(typed))
  const flagged = resolveSessionPermissionMode({ permissionModeCli: undefined, dangerouslySkipPermissions: true })
  check('the launch flag arms it, from the flag', flagged.mode === 'sovereign' && flagged.source === 'launch-flag', JSON.stringify(flagged))
  const row = resolveSessionPermissionMode({ permissionModeCli: undefined, dangerouslySkipPermissions: true, envBypassArmed: true })
  check('the Boot Menu row arms it, from the session\'s birth', row.mode === 'sovereign' && row.source === 'session-birth', JSON.stringify(row))
  const entry = validateModeEntry('sovereign', { ...getEmptyToolPermissionContext(), mode: 'default' } as never)
  check('a session not launched with the flag cannot enter sovereign by hand', entry.ok === false && /--sovereign/.test(entry.ok ? '' : entry.error), JSON.stringify(entry))
}

console.log(`\nsovereign zero cards: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
