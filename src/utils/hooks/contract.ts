import { z } from 'zod/v4'
import { lazySchema } from '../lazySchema.js'
import type { TurnCutKind } from '../messages/turnCut.js'
import { permissionUpdateSchema } from '../permissions/PermissionUpdateSchema.js'
import { CONCOURSE_SESSION_STATES } from '../../daemon/concourseLifecycle.js'
import { ERROR_CLASSES, OUTCOME_STATUSES, STOP_WORDS, UsageSchema } from '../../rows/vocabulary.js'

export const HOOK_ROADS = ['runner', 'crewmate', 'daemon', 'cockpit'] as const
export type HookRoad = (typeof HOOK_ROADS)[number]

export const HOOK_KINDS = ['run', 'question', 'crewmate'] as const
export type HookKind = (typeof HOOK_KINDS)[number]

export const HOOK_ANSWER_FIELDS = [
  'block',
  'stop',
  'context',
  'notice',
  'permission',
  'input',
  'output',
  'rules',
  'instructions',
  'prompt',
  'watch',
] as const
export type HookAnswerField = (typeof HOOK_ANSWER_FIELDS)[number]

export const HOOK_BACKGROUND_ANSWER_FIELDS = ['context', 'notice'] as const satisfies readonly HookAnswerField[]

export const HOOK_TIMEOUT_DEFAULT_S: Readonly<Record<HookKind, number>> = { run: 600, question: 30, crewmate: 60 }
export const HOOK_TIMEOUT_MAX_S = 2_147_483
export const HOOK_CUT_BUDGET_MS = 1500

export const CUT_REASONS = ['operator', 'idle-timeout', 'parent-stop', 'cut'] as const satisfies readonly TurnCutKind[]
export const SESSION_STATE_HOOK_STATES = ['needs-you', 'stalled', 'ready-to-review', 'paused', 'completed', 'failed', 'cancelled'] as const
export const CREWMATE_END_STATUSES = ['finished', 'failed', 'stopped'] as const
export const COMPACTION_METHODS = ['summary', 'notes', 'digest'] as const
export const COMPACTION_TRIGGERS = ['manual', 'auto', 'overflow'] as const
export const SESSION_START_REASONS = ['new', 'resumed'] as const
export const SESSION_END_REASONS = ['quit', 'logout', 'closed'] as const
export const PERMISSION_DECIDERS = ['rule', 'mode', 'hook', 'operator', 'safety', 'other'] as const
export const PERMISSION_DECISIONS = ['allowed', 'denied'] as const

const baseFields = {
  session_id: z.string().describe('The session the event happened in'),
  transcript_path: z.string().describe('The session transcript, an absolute path'),
  cwd: z.string().describe('The working directory at the moment'),
  permission_mode: z.string().optional().describe('The permission mode in force, when a turn is running'),
  crewmate_id: z.string().optional().describe('Set when the moment happened inside a crewmate'),
  crewmate_type: z.string().optional().describe("The crewmate's type, when the moment happened inside one"),
}
export const HookBasePayloadSchema = lazySchema(() => z.object(baseFields))
export type HookBasePayload = z.infer<ReturnType<typeof HookBasePayloadSchema>>

const errorShape = () => z.object({ message: z.string(), class: z.enum(ERROR_CLASSES) })
const cutShape = () =>
  z.object({
    reason: z.enum(CUT_REASONS),
    detail: z.string().optional(),
    tools: z.array(z.string()).describe('The tool calls the cut ended'),
  })

export type HookBudget = { ms: number; when: 'cut' | 'always' }

export type HookEventRow = {
  moment: string
  roads: readonly HookRoad[]
  payload: () => z.ZodObject<z.ZodRawShape>
  match?: string
  answers: readonly HookAnswerField[]
  kinds?: readonly HookKind[]
  budget?: HookBudget
  stdoutIsContext?: true
  envFile?: true
  foregroundOnly?: true
  watchable?: true
}

const row = <const R extends HookEventRow>(r: R): R => r

