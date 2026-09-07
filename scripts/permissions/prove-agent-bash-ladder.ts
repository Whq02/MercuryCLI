#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agent-bash-ladder-'))
delete process.env.NODE_ENV

import { z } from 'zod/v4'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
await import('../../src/Tool.ts')
const { decideToolPermissionWithModes, defaultWrapperPorts } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createDenialTrackingState } = await import('../../src/utils/permissions/denialTracking.ts')
const { resolveAgentPromptPosture, composeAgentAppState, withAllowedCommandRules } = await import(
  '../../src/tools/AgentTool/agentPermissionPosture.ts'
)
const { resolveAgentTools, filterToolsForAgent } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { MERCURY_BACKGROUND_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryBackgroundAgent.ts')
const { MERCURY_SCOUT_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryScoutAgent.ts')
const { MERCURY_ARCHITECT_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryArchitectAgent.ts')
const { VERIFICATION_AGENT } = await import('../../src/tools/AgentTool/built-in/verificationAgent.ts')
const { GENERAL_PURPOSE_AGENT } = await import('../../src/tools/AgentTool/built-in/generalPurposeAgent.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the ladder proof exceeded 120s (a row reached a live path?)')
  process.exit(1)
}, 120_000)
guard.unref?.()

section('§1 the prompt-posture owner — an agent inherits its parent\'s ask road')
{
  const base = { isAsync: false, canShowPermissionPrompts: undefined, definitionMode: undefined, parentAvoidsPrompts: false, parentNonInteractive: false as boolean | undefined }
  const rows: Array<{ label: string; facts: Parameters<typeof resolveAgentPromptPosture>[0]; want: { avoidPrompts: boolean; isNonInteractiveSession: boolean; permissionChannel?: 'stdio' | 'prompt-tool' } }> = [
    { label: "a background agent of a daemon seat asks through the seat's stdio channel", facts: { ...base, isAsync: true, parentNonInteractive: true, parentChannel: 'stdio' }, want: { avoidPrompts: false, isNonInteractiveSession: true, permissionChannel: 'stdio' } },
    { label: 'a foreground agent of a print run with a prompt tool inherits that road', facts: { ...base, parentNonInteractive: true, parentChannel: 'prompt-tool' }, want: { avoidPrompts: false, isNonInteractiveSession: true, permissionChannel: 'prompt-tool' } },
    { label: 'a prompt-less child of a seat has no road (it avoids prompts by law)', facts: { ...base, isAsync: true, parentNonInteractive: true, parentChannel: 'stdio', parentAvoidsPrompts: true }, want: { avoidPrompts: true, isNonInteractiveSession: true } },
    { label: 'an explicit "cannot show prompts" drops the road too', facts: { ...base, parentNonInteractive: true, parentChannel: 'stdio', canShowPermissionPrompts: false }, want: { avoidPrompts: true, isNonInteractiveSession: true } },
    { label: 'a print run with no channel gives its child none', facts: { ...base, isAsync: true, parentNonInteractive: true }, want: { avoidPrompts: false, isNonInteractiveSession: true } },
    { label: 'a foreground agent of an interactive parent prompts', facts: base, want: { avoidPrompts: false, isNonInteractiveSession: false } },
    { label: 'a BACKGROUND agent of an interactive parent prompts too — the parent\'s ask road is its own', facts: { ...base, isAsync: true }, want: { avoidPrompts: false, isNonInteractiveSession: false } },
    { label: 'a background agent of a prompt-less parent stays prompt-less', facts: { ...base, isAsync: true, parentAvoidsPrompts: true }, want: { avoidPrompts: true, isNonInteractiveSession: false } },
    { label: 'a foreground agent of a prompt-less parent stays prompt-less', facts: { ...base, parentAvoidsPrompts: true }, want: { avoidPrompts: true, isNonInteractiveSession: false } },
    { label: 'an explicit "can show prompts" wins over a prompt-less parent (the teammate road)', facts: { ...base, isAsync: true, parentAvoidsPrompts: true, canShowPermissionPrompts: true }, want: { avoidPrompts: false, isNonInteractiveSession: false } },
    { label: 'an explicit "cannot show prompts" wins over an interactive parent', facts: { ...base, canShowPermissionPrompts: false }, want: { avoidPrompts: true, isNonInteractiveSession: false } },
    { label: 'a bubble definition prompts whatever the parent does', facts: { ...base, isAsync: true, definitionMode: 'bubble', parentAvoidsPrompts: true }, want: { avoidPrompts: false, isNonInteractiveSession: false } },
    { label: 'an agent of a non-interactive parent (a print run, a seat child) is non-interactive — foreground', facts: { ...base, parentNonInteractive: true }, want: { avoidPrompts: false, isNonInteractiveSession: true } },
    { label: 'an agent of a non-interactive parent is non-interactive — background', facts: { ...base, isAsync: true, parentNonInteractive: true }, want: { avoidPrompts: false, isNonInteractiveSession: true } },
    { label: 'an unstated parent interactivity reads interactive for a child', facts: { ...base, isAsync: true, parentNonInteractive: undefined }, want: { avoidPrompts: false, isNonInteractiveSession: false } },
  ]
  for (const row of rows) {
    const got = resolveAgentPromptPosture(row.facts)
    check(row.label, got.avoidPrompts === row.want.avoidPrompts && got.isNonInteractiveSession === row.want.isNonInteractiveSession && got.permissionChannel === row.want.permissionChannel, `got ${j(got)} want ${j(row.want)}`)
  }
}

section('§2 the ladder — the agent\'s Bash answers from the stage the main thread\'s does')

const READ_ONLY = 'git rev-parse --short HEAD'
const WRITING = 'git commit --allow-empty -q -m agent-bash-probe && git rev-parse --short HEAD'
const ASKING = 'git commit --allow-empty -q -m agent-bash-probe'
const ALLOW_RULES = ['Bash(git commit:*)']
const DENY_RULES = ['Bash(git commit:*)']
const ASK_RULES = ['Bash(git commit:*)']
const ASK_TOOL_RULES = ['Bash']

const bashTool = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string(), description: z.string().optional() }).passthrough(),
  checkPermissions: async (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) =>
    bashToolHasPermission(input as never, context.getAppState().toolPermissionContext as never),
}

