import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { permissionModeSchema } from '../../utils/permissions/PermissionMode.js'
import { permissionUpdateSchema } from '../../utils/permissions/PermissionUpdateSchema.js'
import { InputRowSchema, RowSchema } from '../../rows/vocabulary.js'

export const RUNNER_PROTOCOL = 1

export const METHOD_SCOPES = ['none', 'queue', 'session', 'mcp'] as const
export type MethodScope = (typeof METHOD_SCOPES)[number]

export const CAPABILITIES = ['holds_asks', 'elicitation', 'partial_rows'] as const
export type Capability = (typeof CAPABILITIES)[number]

export type Sender = 'host' | 'runner' | 'both'
export type MethodKind = 'request' | 'notification'

export interface MethodSpec<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  readonly name: string
  readonly from: Sender
  readonly kind: MethodKind
  readonly params: () => P
  readonly result: () => R
  readonly scope: MethodScope
  readonly deadlineMs: number | null
  readonly capability?: Capability
}

function method<P extends z.ZodType, R extends z.ZodType, F extends Sender, K extends MethodKind>(spec: MethodSpec<P, R> & { from: F; kind: K }): MethodSpec<P, R> & { from: F; kind: K } {
  return spec
}

const empty = lazySchema(() => z.object({}))
const record = lazySchema(() => z.record(z.string(), z.unknown()))
const applied = lazySchema(() => z.enum(['now', 'turn_end']))

export const CapabilitiesSchema = lazySchema(() =>
  z.object({
    holds_asks: z.boolean(),
    elicitation: z.boolean(),
    partial_rows: z.boolean(),
  }),
)
export type Capabilities = z.infer<ReturnType<typeof CapabilitiesSchema>>

export const InitializeParamsSchema = lazySchema(() =>
  z.object({
    protocol: z.literal(RUNNER_PROTOCOL),
    host: z.object({ name: z.string(), version: z.string() }),
    capabilities: CapabilitiesSchema(),
  }),
)
export type InitializeParams = z.infer<ReturnType<typeof InitializeParamsSchema>>

export const InitializeResultSchema = lazySchema(() =>
  z.object({
    protocol: z.literal(RUNNER_PROTOCOL),
    runner: z.object({ version: z.string(), pid: z.number().int() }),
    session_id: z.string().nullable(),
  }),
)
export type InitializeResult = z.infer<ReturnType<typeof InitializeResultSchema>>

export const PermissionRequestParamsSchema = lazySchema(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('tool'),
      tool_use_id: z.string(),
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()),
      title: z.string().optional(),
      display_name: z.string().optional(),
      description: z.string().optional(),
      suggestions: z.array(permissionUpdateSchema()).optional(),
      blocked_path: z.string().optional(),
      reason: z.string().optional(),
      reason_detail: z.unknown().optional(),
      agent_id: z.string().optional(),
    }),
    z.object({ kind: z.literal('network'), host: z.string() }),
  ]),
)
export type PermissionRequestParams = z.infer<ReturnType<typeof PermissionRequestParamsSchema>>

export const PermissionAnswerSchema = lazySchema(() =>
  z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('allow'),
      input: z.record(z.string(), z.unknown()).optional(),
      rules: z.array(permissionUpdateSchema()).optional(),
    }),
    z.object({
      outcome: z.literal('deny'),
      message: z.string().optional(),
      stop: z.boolean().optional(),
    }),
  ]),
)
export type PermissionAnswer = z.infer<ReturnType<typeof PermissionAnswerSchema>>

export const ElicitationRequestParamsSchema = lazySchema(() =>
  z.object({
    server: z.string(),
    message: z.string(),
    mode: z.enum(['form', 'url']).optional(),
    url: z.string().optional(),
    elicitation_id: z.string().optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
  }),
)
export type ElicitationRequestParams = z.infer<ReturnType<typeof ElicitationRequestParamsSchema>>

