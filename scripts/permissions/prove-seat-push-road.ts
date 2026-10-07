#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'seat-push-road-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV
delete process.env.MERCURY_RUNTIME_POSTURE
delete process.env.MERCURY_KILL
delete process.env.MERCURY_MCP_MAX_RISK
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

import { z } from 'zod/v4'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
await import('../../src/Tool.ts')
const { decideToolPermissionWithModes, defaultWrapperPorts } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { stripDangerousPermissionsForAutoMode } = await import('../../src/utils/permissions/permissionSetup.ts')
const { loadAllPermissionRulesFromDisk } = await import('../../src/utils/permissions/permissionsLoader.ts')
const { applyPermissionRulesToPermissionContext } = await import('../../src/utils/permissions/permissions.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { setAskChannel } = await import('../../src/bootstrap/state.ts')
const posture = await import('../../src/utils/cockpit/runtimePosture.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the seat push-road proof exceeded 120s (a row reached a live path?)')
  process.exit(1)
}, 120_000)
guard.unref?.()

const PUSH = 'git push -q origin HEAD'
const PUSH_TAILED = 'git push -q 2>&1 | tail -1; git status -sb | head -1'
const PROTOCOL_CHAIN = 'git commit -q -m claim -- docs/claim-lock.md && git pull --rebase --quiet; git push -q; git status -sb'
const PUSH_RULE = 'Bash(git push *)'
const CHAIN_RULES = ['Bash(git commit *)', 'Bash(git pull *)', PUSH_RULE]

type Source = 'userSettings' | 'projectSettings' | 'localSettings' | 'cliArg' | 'session'
type Rules = { allow?: string[]; deny?: string[]; ask?: string[] }
type Mode = 'default' | 'flow' | 'implement' | 'dontAsk' | 'sovereign'