type Rules = 'none' | 'allow' | 'deny' | 'ask' | 'ask-tool'
type Mode = 'default' | 'flow' | 'autopilot' | 'sovereign' | 'dontAsk'
type Subject = 'main' | 'fg-agent' | 'bg-agent' | 'main-headless' | 'bg-agent-of-headless' | 'main-print' | 'fg-agent-of-print' | 'bg-agent-of-print' | 'main-seat' | 'bg-agent-of-seat'
const PEER: Record<Subject, Subject> = {
  main: 'main',
  'fg-agent': 'main',
  'bg-agent': 'main',
  'main-headless': 'main-headless',
  'bg-agent-of-headless': 'main-headless',
  'main-print': 'main-print',
  'fg-agent-of-print': 'main-print',
  'bg-agent-of-print': 'main-print',
  'main-seat': 'main-seat',
  'bg-agent-of-seat': 'main-seat',
}
const SUBJECTS = Object.keys(PEER) as Subject[]

function parentState(mode: Mode, rules: Rules, headless: boolean): Record<string, unknown> {
  return {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
      alwaysAllowRules: rules === 'allow' ? { userSettings: ALLOW_RULES } : {},
      alwaysDenyRules: rules === 'deny' ? { userSettings: DENY_RULES } : {},
      alwaysAskRules: rules === 'ask' ? { userSettings: ASK_RULES } : rules === 'ask-tool' ? { userSettings: ASK_TOOL_RULES } : {},
      isBypassPermissionsModeAvailable: mode === 'autopilot' || mode === 'sovereign',
      ...(headless ? { shouldAvoidPermissionPrompts: true } : {}),
    },
    denialTracking: undefined,
    effortValue: undefined,
    tasks: {},
  }
}

function contextFor(subject: Subject, mode: Mode, rules: Rules): unknown {
  const parentHeadless = subject === 'main-headless' || subject === 'bg-agent-of-headless'
  const parentPrint = subject === 'main-print' || subject === 'fg-agent-of-print' || subject === 'bg-agent-of-print'
  const parentSeat = subject === 'main-seat' || subject === 'bg-agent-of-seat'
  const parent = parentState(mode, rules, parentHeadless)
  const isAgent = subject.includes('agent')
  const isAsync = subject.startsWith('bg-')
  let getAppState = (): unknown => parent
  let isNonInteractiveSession: boolean | undefined = parentPrint || parentSeat
  let permissionChannel: 'stdio' | 'prompt-tool' | undefined = parentSeat ? 'stdio' : undefined
  if (isAgent) {
    const posture = resolveAgentPromptPosture({
      isAsync,
      canShowPermissionPrompts: undefined,
      definitionMode: undefined,
      parentAvoidsPrompts: parentHeadless,
      parentNonInteractive: parentPrint || parentSeat,
      parentChannel: permissionChannel,
    })
    isNonInteractiveSession = posture.isNonInteractiveSession
    permissionChannel = posture.permissionChannel
    getAppState = () => composeAgentAppState(parent as never, { definitionMode: undefined, avoidPrompts: posture.avoidPrompts, isAsync, allowedTools: undefined, effortValue: undefined })
  }
  return {
    abortController: new AbortController(),
    getAppState,
    setAppState: () => {},
    messages: [],
    agentId: isAgent ? `agent-${subject}` : undefined,
    agentType: isAgent ? 'mercury-general' : undefined,
    options: { isNonInteractiveSession, tools: [], ...(permissionChannel !== undefined ? { permissionChannel } : {}) },
    ...(isAsync ? { localDenialTracking: createDenialTrackingState() } : {}),
  }
}

