import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { FlowAsk } from '../../src/utils/permissions/flowLaw.ts'

type Road = 'cockpit' | 'hosted' | 'hostless' | 'prompt-less'
export const ROADS: readonly Road[] = ['cockpit', 'hosted', 'hostless', 'prompt-less']

type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string; mode?: string }; suggestions?: unknown[] }
type Outcome = { decision: Decision; wrapper: { decidedBy: string; stages: Array<{ stage: string; outcome: string; note?: string }> } }

type Kit = {
  world: string
  project: string
  bashTool: unknown
  decide: (command: string, opts?: { mode?: string; road?: Road; rules?: Rules; cwd?: string }) => Promise<Outcome>
  decideTool: (tool: unknown, input: Record<string, unknown>, opts?: { mode?: string; road?: Road; rules?: Rules }) => Promise<Outcome>
  flowShellAsk: (command: string, cwd?: string) => Promise<FlowAsk | null>
  flowAskSentence: (ask: FlowAsk) => string
  isOwnGround: (path: string, cwd?: string) => boolean
  FLOW_LAW: Record<string, unknown>
  context: (opts?: { mode?: string; road?: Road; rules?: Rules }) => unknown
  close: () => void
}

type Rules = { allow?: string[]; deny?: string[]; ask?: string[] }

let failures = 0
export function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
}
export function section(title: string): void {
  console.log(`\n${title}`)
}
export function finish(name: string): never {
  console.log(failures === 0 ? `\n${name}: ALL PASS` : `\n${name}: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
export const j = (value: unknown): string => JSON.stringify(value)

export async function openKit(label: string): Promise<Kit> {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const original = process.cwd()
  const world = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `${label}-`)))
  const project = join(world, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  process.env.MERCURY_CONFIG_DIR = join(world, 'home')
  process.chdir(project)
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
  const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
  const law = await import('../../src/utils/permissions/flowLaw.ts')
  const bashTool = {
    name: 'Bash',
    inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }),
    isReadOnly: () => false,
    checkPermissions: (input: { command: string; cwd?: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) =>
      bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
  }
  const assistant = { message: { id: label } } as never
  const context = (opts: { mode?: string; road?: Road; rules?: Rules } = {}): unknown => {
    const road = opts.road ?? 'cockpit'
    const rules = opts.rules ?? {}
    const state = {
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        mode: opts.mode ?? 'flow',
        alwaysAllowRules: { localSettings: rules.allow ?? [] },
        alwaysDenyRules: { localSettings: rules.deny ?? [] },
        alwaysAskRules: { localSettings: rules.ask ?? [] },
        ...(road === 'prompt-less' ? { shouldAvoidPermissionPrompts: true } : {}),
      },
    }
    return {
      abortController: new AbortController(),
      getAppState: () => state,
      setAppState: () => {},
      messages: [],
      options: road === 'cockpit' ? {} : { isNonInteractiveSession: true, hostHoldsAsks: road === 'hosted' },
    }
  }
  const decideTool = async (tool: unknown, input: Record<string, unknown>, opts: { mode?: string; road?: Road; rules?: Rules } = {}): Promise<Outcome> =>
    (await decideToolPermissionWithModes(tool as never, input, context(opts) as never, assistant, `${label}-${Math.random().toString(36).slice(2, 8)}`)) as unknown as Outcome
  return {
    world,
    project,
    bashTool,
    decide: (command, opts = {}) => decideTool(bashTool, opts.cwd === undefined ? { command } : { command, cwd: opts.cwd }, opts),
    decideTool,
    flowShellAsk: (command, cwd = project) => law.flowShellAsk(command, cwd),
    flowAskSentence: law.flowAskSentence,
    isOwnGround: law.isOwnGround,
    FLOW_LAW: law.FLOW_LAW as Record<string, unknown>,
    context,
    close: () => {
      process.chdir(original)
      rmSync(world, { recursive: true, force: true })
    },
  }
}

export function sentence(outcome: Outcome): string {
  return outcome.decision.message ?? ''
}

export function asksWith(outcome: Outcome, words: string): boolean {
  return outcome.decision.behavior === 'ask' && sentence(outcome) === words && outcome.decision.decisionReason?.type === 'other' && outcome.decision.decisionReason.reason === words
}

export function refusedWith(outcome: Outcome, words: string): boolean {
  return outcome.decision.behavior === 'deny' && sentence(outcome).startsWith(words) && sentence(outcome).includes(' has been denied')
}

export function allowedByFlow(outcome: Outcome): boolean {
  return outcome.decision.behavior === 'allow' && (outcome.wrapper.decidedBy === 'flowAllow' || outcome.wrapper.decidedBy === 'engine')
}