function contextOf(mode: Mode, rules: Rules = {}, source: Source = 'userSettings'): Record<string, unknown> {
  return {
    ...getEmptyToolPermissionContext(),
    mode,
    alwaysAllowRules: rules.allow ? { [source]: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { [source]: rules.deny } : {},
    alwaysAskRules: rules.ask ? { [source]: rules.ask } : {},
    isBypassPermissionsModeAvailable: mode === 'sovereign',
  }
}

type Stamp = ((context: unknown) => void) | undefined
const stampBootRules: Stamp = (posture as { markSessionBootRules?: (context: unknown) => void }).markSessionBootRules
type Compose = ((mode: string | undefined, context: unknown) => string | null) | undefined
const composeLine: Compose = (posture as { composeOperatorNeedsLine?: (mode: string | undefined, context: unknown) => string | null }).composeOperatorNeedsLine

function postureFor(channel: 'sdk' | 'none', mode: Mode | undefined, context: Record<string, unknown> | undefined): string {
  posture.resetRuntimePostureForTest()
  setAskChannel(channel)
  if (mode !== undefined) posture.markSessionNonInteractive(mode)
  if (context !== undefined) stampBootRules?.(context)
  return posture.getRuntimePostureSection() ?? ''
}
const sessionLine = (text: string): string => text.split('\n').find(line => line.startsWith('- Session:')) ?? ''
const needsLine = (text: string): string => text.split('\n').find(line => /present operator/.test(line)) ?? ''

console.log('============================================================')
console.log(' the push road on a headless seat — told up front, pre-authorised by the operator, never by default')
console.log('============================================================')

section('§1 the boot posture of a seat with a permission channel says which calls need a present operator — from the rules it carries')
{
  check('the posture composer takes the boot rules (markSessionBootRules)', typeof stampBootRules === 'function', 'runtimePosture.ts exports no markSessionBootRules — the seat cannot say what its rules pre-authorise')
  check('the sentence has one composer (composeOperatorNeedsLine)', typeof composeLine === 'function', 'runtimePosture.ts exports no composeOperatorNeedsLine')

  const bare = postureFor('sdk', 'flow', contextOf('flow'))
  const bareLine = needsLine(bare)
  check('flow seat, no push rule: the posture carries a line naming the calls that need a present operator', bareLine !== '', `posture:\n${bare}`)
  check('…the line names the channel (the call travels it and waits for the answer)', /channel/.test(bareLine), bareLine)
  check('…the line names a question to the operator and a review approval as calls that always travel', /question to the operator/.test(bareLine) && /review approval/.test(bareLine), bareLine)
  check('…the line names the flow road: the calls no rule covers and no shortcut settles, anything visible outside this machine', /flow/.test(bareLine) && /no shortcut settles/.test(bareLine) && /outside this machine/.test(bareLine), bareLine)
  check('…the line says `git push` is NOT pre-authorised by the rules this seat carries', /`git push` is not pre-authorised/.test(bareLine), bareLine)
  check('…and says a push waits on the operator', /push waits/.test(bareLine), bareLine)
  check('…and names the rule shape and the two roads an operator pre-authorises it by', /Bash\(git push \*\)/.test(bareLine) && /guardrails\.allow/.test(bareLine) && /--allowed-tools/.test(bareLine), bareLine)
  check('…and says a rule-allowed call runs without the channel', /without the channel/.test(bareLine), bareLine)
  check('…one line, no line break inside (the posture block is one bullet per fact)', bareLine.startsWith('- ') && !bareLine.includes('\n'), bareLine)
  check('…labelled at boot (the rules can change mid-session; the live surface is the card)', /at boot/.test(bareLine), bareLine)
  check('the session line itself is what it was (the host words stand)', /with a host that holds the asks/.test(sessionLine(bare)) && /answers allow or deny/.test(sessionLine(bare)) && /Permission mode for this run: flow/.test(sessionLine(bare)), sessionLine(bare))

  const allowed = postureFor('sdk', 'flow', contextOf('flow', { allow: [PUSH_RULE] }))
  const allowedLine = needsLine(allowed)
  check('flow seat, allow rule in the user settings: the line says `git push` is pre-authorised, by that rule and its source', /`git push` is pre-authorised at boot by the allow rule `Bash\(git push \*\)` \(userSettings\)/.test(allowedLine), allowedLine)
  check('…and runs without the channel', /runs without the channel/.test(allowedLine), allowedLine)
  check('…never the waits-on-the-operator words', !/push waits/.test(allowedLine), allowedLine)
  const cli = postureFor('sdk', 'flow', contextOf('flow', { allow: [PUSH_RULE] }, 'cliArg'))
  check('flow seat, allow rule from --allowed-tools: the source is named', /allow rule `Bash\(git push \*\)` \(cliArg\)/.test(needsLine(cli)), needsLine(cli))
  const wide = postureFor('sdk', 'flow', contextOf('flow', { allow: ['Bash(git *)'] }, 'projectSettings'))
  check('a wider prefix rule (`Bash(git *)`) that covers a push is the rule named', /allow rule `Bash\(git \*\)` \(projectSettings\)/.test(needsLine(wide)), needsLine(wide))
  const denied = postureFor('sdk', 'flow', contextOf('flow', { deny: [PUSH_RULE] }, 'projectSettings'))
  check('flow seat, deny rule: the line says `git push` is refused by that rule, never asked', /`git push` is refused at boot by the deny rule `Bash\(git push \*\)` \(projectSettings\)/.test(needsLine(denied)) && /never asked/.test(needsLine(denied)), needsLine(denied))
  const asked = postureFor('sdk', 'flow', contextOf('flow', { ask: [PUSH_RULE] }))
  check('flow seat, ask rule: the line says `git push` is pinned to the operator by that rule', /`git push` is pinned to the operator at boot by the ask rule `Bash\(git push \*\)` \(userSettings\)/.test(needsLine(asked)), needsLine(asked))

  const plain = postureFor('sdk', 'default', contextOf('default'))
  check('default-mode seat, no rule: the line names the default road (any call no allow rule covers) and the push status', /default/.test(needsLine(plain)) && /no allow rule/.test(needsLine(plain)) && /`git push` is not pre-authorised/.test(needsLine(plain)), needsLine(plain))
  const implement = postureFor('sdk', 'implement', contextOf('implement'))
  check('implement-mode seat: the line names the implement road', /implement/.test(needsLine(implement)) && /`git push` is not pre-authorised/.test(needsLine(implement)), needsLine(implement))
  const dontAsk = postureFor('sdk', 'dontAsk', contextOf('dontAsk'))
  check('dontAsk seat: the line says nothing travels the channel — every ask is denied — and the push is denied', /nothing travels the channel/.test(needsLine(dontAsk)) && /`git push` is not pre-authorised/.test(needsLine(dontAsk)) && /denied/.test(needsLine(dontAsk)), needsLine(dontAsk))
  const sovereign = postureFor('sdk', 'sovereign', contextOf('sovereign'))
  check('sovereign seat: only the human-required calls travel; a push runs under the bypass posture', /bypass posture/.test(needsLine(sovereign)) && /question to the operator/.test(needsLine(sovereign)), needsLine(sovereign))

  const again = postureFor('sdk', 'flow', contextOf('flow'))
  check('byte-stable: the same boot facts compose the identical block (the prompt-cache invariant)', again === bare, j({ again, bare }))
  posture.resetRuntimePostureForTest()
  setAskChannel('sdk')
  posture.markSessionNonInteractive('flow')
  stampBootRules?.(contextOf('flow'))
  const first = posture.getRuntimePostureSection()
  check('memoized: a second call returns the identical string', posture.getRuntimePostureSection() === first)

  const unstamped = postureFor('sdk', 'flow', undefined)
  check('never a guess: with no boot rules stamped, the seat says nothing about what its rules pre-authorise', needsLine(unstamped) === '' && /with a host that holds the asks/.test(sessionLine(unstamped)), needsLine(unstamped))
  const noChannel = postureFor('none', 'flow', contextOf('flow'))
  check('a headless run with NO host keeps its own words (asks are denied; no operator line — there is no operator to be present)', /no host to answer an ask/.test(sessionLine(noChannel)) && /DENIED automatically/.test(sessionLine(noChannel)) && needsLine(noChannel) === '', `${sessionLine(noChannel)}\n${needsLine(noChannel)}`)
  const interactive = postureFor('sdk', undefined, contextOf('flow'))
  check('an interactive session keeps its own words (no operator line)', /Session: interactive/.test(sessionLine(interactive)) && needsLine(interactive) === '', sessionLine(interactive))
  const doctrine = posture.getRuntimePostureDoctrineLine() ?? ''
  check('the subagent doctrine line is untouched', /Runtime posture:/.test(doctrine) && /file-lease denial/.test(doctrine), doctrine)
  posture.resetRuntimePostureForTest()
  setAskChannel('operator')
}

section('§2 the push road itself — the REAL Bash verdict through the real decision path, on a seat (a run with the stdio channel) in flow')
const bashTool = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string(), description: z.string().optional() }).passthrough(),
  checkPermissions: async (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) =>
    bashToolHasPermission(input as never, context.getAppState().toolPermissionContext as never),
}
type Cell = { behavior: string; wrapper: string; engine: string; note: string; reason: string }
async function decide(context: Record<string, unknown>, command: string, mode: Mode = 'flow'): Promise<Cell> {
  const ports: typeof defaultWrapperPorts = {
    ...defaultWrapperPorts,
    runHeadlessHooks: async () => null,
  }
  const appState = { toolPermissionContext: { ...context, mode }, effortValue: undefined, tasks: {} }
  const seat = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: { isNonInteractiveSession: true, tools: [], hostHoldsAsks: true },
  }
  const outcome = await decideToolPermissionWithModes(bashTool as never, { command }, seat as never, { message: { id: 'msg_seat_push' } } as never, 'toolu_seat_push', ports)
  const last = outcome.wrapper.stages[outcome.wrapper.stages.length - 1]
  return {
    behavior: outcome.decision.behavior,
    wrapper: outcome.wrapper.decidedBy,
    engine: outcome.engineTrace.decidedBy,
    note: last?.note ?? '',
    reason: reasonWords((outcome.decision as { decisionReason?: unknown }).decisionReason),
  }
}
type Reason = { type?: string; reason?: string; rule?: { ruleValue?: { toolName?: string; ruleContent?: string } }; reasons?: Map<string, { decisionReason?: unknown }> }
function reasonWords(raw: unknown): string {
  const reason = raw as Reason | undefined
  if (!reason) return ''
  const own = `${reason.type ?? ''}${reason.reason ? `:${reason.reason}` : ''}${reason.rule?.ruleValue ? `:${reason.rule.ruleValue.toolName}(${reason.rule.ruleValue.ruleContent})` : ''}`
  if (!(reason.reasons instanceof Map)) return own
  const nested = [...reason.reasons.entries()].map(([sub, result]) => `${sub} => ${reasonWords(result.decisionReason)}`)
  return `${own}[${nested.join('; ')}]`
}
const travels = (c: Cell): boolean => c.behavior === 'ask'
const runsWithoutChannel = (c: Cell): boolean => c.behavior === 'allow' && c.wrapper === 'engine'
{
  const unruled = await decide(contextOf('flow'), PUSH)
  check('no rule: a push is the leftover — the engine\'s own ask parks as the operator\'s; no model is asked; the call TRAVELS the channel', travels(unruled) && unruled.wrapper === 'engine' && unruled.engine === 'resolution', j(unruled))
  check('…and is never auto-allowed by default', unruled.behavior !== 'allow', j(unruled))
  const tailed = await decide(contextOf('flow'), PUSH_TAILED)
  check('no rule, the session\'s own shape (`git push -q 2>&1 | tail -1; git status -sb | head -1`): the same road, the channel', travels(tailed) && tailed.wrapper === 'engine', j(tailed))
  const chained = await decide(contextOf('flow'), PROTOCOL_CHAIN)
  check('no rule, the session\'s protocol chain (commit && pull; push; status): the channel', travels(chained) && chained.wrapper === 'engine', j(chained))

  const ruled = await decide(contextOf('flow', { allow: [PUSH_RULE] }), PUSH)
  check('`Bash(git push *)` in the user settings: the push is allowed in the ENGINE by that rule — nothing on the channel', runsWithoutChannel(ruled) && /rule:Bash\(git push \*\)/.test(ruled.reason), j(ruled))
  const ruledCli = await decide(contextOf('flow', { allow: [PUSH_RULE] }, 'cliArg'), PUSH)
  check('`Bash(git push *)` from --allowed-tools: the same', runsWithoutChannel(ruledCli), j(ruledCli))
  const ruledProject = await decide(contextOf('flow', { allow: [PUSH_RULE] }, 'projectSettings'), PUSH)
  check('`Bash(git push *)` in the project settings: the same', runsWithoutChannel(ruledProject), j(ruledProject))
  const ruledTailed = await decide(contextOf('flow', { allow: [PUSH_RULE] }), PUSH_TAILED)
  check('the rule covers the session\'s own shape (the redirect is stripped for the prefix match; tail, head and git status ride the read-only lane)', runsWithoutChannel(ruledTailed), j(ruledTailed))
  const chainOnePush = await decide(contextOf('flow', { allow: [PUSH_RULE] }), PROTOCOL_CHAIN)
  check('the push rule alone does not carry the protocol chain: the unruled commit and pull are still the operator\'s', travels(chainOnePush) && chainOnePush.wrapper === 'engine', j(chainOnePush))
  const chainRuled = await decide(contextOf('flow', { allow: CHAIN_RULES }), PROTOCOL_CHAIN)
  check('with commit, pull and push each pre-authorised the whole chain runs without the channel', runsWithoutChannel(chainRuled), j(chainRuled))

  const denied = await decide(contextOf('flow', { deny: [PUSH_RULE] }), PUSH)
  check('a deny rule refuses the push in the engine — never the channel', denied.behavior === 'deny' && denied.wrapper === 'engine', j(denied))
  const asked = await decide(contextOf('flow', { ask: [PUSH_RULE] }), PUSH)
  check('an ask rule pins the push to the operator (the ask-rule floor) — the channel', travels(asked) && asked.wrapper === 'autoFloors', j(asked))

  const plainDefault = await decide(contextOf('default'), PUSH, 'default')
  check('a default-mode seat, no rule: the engine\'s own ask travels the channel', travels(plainDefault) && plainDefault.wrapper === 'engine', j(plainDefault))
  const flowLeftover = await decide(contextOf('flow'), PUSH)
  check('a flow seat answers the unruled push exactly as a default seat does (the leftover is the operator\'s on both)', flowLeftover.behavior === plainDefault.behavior && flowLeftover.wrapper === plainDefault.wrapper && flowLeftover.engine === plainDefault.engine && flowLeftover.reason === plainDefault.reason, j({ flow: flowLeftover, byDefault: plainDefault }))
  const ruledDefault = await decide(contextOf('default', { allow: [PUSH_RULE] }), PUSH, 'default')
  check('a default-mode seat with the rule: allowed in the engine', runsWithoutChannel(ruledDefault), j(ruledDefault))

  const stripped = stripDangerousPermissionsForAutoMode({ ...contextOf('flow', { allow: [PUSH_RULE, 'Bash'] }) } as never) as unknown as { alwaysAllowRules: Record<string, string[]> }
  check('flow-mode entry keeps `Bash(git push *)` (a push is not a code-execution prefix) and strips the whole-tool `Bash` allow', j(stripped.alwaysAllowRules['userSettings']) === j([PUSH_RULE]), j(stripped.alwaysAllowRules))
}