const ASSISTANT = { message: { id: 'msg_ladder' } } as never
type Ports = typeof defaultWrapperPorts

interface Cell {
  behavior: string
  wrapper: string
  engine: string
  classifier: number
  reason: string
}

async function decide(subject: Subject, mode: Mode, rules: Rules, command: string, classifierBlocks: boolean): Promise<Cell> {
  let classifier = 0
  const ports: Ports = {
    ...defaultWrapperPorts,
    classify: async () => {
      classifier++
      return { shouldBlock: classifierBlocks, reason: classifierBlocks ? 'the fixture classifier blocked it' : 'the fixture classifier allowed it', model: 'fixture' } as never
    },
    runHeadlessHooks: async () => null,
  }
  const context = contextFor(subject, mode, rules) as never
  const outcome = await decideToolPermissionWithModes(bashTool as never, { command }, context, ASSISTANT, `toolu-${subject}`, ports)
  const reason = (outcome.decision as { decisionReason?: { type?: string; reason?: string } }).decisionReason
  return {
    behavior: outcome.decision.behavior,
    wrapper: outcome.wrapper.decidedBy,
    engine: outcome.engineTrace.decidedBy,
    classifier,
    reason: reason ? `${reason.type ?? ''}${reason.reason ? `:${reason.reason}` : ''}` : '',
  }
}

const same = (a: Cell, b: Cell): boolean => a.behavior === b.behavior && a.wrapper === b.wrapper && a.engine === b.engine && a.classifier === b.classifier

interface Row {
  label: string
  mode: Mode
  rules: Rules
  command: string
  classifierBlocks?: boolean
  main: Partial<Cell>
  headless?: Partial<Cell>
  print?: Partial<Cell>
  seat?: Partial<Cell>
}