const hookEventTableRows = {
  'turn.start': row({
    moment: "The operator's prompt is in and the model is about to be asked.",
    roads: ['runner'],
    payload: lazySchema(() => z.object({ turn_id: z.string(), prompt: z.string() })),
    answers: ['block', 'stop', 'context', 'notice'],
    stdoutIsContext: true,
  }),
  'turn.answer': row({
    moment: 'The model has answered and would end its turn.',
    roads: ['runner', 'crewmate'],
    payload: lazySchema(() =>
      z.object({
        turn_id: z.string(),
        answer: z.string().optional().describe('The final text of the answer'),
        again: z.boolean().describe("True when this fire follows the hook's own send-back"),
      }),
    ),
    answers: ['block', 'stop', 'context', 'notice'],
  }),
  'turn.end': row({
    moment: 'A turn is over, however it ended; a cut turn carries its cut.',
    roads: ['runner', 'crewmate'],
    payload: lazySchema(() =>
      z.object({
        turn_id: z.string(),
        status: z.enum(OUTCOME_STATUSES),
        stop: z.enum(STOP_WORDS).optional().describe("The model's stop word"),
        error: errorShape().optional(),
        cut: cutShape().optional().describe('Set when the turn was cut'),
        steps: z.number().int().min(0),
        wall_ms: z.number().int().min(0),
        cost_usd: z.number().min(0).optional(),
        usage: UsageSchema(),
        answer: z.string().optional(),
      }),
    ),
    match: 'status',
    answers: ['notice'],
    budget: { ms: HOOK_CUT_BUDGET_MS, when: 'cut' },
  }),
  'tool.before': row({
    moment: 'A tool call is about to run, after its input was validated and before the permission decision.',
    roads: ['runner', 'crewmate'],
    payload: lazySchema(() => z.object({ tool: z.string(), input: z.unknown(), call_id: z.string() })),
    match: 'tool',
    answers: ['block', 'stop', 'context', 'notice', 'permission', 'input'],
  }),
  'tool.after': row({
    moment: 'A tool call ended: it returned, returned an error, or threw.',
    roads: ['runner', 'crewmate'],
    payload: lazySchema(() =>
      z.object({
        tool: z.string(),
        input: z.unknown(),
        output: z.unknown().describe('What the tool returned'),
        call_id: z.string(),
        ok: z.boolean().describe('False when the call returned an error or threw'),
        error: z.string().optional().describe('The failure text when ok is false'),
        cut: z.boolean().describe('True when a cut caused the failure'),
      }),
    ),
    match: 'tool',
    answers: ['block', 'stop', 'context', 'notice', 'output'],
    budget: { ms: HOOK_CUT_BUDGET_MS, when: 'cut' },
  }),
  'permission.ask': row({
    moment: 'A permission ask is about to reach the operator, or a crewmate that cannot ask would be denied.',
    roads: ['runner', 'crewmate'],
    payload: lazySchema(() =>
      z.object({
        tool: z.string(),
        input: z.unknown(),
        call_id: z.string(),
        suggestions: z.array(permissionUpdateSchema()).optional().describe('The rule updates Mercury would offer'),
      }),
    ),
    match: 'tool',
    answers: ['block', 'stop', 'notice', 'permission', 'input', 'rules'],
  }),
  'permission.decided': row({
    moment: "A tool call's permission was decided without the hook's own answer.",
    roads: ['runner', 'crewmate'],
    payload: lazySchema(() =>
      z.object({
        tool: z.string(),
        input: z.unknown(),
        call_id: z.string(),
        decision: z.enum(PERMISSION_DECISIONS),
        by: z.enum(PERMISSION_DECIDERS),
        reason: z.string().optional(),
      }),
    ),
    match: 'tool',
    answers: ['notice'],
  }),
  'crewmate.start': row({
    moment: 'A crewmate is launched; the crewmate fields name it.',
    roads: ['runner'],
    payload: lazySchema(() =>
      z.object({
        name: z.string().optional(),
        prompt: z.string(),
        model: z.string(),
        directory: z.string().describe('The directory the crewmate works in'),
      }),
    ),
    match: 'crewmate_type',
    answers: ['context', 'notice'],
    stdoutIsContext: true,
  }),
  'crewmate.end': row({
    moment: 'A crewmate ended; the crewmate fields name it.',
    roads: ['runner'],
    payload: lazySchema(() =>
      z.object({
        name: z.string().optional(),
        status: z.enum(CREWMATE_END_STATUSES),
        reason: z.string().optional().describe("The error's words or the stop's"),
        crewmate_transcript_path: z.string().optional(),
        usage: UsageSchema().optional(),
      }),
    ),
    match: 'status',
    answers: ['notice'],
  }),
  'compaction.before': row({
    moment: 'The conversation is about to be summarised.',
    roads: ['runner'],
    payload: lazySchema(() =>
      z.object({
        trigger: z.enum(COMPACTION_TRIGGERS),
        instructions: z.string().optional().describe("The operator's /compact words"),
        tokens: z.number().int().min(0),
      }),
    ),
    match: 'trigger',
    answers: ['instructions', 'notice'],
  }),
  'compaction.after': row({
    moment: 'A compaction rung landed: the summary, the memory notes, or the digest that cleared old tool results.',
    roads: ['runner'],
    payload: lazySchema(() =>
      z.object({
        method: z.enum(COMPACTION_METHODS),
        trigger: z.enum(COMPACTION_TRIGGERS),
        tokens_before: z.number().int().min(0),
        tokens_after: z.number().int().min(0),
        summary: z.string().optional(),
      }),
    ),
    match: 'method',
    answers: ['context', 'notice'],
    stdoutIsContext: true,
  }),
  'session.start': row({
    moment: "A session's runner came up.",
    roads: ['runner'],
    payload: lazySchema(() => z.object({ reason: z.enum(SESSION_START_REASONS), model: z.string() })),
    match: 'reason',
    answers: ['context', 'notice', 'prompt', 'watch'],
    stdoutIsContext: true,
    envFile: true,
  }),
  'session.end': row({
    moment: 'The runner is leaving; a crash fires nothing.',
    roads: ['runner'],
    payload: lazySchema(() => z.object({ reason: z.enum(SESSION_END_REASONS) })),
    match: 'reason',
    answers: [],
    kinds: ['run'],
    budget: { ms: HOOK_CUT_BUDGET_MS, when: 'always' },
    foregroundOnly: true,
  }),
  'session.state': row({
    moment: 'A hosted session moved to a board state worth acting on.',
    roads: ['daemon'],
    payload: lazySchema(() =>
      z.object({
        state: z.enum(SESSION_STATE_HOOK_STATES),
        from: z.enum(CONCOURSE_SESSION_STATES),
        detail: z.string().optional().describe('The attention event, the stall reason, or the failure words'),
        title: z.string().optional(),
        workspace: z.string(),
        model: z.string().optional(),
      }),
    ),
    match: 'state',
    answers: [],
    kinds: ['run'],
  }),
  'file.changed': row({
    moment: "A watched file changed; the entry's watch list names the files.",
    roads: ['runner', 'cockpit'],
    payload: lazySchema(() =>
      z.object({
        path: z.string().describe('Relative to the project'),
        change: z.enum(['changed', 'added', 'removed']),
      }),
    ),
    match: 'path',
    answers: ['notice', 'watch'],
    envFile: true,
    watchable: true,
  }),
} as const satisfies Record<string, HookEventRow>