section('§3 the operator\'s road on disk — guardrails.allow in a settings file reaches the seat and decides')
{
  const settingsPath = join(HOME, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ guardrails: { allow: [PUSH_RULE] } }, null, 2))
  resetSettingsCache()
  const rules = loadAllPermissionRulesFromDisk() as Array<{ source: string; ruleBehavior: string; ruleValue: { toolName: string; ruleContent?: string } }>
  const fromDisk = rules.find(r => r.ruleValue.toolName === 'Bash' && r.ruleValue.ruleContent === 'git push *')
  check('the loader reads the rule from the settings file with its source', fromDisk?.ruleBehavior === 'allow' && fromDisk.source === 'userSettings', j(rules))
  const loaded = applyPermissionRulesToPermissionContext(contextOf('flow') as never, rules as never) as unknown as Record<string, unknown>
  const cell = await decide(loaded, PUSH)
  check('the seat built from that file allows the push in the engine — nothing on the channel', runsWithoutChannel(cell), j(cell))
  const words = postureFor('sdk', 'flow', loaded)
  check('and the boot posture composed from that same context tells the model so', /`git push` is pre-authorised at boot by the allow rule `Bash\(git push \*\)` \(userSettings\)/.test(needsLine(words)), needsLine(words))
  posture.resetRuntimePostureForTest()
  setAskChannel('operator')
  rmSync(settingsPath, { force: true })
  resetSettingsCache()
}

