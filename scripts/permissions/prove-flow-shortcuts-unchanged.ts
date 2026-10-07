#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'flow-shortcuts-'))
delete process.env.MERCURY_HOME

import { z } from 'zod/v4'

const RECORD = process.argv.includes('--record')
const FIXTURE = join(import.meta.dir, 'fixtures', 'flow-shortcuts.json')

const { decideToolPermissionWithModes, defaultWrapperPorts } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { isReadOnlyAllowlistedTool } = await import('../../src/utils/permissions/readOnlyAllowlist.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { POWERSHELL_TOOL_NAME } = await import('../../src/tools/PowerShellTool/toolName.ts')
const { AGENT_TOOL_NAME } = await import('../../src/tools/AgentTool/constants.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const TOOL_NAMES = [
  'Read', 'Grep', 'Glob', 'LSP', 'ToolSearch', 'ListMcpResources', 'ReadMcpResource', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'AskUserQuestion', 'SendMessage', 'Workflow', 'Sleep',
  'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch', 'Browser', 'Computer', 'Git', 'Launch', 'Monitor', 'Eval', 'Debug', 'Test', 'Service', 'ChangeSet', 'Checkpoint', 'Rewind', 'Transaction', 'Skill', 'Schedule', 'ContextLeft', 'Retain', 'Recall', 'Reflect', 'Correct',
  'mcp__fixture__read_file', 'mcp__fixture__write_file', 'mcp__fixture__TaskGet', 'read', 'grep', 'frobnicate', '',
]

type ReasonSeed =
  | { kind: 'none' }
  | { kind: 'safety'; humanOnly: boolean }
  | { kind: 'askRule' }
type ToolSeed = {
  id: string
  name: string
  verdict: 'ask' | 'passthrough'
  interactive?: boolean
  mcpCeiling?: boolean
  reason: ReasonSeed
}
const TOOLS: ToolSeed[] = [
  { id: 'plain-ask', name: 'FakeTool', verdict: 'ask', reason: { kind: 'none' } },
  { id: 'passthrough', name: 'FakeTool', verdict: 'passthrough', reason: { kind: 'none' } },
  { id: 'interactive', name: 'FakeTool', verdict: 'ask', interactive: true, reason: { kind: 'none' } },
  { id: 'powershell', name: POWERSHELL_TOOL_NAME, verdict: 'ask', reason: { kind: 'none' } },
  { id: 'agent', name: AGENT_TOOL_NAME, verdict: 'ask', reason: { kind: 'none' } },
  { id: 'safety-human-only', name: 'FakeTool', verdict: 'ask', reason: { kind: 'safety', humanOnly: true } },
  { id: 'safety-continues', name: 'FakeTool', verdict: 'ask', reason: { kind: 'safety', humanOnly: false } },
  { id: 'ask-rule', name: 'FakeTool', verdict: 'ask', reason: { kind: 'askRule' } },
  { id: 'mcp-ceiling', name: 'mcp__fixture__tool', verdict: 'ask', mcpCeiling: true, reason: { kind: 'none' } },
]
const MODES = ['flow', 'default', 'implement', 'dontAsk'] as const
const PORT_SHAPES = [
  { id: 'implement-allow', implement: 'allow', allowlist: false },
  { id: 'implement-ask', implement: 'ask', allowlist: false },
  { id: 'allowlisted', implement: 'ask', allowlist: true },
] as const
const CONTEXTS = ['interactive', 'prompt-less'] as const

function seedReason(seed: ReasonSeed): Record<string, unknown> | undefined {
  if (seed.kind === 'none') return undefined
  if (seed.kind === 'safety') return { type: 'safetyCheck', reason: 'a sensitive path', operatorOnly: seed.humanOnly }
  return { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'FakeTool' } } }
}

function makeTool(seed: ToolSeed): unknown {
  const reason = seedReason(seed.reason)
  return {
    name: seed.name,
    inputSchema: z.object({}).passthrough(),
    ...(seed.interactive ? { requiresUserInteraction: () => true } : {}),
    ...(seed.mcpCeiling ? { mcpInfo: { serverName: 'fixture', toolName: 'tool', effectiveMaxPermission: 'ask' } } : {}),
    checkPermissions: async () =>
      seed.verdict === 'ask'
        ? { behavior: 'ask', message: 'plain ask', ...(reason ? { decisionReason: reason } : {}) }
        : { behavior: 'passthrough', message: 'no opinion' },
  }
}

function makeContext(mode: string, promptless: boolean): unknown {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: mode as never,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...(promptless ? { shouldAvoidPermissionPrompts: true } : {}),
  }
  const appState = { toolPermissionContext }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: {},
  }
}

type Ports = typeof defaultWrapperPorts
function makePorts(shape: (typeof PORT_SHAPES)[number]): Ports {
  return {
    ...defaultWrapperPorts,
    isAllowlistedTool: () => shape.allowlist,
    resolveAcceptEditsVerdict: async () => (shape.implement === 'allow' ? { behavior: 'allow', updatedInput: {} } : { behavior: 'ask', message: 'still ask' }),
    runHeadlessHooks: async () => null,
  } as Ports
}

const SETTLED_STAGES = new Set(['dontAskConversion', 'autoSafetyImmunity', 'autoUserInteraction', 'autoFloors', 'powershellGuard', 'implementFastPath', 'allowlistFastPath'])