export type HookEvent = keyof typeof hookEventTableRows
export const HOOK_EVENTS = Object.keys(hookEventTableRows) as readonly HookEvent[]
export const hookEventTable: Readonly<Record<HookEvent, HookEventRow>> = hookEventTableRows

export function isHookEvent(name: string): name is HookEvent {
  return Object.prototype.hasOwnProperty.call(hookEventTableRows, name)
}

export type HookEventFields<E extends HookEvent> = z.infer<ReturnType<(typeof hookEventTableRows)[E]['payload']>>
export type HookPayload<E extends HookEvent = HookEvent> = E extends HookEvent
  ? HookBasePayload & { event: E } & HookEventFields<E>
  : never

export function hookPayloadSchema(event: HookEvent): z.ZodObject<z.ZodRawShape> {
  return z.object({ ...baseFields, event: z.literal(event), ...hookEventTable[event].payload().shape })
}

export function hookMatchValue(event: HookEvent, payload: Record<string, unknown>): string | undefined {
  const field = hookEventTable[event].match
  if (field === undefined) return undefined
  const value = payload[field]
  return typeof value === 'string' ? value : undefined
}

export function hookMatchValues(event: HookEvent): readonly string[] | undefined {
  const field = hookEventTable[event].match
  if (field === undefined) return undefined
  const shape = hookEventTable[event].payload().shape[field]
  return shape instanceof z.ZodEnum ? (shape.options as readonly string[]) : undefined
}

export function hookKindsOf(event: HookEvent): readonly HookKind[] {
  return hookEventTable[event].kinds ?? HOOK_KINDS
}

const answerValueSchemas: Record<HookAnswerField, () => z.ZodTypeAny> = {
  block: () => z.string().describe('The moment is blocked with these words; the model reads them'),
  stop: () => z.string().describe('The whole turn ends now; the operator reads the words'),
  context: () => z.string().describe('Words the model reads at this moment'),
  notice: () => z.string().describe('One line the operator reads, saved in the session'),
  permission: () => z.enum(['allow', 'ask']).describe('allow: no ask (a deny rule still denies); ask: the operator is asked; a deny is block'),
  input: () => z.record(z.string(), z.unknown()).describe('The input the tool runs with instead'),
  output: () => z.unknown().describe('What the model sees as the result instead'),
  rules: () => z.array(permissionUpdateSchema()).describe('Permission updates applied with the allow'),
  instructions: () => z.string().describe("Guidance appended to the summariser's"),
  prompt: () => z.string().describe("The session's first prompt"),
  watch: () => z.array(z.string()).describe('The files to watch, replacing the list'),
}

function answerShape(fields: readonly HookAnswerField[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of fields) shape[field] = answerValueSchemas[field]().optional()
  return shape
}

export function hookAnswerSchema(event: HookEvent): z.ZodObject<z.ZodRawShape> {
  return z.strictObject(answerShape(hookEventTable[event].answers))
}

export const HookAnswerSchema = lazySchema(() => z.strictObject(answerShape(HOOK_ANSWER_FIELDS)))
export type HookAnswer = z.infer<ReturnType<typeof HookAnswerSchema>>

export function hookAnswerFieldsOf(event: HookEvent): readonly HookAnswerField[] {
  return hookEventTable[event].answers
}

export { HOOK_LIFECYCLE_EVENTS, HookJSONOutputSchema } from './oldRoad.js'
export type { AsyncHookJSONOutput, HookInput, HookJSONOutput, SyncHookJSONOutput } from './oldRoad.js'