export const ElicitationAnswerSchema = lazySchema(() =>
  z.object({
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
)
export type ElicitationAnswer = z.infer<ReturnType<typeof ElicitationAnswerSchema>>

export const CancelRequestParamsSchema = lazySchema(() =>
  z.object({ request_id: z.number().int().positive(), reason: z.string().optional() }),
)
export type CancelRequestParams = z.infer<ReturnType<typeof CancelRequestParamsSchema>>

export const SessionAppliedParamsSchema = lazySchema(() =>
  z.object({
    request_id: z.number().int().positive(),
    verb: z.enum(['set_model', 'set_effort', 'set_spawn_switch']),
    model: z.string().optional(),
    effort: z.string().optional(),
    switch: z.enum(['subagents', 'workflows']).optional(),
    on: z.boolean().optional(),
  }),
)
export type SessionAppliedParams = z.infer<ReturnType<typeof SessionAppliedParamsSchema>>

export const METHODS = {
  initialize: method({
    name: 'initialize',
    from: 'host',
    kind: 'request',
    params: InitializeParamsSchema,
    result: InitializeResultSchema,
    scope: 'none',
    deadlineMs: 10_000,
  }),
  'session/claim': method({
    name: 'session/claim',
    from: 'host',
    kind: 'request',
    params: lazySchema(() =>
      z.object({
        session_id: z.string(),
        model: z.string().optional(),
        mode: z.string().optional(),
        effort: z.string().optional(),
        resume: z.boolean().optional(),
        restart_reason: z.string().optional(),
        openai_catalogue: z.unknown().optional(),
      }),
    ),
    result: lazySchema(() => z.object({ session_id: z.string() })),
    scope: 'session',
    deadlineMs: 45_000,
  }),
  'session/facts': method({
    name: 'session/facts',
    from: 'host',
    kind: 'request',
    params: empty,
    result: record,
    scope: 'none',
    deadlineMs: 30_000,
  }),
  'session/set_model': method({
    name: 'session/set_model',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ model: z.string().optional() })),
    result: lazySchema(() => z.object({ model: z.string(), at: applied() })),
    scope: 'session',
    deadlineMs: 5_000,
  }),
  'session/set_effort': method({
    name: 'session/set_effort',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ effort: z.string() })),
    result: lazySchema(() => z.object({ effort: z.string(), at: applied() })),
    scope: 'session',
    deadlineMs: 5_000,
  }),
  'session/set_mode': method({
    name: 'session/set_mode',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ mode: z.string() })),
    result: lazySchema(() => z.object({ mode: permissionModeSchema() })),
    scope: 'session',
    deadlineMs: 5_000,
  }),
  'session/set_spawn_switch': method({
    name: 'session/set_spawn_switch',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ switch: z.enum(['subagents', 'workflows']), on: z.boolean() })),
    result: lazySchema(() => z.object({ switch: z.enum(['subagents', 'workflows']), on: z.boolean(), at: applied() })),
    scope: 'session',
    deadlineMs: 5_000,
  }),
  'session/set_kit': method({
    name: 'session/set_kit',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ kit: z.unknown() })),
    result: lazySchema(() =>
      z.object({
        applied: z.literal(true),
        connected: z.array(z.string()),
        disconnected: z.array(z.string()),
        errors: z.record(z.string(), z.string()),
      }),
    ),
    scope: 'mcp',
    deadlineMs: 30_000,
  }),
  'session/rewind': method({
    name: 'session/rewind',
    from: 'host',
    kind: 'request',
    params: lazySchema(() =>
      z.object({
        user_message_id: z.string(),
        mode: z.enum(['code', 'conversation', 'both']),
        dry_run: z.boolean().optional(),
      }),
    ),
    result: record,
    scope: 'session',
    deadlineMs: 30_000,
  }),
  'session/pause_gate': method({
    name: 'session/pause_gate',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ paused: z.boolean() })),
    result: lazySchema(() => z.object({ paused: z.boolean(), parked: z.number().int().min(0), changed: z.boolean() })),
    scope: 'session',
    deadlineMs: 10_000,
  }),
  'session/quiesce': method({
    name: 'session/quiesce',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ action: z.enum(['prepare', 'commit', 'cancel']), token: z.string() })),
    result: lazySchema(() => z.object({ token: z.string(), phase: z.string() })),
    scope: 'session',
    deadlineMs: 10_000,
  }),
  'queue/add': method({
    name: 'queue/add',
    from: 'host',
    kind: 'request',
    params: InputRowSchema,
    result: lazySchema(() =>
      z.discriminatedUnion('accepted', [
        z.object({ accepted: z.literal(true) }),
        z.object({ accepted: z.literal(false), reason: z.literal('duplicate') }),
      ]),
    ),
    scope: 'queue',
    deadlineMs: 5_000,
  }),
  'queue/withdraw': method({
    name: 'queue/withdraw',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ id: z.string() })),
    result: lazySchema(() =>
      z.discriminatedUnion('withdrawn', [
        z.object({ withdrawn: z.literal(true), text: z.string() }),
        z.object({ withdrawn: z.literal(false), reason: z.enum(['taken', 'unknown']) }),
      ]),
    ),
    scope: 'queue',
    deadlineMs: 5_000,
  }),
  'turn/interrupt': method({
    name: 'turn/interrupt',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ hard: z.boolean().optional(), op_id: z.string().optional(), turn_id: z.string().optional() })),
    result: lazySchema(() => z.object({ interrupted: z.boolean() })),
    scope: 'none',
    deadlineMs: 5_000,
  }),
  'agent/stop': method({
    name: 'agent/stop',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ agent_id: z.string(), note: z.string().optional() })),
    result: record,
    scope: 'none',
    deadlineMs: 10_000,
  }),
  'agent/resume': method({
    name: 'agent/resume',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ agent_id: z.string(), note: z.string().optional() })),
    result: record,
    scope: 'none',
    deadlineMs: 10_000,
  }),
  'shell/background': method({
    name: 'shell/background',
    from: 'host',
    kind: 'request',
    params: empty,
    result: lazySchema(() => z.object({ taken: z.number().int().positive() })),
    scope: 'none',
    deadlineMs: 10_000,
  }),
  'schedule/roster': method({
    name: 'schedule/roster',
    from: 'host',
    kind: 'request',
    params: lazySchema(() => z.object({ schedules: z.unknown() })),
    result: empty,
    scope: 'session',
    deadlineMs: null,
  }),
  'credentials/changed': method({
    name: 'credentials/changed',
    from: 'host',
    kind: 'notification',
    params: empty,
    result: empty,
    scope: 'none',
    deadlineMs: null,
  }),
  '$/cancel_request': method({
    name: '$/cancel_request',
    from: 'both',
    kind: 'notification',
    params: CancelRequestParamsSchema,
    result: empty,
    scope: 'none',
    deadlineMs: null,
  }),
  'permission/request': method({
    name: 'permission/request',
    from: 'runner',
    kind: 'request',
    params: PermissionRequestParamsSchema,
    result: PermissionAnswerSchema,
    scope: 'none',
    deadlineMs: null,
  }),
  'elicitation/request': method({
    name: 'elicitation/request',
    from: 'runner',
    kind: 'request',
    params: ElicitationRequestParamsSchema,
    result: ElicitationAnswerSchema,
    scope: 'none',
    deadlineMs: null,
    capability: 'elicitation',
  }),
  row: method({
    name: 'row',
    from: 'runner',
    kind: 'notification',
    params: RowSchema,
    result: empty,
    scope: 'none',
    deadlineMs: null,
  }),
  'session/applied': method({
    name: 'session/applied',
    from: 'runner',
    kind: 'notification',
    params: SessionAppliedParamsSchema,
    result: empty,
    scope: 'none',
    deadlineMs: null,
  }),
  'elicitation/complete': method({
    name: 'elicitation/complete',
    from: 'runner',
    kind: 'notification',
    params: lazySchema(() => z.object({ server: z.string(), elicitation_id: z.string() })),
    result: empty,
    scope: 'none',
    deadlineMs: null,
    capability: 'elicitation',
  }),
} as const