const ROWS: Row[] = [
  { label: 'default · no rule · read-only command → the read-only lane allows in the engine', mode: 'default', rules: 'none', command: READ_ONLY, main: { behavior: 'allow', wrapper: 'engine', engine: 'resolution', classifier: 0 } },
  { label: 'flow · no rule · read-only command → the engine allows; the classifier is never reached', mode: 'flow', rules: 'none', command: READ_ONLY, main: { behavior: 'allow', wrapper: 'engine', engine: 'resolution', classifier: 0 } },
  { label: 'default · allow rule · writing command → the rule allows in the engine', mode: 'default', rules: 'allow', command: WRITING, main: { behavior: 'allow', wrapper: 'engine', engine: 'resolution', classifier: 0 } },
  { label: 'flow · allow rule · writing command → the rule allows; no classifier call', mode: 'flow', rules: 'allow', command: WRITING, main: { behavior: 'allow', wrapper: 'engine', engine: 'resolution', classifier: 0 } },
  { label: 'default · deny rule · writing command → the rule denies in the engine', mode: 'default', rules: 'deny', command: WRITING, main: { behavior: 'deny', wrapper: 'engine', engine: 'toolVerdictDeny', classifier: 0 } },
  { label: 'flow · deny rule · writing command → the rule denies; no classifier call', mode: 'flow', rules: 'deny', command: WRITING, main: { behavior: 'deny', wrapper: 'engine', engine: 'toolVerdictDeny', classifier: 0 } },
  { label: 'sovereign · deny rule → bypass-immune deny', mode: 'sovereign', rules: 'deny', command: WRITING, main: { behavior: 'deny', engine: 'toolVerdictDeny', classifier: 0 } },
  {
    label: 'default · no rule · writing command → an ASK for the operator; a prompt-less parent denies; a print run hands the ask to its executor',
    mode: 'default',
    rules: 'none',
    command: WRITING,
    main: { behavior: 'ask', wrapper: 'engine', engine: 'resolution', classifier: 0 },
    headless: { behavior: 'deny', wrapper: 'headlessAutoDeny', classifier: 0 },
    print: { behavior: 'ask', wrapper: 'engine', classifier: 0 },
    seat: { behavior: 'ask', wrapper: 'engine', classifier: 0 },
  },
  {
    label: 'flow · no rule · writing command · classifier allows → ONE classifier call, then allow — every subject',
    mode: 'flow',
    rules: 'none',
    command: WRITING,
    main: { behavior: 'allow', wrapper: 'classifier', classifier: 1 },
    headless: { behavior: 'allow', wrapper: 'classifier', classifier: 1 },
    print: { behavior: 'allow', wrapper: 'classifier', classifier: 1 },
    seat: { behavior: 'allow', wrapper: 'classifier', classifier: 1 },
  },
  {
    label: 'flow · no rule · writing command · classifier BLOCKS → the operator\'s card where a card exists; a machine deny where no operator can be reached; a daemon seat parks it as the operator\'s ask',
    mode: 'flow',
    rules: 'none',
    command: WRITING,
    classifierBlocks: true,
    main: { behavior: 'ask', wrapper: 'classifier', classifier: 1 },
    headless: { behavior: 'deny', wrapper: 'classifier', classifier: 1 },
    print: { behavior: 'deny', wrapper: 'classifier', classifier: 1 },
    seat: { behavior: 'ask', wrapper: 'classifier', classifier: 1 },
  },
  { label: 'autopilot · no rule · writing command → the bypass posture allows in the engine', mode: 'autopilot', rules: 'none', command: WRITING, main: { behavior: 'allow', wrapper: 'engine', engine: 'bypassPosture', classifier: 0 } },
  { label: 'sovereign · no rule · writing command → the bypass posture allows in the engine', mode: 'sovereign', rules: 'none', command: WRITING, main: { behavior: 'allow', wrapper: 'engine', engine: 'bypassPosture', classifier: 0 } },
  { label: 'dontAsk · no rule · writing command → the ask converts to a deny, no classifier', mode: 'dontAsk', rules: 'none', command: WRITING, main: { behavior: 'deny', wrapper: 'dontAskConversion', classifier: 0 } },
  { label: 'dontAsk · allow rule · writing command → the rule still allows', mode: 'dontAsk', rules: 'allow', command: WRITING, main: { behavior: 'allow', wrapper: 'engine', classifier: 0 } },
  {
    label: 'default · ask rule · simple command → the content ask road asks the operator; a prompt-less parent denies',
    mode: 'default',
    rules: 'ask',
    command: ASKING,
    main: { behavior: 'ask', wrapper: 'engine', engine: 'contentAskRule', classifier: 0 },
    headless: { behavior: 'deny', wrapper: 'headlessAutoDeny', classifier: 0 },
  },
  { label: 'sovereign · ask rule · simple command → the ask road stands down; the engine allows at the road', mode: 'sovereign', rules: 'ask', command: ASKING, main: { behavior: 'allow', wrapper: 'engine', engine: 'contentAskRule', classifier: 0 } },
  { label: 'default · whole-tool ask rule → the 1b road asks, the rule its reason', mode: 'default', rules: 'ask-tool', command: READ_ONLY, main: { behavior: 'ask', engine: 'toolAskRule', classifier: 0 } },
  { label: 'sovereign · whole-tool ask rule → the 1b road stands down; the engine allows at the road', mode: 'sovereign', rules: 'ask-tool', command: READ_ONLY, main: { behavior: 'allow', wrapper: 'engine', engine: 'toolAskRuleCarried', classifier: 0 } },
  { label: 'autopilot · whole-tool ask rule → the 1b road stands down; the engine allows at the road', mode: 'autopilot', rules: 'ask-tool', command: READ_ONLY, main: { behavior: 'allow', wrapper: 'engine', engine: 'toolAskRuleCarried', classifier: 0 } },
  { label: 'autopilot · ask rule · simple command → the ask road stands down; the engine allows at the road', mode: 'autopilot', rules: 'ask', command: ASKING, main: { behavior: 'allow', wrapper: 'engine', engine: 'contentAskRule', classifier: 0 } },
  { label: 'flow · ask rule · simple command → the floor keeps the human ask; no classifier', mode: 'flow', rules: 'ask', command: ASKING, main: { behavior: 'ask', engine: 'contentAskRule', classifier: 0 } },
]

const matches = (cell: Cell, want: Partial<Cell>): boolean =>
  (want.behavior === undefined || cell.behavior === want.behavior) &&
  (want.wrapper === undefined || cell.wrapper === want.wrapper) &&
  (want.engine === undefined || cell.engine === want.engine) &&
  (want.classifier === undefined || cell.classifier === want.classifier)