type WrapperRow = { id: string; decidedBy: string; behavior: string; reasonType: string }
async function wrapperRows(): Promise<WrapperRow[]> {
  const rows: WrapperRow[] = []
  for (const seed of TOOLS) {
    for (const mode of MODES) {
      for (const shape of PORT_SHAPES) {
        for (const ctxKind of CONTEXTS) {
          const id = `${seed.id}·${mode}·${shape.id}·${ctxKind}`
          const outcome = (await decideToolPermissionWithModes(makeTool(seed) as never, {}, makeContext(mode, ctxKind === 'prompt-less') as never, { message: { id: 'msg' } } as never, 'toolu_differential', makePorts(shape))) as {
            decision: { behavior: string; decisionReason?: { type?: string } }
            wrapper: { decidedBy: string }
          }
          const settled = SETTLED_STAGES.has(outcome.wrapper.decidedBy) || (outcome.wrapper.decidedBy === 'engine' && outcome.decision.behavior !== 'ask')
          rows.push(
            settled
              ? { id, decidedBy: outcome.wrapper.decidedBy, behavior: outcome.decision.behavior, reasonType: outcome.decision.decisionReason?.type ?? 'none' }
              : { id, decidedBy: 'leftover', behavior: 'leftover', reasonType: 'leftover' },
          )
        }
      }
    }
  }
  return rows
}

const COMMANDS = [
  'git rev-parse --short HEAD',
  'git commit --allow-empty -q -m probe && git rev-parse --short HEAD',
  'git commit --allow-empty -q -m probe',
  'git push origin main',
  'rm -rf build',
  'ls -la',
  'cat README.md | head',
  'echo hi > out.txt',
  'npm test',
  'python3 -c "print(1)"',
  'curl https://example.invalid',
  'cd .. && ls',
  'git status; git log -1',
]
const RULE_SETS: Array<{ id: string; allow?: string[]; deny?: string[]; ask?: string[] }> = [
  { id: 'none' },
  { id: 'allow-commit', allow: ['Bash(git commit *)'] },
  { id: 'deny-commit', deny: ['Bash(git commit *)'] },
  { id: 'ask-commit', ask: ['Bash(git commit *)'] },
  { id: 'allow-all', allow: ['Bash'] },
  { id: 'ask-tool', ask: ['Bash'] },
  { id: 'allow-git', allow: ['Bash(git *)'] },
]
type BashRow = { id: string; behavior: string; reasonType: string; message: string }
async function bashRows(): Promise<BashRow[]> {
  const rows: BashRow[] = []
  for (const rules of RULE_SETS) {
    for (const mode of MODES) {
      for (const command of COMMANDS) {
        const context = {
          ...getEmptyToolPermissionContext(),
          mode: mode as never,
          alwaysAllowRules: rules.allow ? { userSettings: rules.allow } : {},
          alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {},
          alwaysAskRules: rules.ask ? { userSettings: rules.ask } : {},
          isBypassPermissionsModeAvailable: false,
        }
        const result = (await bashToolHasPermission({ command } as never, context as never)) as { behavior: string; message?: string; decisionReason?: { type?: string } }
        rows.push({ id: `${rules.id}·${mode}·${command}`, behavior: result.behavior, reasonType: result.decisionReason?.type ?? 'none', message: result.message ?? '' })
      }
    }
  }
  return rows
}

const recorded = {
  allowlist: Object.fromEntries(TOOL_NAMES.map(name => [name, isReadOnlyAllowlistedTool(name)])),
  wrapper: await wrapperRows(),
  bash: await bashRows(),
}

if (RECORD) {
  writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
  console.log(`recorded ${Object.keys(recorded.allowlist).length} allowlist rows, ${recorded.wrapper.length} wrapper rows, ${recorded.bash.length} bash rows → ${FIXTURE}`)
  process.exit(0)
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof recorded

console.log('§1 the read-only tool set answers every name as it did')
for (const name of TOOL_NAMES) {
  check(`${JSON.stringify(name)} → ${fixture.allowlist[name]}`, recorded.allowlist[name] === fixture.allowlist[name], `now ${recorded.allowlist[name]}`)
}

console.log('\n§2 the floors and the two shortcuts settle every row as they did; a leftover stays a leftover')
{
  const byId = new Map(fixture.wrapper.map(row => [row.id, row]))
  let same = 0
  for (const row of recorded.wrapper) {
    const was = byId.get(row.id)
    if (was !== undefined && j(was) === j(row)) same++
    else check(`${row.id}`, false, `was ${j(was)} now ${j(row)}`)
  }
  check(`${same} of ${fixture.wrapper.length} wrapper rows byte-identical`, same === fixture.wrapper.length && recorded.wrapper.length === fixture.wrapper.length, `${recorded.wrapper.length} rows now`)
  const leftovers = recorded.wrapper.filter(row => row.decidedBy === 'leftover')
  const settledFlow = recorded.wrapper.filter(row => row.id.includes('·flow·') && row.decidedBy !== 'leftover')
  check(`the matrix exercises both roads (${leftovers.length} leftovers, ${settledFlow.length} flow rows settled by a floor or a shortcut)`, leftovers.length > 0 && settledFlow.length > 0)
}

console.log('\n§3 the Bash permission ladder decides every command as it did')
{
  const byId = new Map(fixture.bash.map(row => [row.id, row]))
  let same = 0
  for (const row of recorded.bash) {
    const was = byId.get(row.id)
    if (was !== undefined && j(was) === j(row)) same++
    else check(`${row.id}`, false, `was ${j(was)} now ${j(row)}`)
  }
  check(`${same} of ${fixture.bash.length} bash rows byte-identical`, same === fixture.bash.length && recorded.bash.length === fixture.bash.length, `${recorded.bash.length} rows now`)
}

console.log(failures === 0 ? '\nprove-flow-shortcuts-unchanged: ALL LAWS HOLD' : `\nprove-flow-shortcuts-unchanged: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