section('§4 the words on disk — the docs say how an operator pre-authorises a push')
{
  const trust = readFileSync(join(ROOT, 'docs', 'TRUST.md'), 'utf8')
  const nonInteractive = trust.slice(trust.indexOf('## Non-interactive sessions'))
  const sectionText = nonInteractive.slice(0, nonInteractive.indexOf('\n## ', 1) > 0 ? nonInteractive.indexOf('\n## ', 1) : undefined)
  check('docs/TRUST.md, Non-interactive sessions: says a push on a headless seat waits on a present operator unless a rule pre-authorises it', /git push/.test(sectionText) && /present/.test(sectionText), sectionText.slice(0, 400))
  check('…names the rule shape `Bash(git push *)` and guardrails.allow', /Bash\(git push \*\)/.test(sectionText) && /guardrails\.allow/.test(sectionText), sectionText.slice(0, 400))
  check('…says no push is ever allowed by default', /no push is ever allowed by default/i.test(sectionText), sectionText.slice(0, 400))
  const print = readFileSync(join(ROOT, 'src', 'cli', 'run.ts'), 'utf8')
  check('the headless entry stamps the boot rules beside the interactivity mark (the seat\'s own context, never a guess)', /markSessionNonInteractive\(getAppState\(\)\.toolPermissionContext\?\.mode\)\n\s*markSessionBootRules\(getAppState\(\)\.toolPermissionContext\)/.test(print), 'run.ts carries no markSessionBootRules(getAppState().toolPermissionContext) after the interactivity mark')
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SEAT PUSH-ROAD PROOFS PASS')
else console.log(`❌ ${failures} SEAT PUSH-ROAD PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