for (const row of ROWS) {
  const cells = {} as Record<Subject, Cell>
  for (const subject of SUBJECTS) cells[subject] = await decide(subject, row.mode, row.rules, row.command, row.classifierBlocks === true)
  check(`${row.label} — main`, matches(cells.main, row.main), j(cells.main))
  if (row.headless) check(`${row.label} — a prompt-less parent`, matches(cells['main-headless'], row.headless), j(cells['main-headless']))
  if (row.print) check(`${row.label} — a print run`, matches(cells['main-print'], row.print), j(cells['main-print']))
  if (row.seat) check(`${row.label} — a daemon seat`, matches(cells['main-seat'], row.seat), j(cells['main-seat']))
  for (const subject of SUBJECTS) {
    const peer = PEER[subject]
    if (peer === subject) continue
    check(`${row.label} — ${subject} answers as ${peer} does`, same(cells[subject], cells[peer]), `${subject} ${j(cells[subject])} vs ${peer} ${j(cells[peer])}`)
  }
}

section('§3 the roster — the shell rides every definition that carries it, foreground and background')
{
  const POOL_NAMES = ['Agent', 'AskUserQuestion', 'Bash', 'Edit', 'ExitStrategyMode', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'SendMessage', 'Skill', 'Sleep', 'TaskOutput', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch', 'Workflow', 'Write']
  const pool = POOL_NAMES.map(name => ({ name })) as never
  const definitions = [GENERAL_PURPOSE_AGENT, MERCURY_BACKGROUND_AGENT, MERCURY_SCOUT_AGENT, MERCURY_ARCHITECT_AGENT, VERIFICATION_AGENT]
  for (const definition of definitions) {
    for (const isAsync of [false, true]) {
      const resolved = resolveAgentTools(definition as never, pool, isAsync, false)
      const names = resolved.resolvedTools.map(t => (t as { name: string }).name)
      check(`${definition.agentType} keeps Bash when ${isAsync ? 'background' : 'foreground'}`, names.includes('Bash'), names.join(','))
      check(`${definition.agentType} never carries the Agent tool itself (${isAsync ? 'background' : 'foreground'})`, !names.includes('Agent'))
    }
  }
  const asyncKept = filterToolsForAgent({ tools: pool, isBuiltIn: true, isAsync: true }).map(t => (t as { name: string }).name)
  check('the background allow-set keeps Bash', asyncKept.includes('Bash'), asyncKept.join(','))
  const readOnly = resolveAgentTools(MERCURY_SCOUT_AGENT as never, pool, false, false).resolvedTools.map(t => (t as { name: string }).name)
  check('the read-only scout keeps the shell and loses the editors (its shell is read-only by prompt, the read-only lane by verdict)', readOnly.includes('Bash') && !readOnly.includes('Edit') && !readOnly.includes('Write'))
}

section('§4 the allow-rule merge — allowedTools ADD to the operator\'s layers')
{
  const state = {
    ...parentState('default', 'allow', false),
  } as { toolPermissionContext: { alwaysAllowRules: Record<string, string[]> } }
  state.toolPermissionContext.alwaysAllowRules = { userSettings: ['Bash(git:*)'], command: ['Read'] }
  const merged = withAllowedCommandRules(state as never, ['Bash(npm test:*)', 'Read']) as typeof state
  check('the operator\'s settings layer survives', j(merged.toolPermissionContext.alwaysAllowRules.userSettings) === j(['Bash(git:*)']), j(merged.toolPermissionContext.alwaysAllowRules))
  check('the command layer gains the run\'s rules, deduplicated', j(merged.toolPermissionContext.alwaysAllowRules.command) === j(['Read', 'Bash(npm test:*)']), j(merged.toolPermissionContext.alwaysAllowRules))
  check('an empty list is the identity', withAllowedCommandRules(state as never, []) === (state as never))
  const composed = composeAgentAppState(state as never, { definitionMode: undefined, avoidPrompts: false, isAsync: true, allowedTools: ['Bash(npm test:*)'], effortValue: undefined }) as typeof state
  check('the agent\'s composed view keeps the settings layer beside the run\'s rules', j(composed.toolPermissionContext.alwaysAllowRules.userSettings) === j(['Bash(git:*)']) && (composed.toolPermissionContext.alwaysAllowRules.command ?? []).includes('Bash(npm test:*)'), j(composed.toolPermissionContext.alwaysAllowRules))
  const bare = composeAgentAppState(state as never, { definitionMode: undefined, avoidPrompts: false, isAsync: false, allowedTools: undefined, effortValue: undefined })
  check('an agent with nothing to overlay reads the parent state itself', bare === (state as never))
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-agent-bash-ladder: ALL LAWS HOLD' : `prove-agent-bash-ladder: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