export type MethodName = keyof typeof METHODS
export type ParamsOf<M extends MethodName> = z.infer<ReturnType<(typeof METHODS)[M]['params']>>
export type ResultOf<M extends MethodName> = z.infer<ReturnType<(typeof METHODS)[M]['result']>>

type NamesWhere<F extends Sender, K extends MethodKind> = {
  [M in MethodName]: (typeof METHODS)[M]['from'] extends F | 'both' ? ((typeof METHODS)[M]['kind'] extends K ? M : never) : never
}[MethodName]

export type HostRequestName = NamesWhere<'host', 'request'>
export type HostNotificationName = NamesWhere<'host', 'notification'>
export type RunnerRequestName = NamesWhere<'runner', 'request'>
export type RunnerNotificationName = NamesWhere<'runner', 'notification'>

export const METHOD_NAMES = Object.keys(METHODS) as MethodName[]

export function isMethodName(name: string): name is MethodName {
  return Object.prototype.hasOwnProperty.call(METHODS, name)
}

export function methodOf(name: string): MethodSpec | undefined {
  return isMethodName(name) ? (METHODS[name] as MethodSpec) : undefined
}

export function methodsFrom(sender: Exclude<Sender, 'both'>, kind?: MethodKind): MethodSpec[] {
  return METHOD_NAMES.map(name => METHODS[name] as MethodSpec).filter(spec => (spec.from === sender || spec.from === 'both') && (kind === undefined || spec.kind === kind))
}

export function scopeOf(name: string): MethodScope {
  return methodOf(name)?.scope ?? 'none'
}

export function deadlineOf(name: string): number | null {
  return methodOf(name)?.deadlineMs ?? null
}

export type ParamsCheck<T = unknown> = { ok: true; value: T } | { ok: false; issues: Array<{ path: string; message: string }> }

export function checkParams<M extends MethodName>(name: M, params: unknown): ParamsCheck<ParamsOf<M>> {
  const parsed = (METHODS[name] as MethodSpec).params().safeParse(params === undefined ? {} : params)
  if (parsed.success) return { ok: true, value: parsed.data as ParamsOf<M> }
  return { ok: false, issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message })) }
}

export function checkResult<M extends MethodName>(name: M, result: unknown): ParamsCheck<ResultOf<M>> {
  const parsed = (METHODS[name] as MethodSpec).result().safeParse(result === undefined ? {} : result)
  if (parsed.success) return { ok: true, value: parsed.data as ResultOf<M> }
  return { ok: false, issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message })) }
}
