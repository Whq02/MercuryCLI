import type { z } from 'zod/v4'
import type { permissionModeSchema } from '../../utils/permissions/PermissionMode.js'
import type { permissionUpdateSchema } from '../../utils/permissions/PermissionUpdateSchema.js'
import type { InputRowSchema, RowSchema } from '../../rows/vocabulary.js'

export const RUNNER_PROTOCOL = 1

export const METHOD_SCOPES = ['none', 'queue', 'session', 'mcp'] as const
export type MethodScope = (typeof METHOD_SCOPES)[number]

export const CAPABILITIES = ['holds_asks', 'elicitation', 'partial_rows', 'fs_read_text_file', 'fs_write_text_file', 'terminal'] as const
export type Capability = (typeof CAPABILITIES)[number]

export type Sender = 'host' | 'runner' | 'both'
export type MethodKind = 'request' | 'notification'

type VerbCodecName =
  | 'sessionFacts'
  | 'rewindOutcome'
  | 'sessionKit'
  | 'scheduleRoster'
  | 'scheduleEdit'
  | 'mcpTools'
  | 'openaiCatalogue'

export interface RunnerSchemaKit {
  readonly z: Pick<
    typeof z,
    | 'array'
    | 'boolean'
    | 'discriminatedUnion'
    | 'enum'
    | 'literal'
    | 'number'
    | 'object'
    | 'record'
    | 'strictObject'
    | 'string'
    | 'union'
    | 'unknown'
  >
  readonly empty: () => z.ZodObject<Record<never, never>>
  readonly record: () => z.ZodRecord<z.ZodString, z.ZodUnknown>
  readonly applied: () => z.ZodEnum<{ readonly now: 'now'; readonly turn_end: 'turn_end' }>
  readonly permissionMode: typeof permissionModeSchema
  readonly permissionUpdate: typeof permissionUpdateSchema
  readonly inputRow: typeof InputRowSchema
  readonly row: typeof RowSchema
}

interface DaemonFaceSpec {
  readonly op: string
  readonly action?: string
  readonly legacyOp?: string
  readonly bornAt?: number
  readonly bornOrder?: number
  readonly auth?: boolean
}

interface RunnerFaceSpec {
  readonly name: string
  readonly from: Sender
  readonly kind: MethodKind
  readonly scope: MethodScope
  readonly deadlineMs: number | null
  readonly capability?: Capability
  readonly params: (k: RunnerSchemaKit) => z.ZodType
  readonly result: (k: RunnerSchemaKit) => z.ZodType
}

export interface SessionVerbRow {
  readonly connector?: string
  readonly daemon?: DaemonFaceSpec
  readonly runner?: RunnerFaceSpec
  readonly codec?: VerbCodecName
  readonly detailJson?: true
  readonly carrier?: 'empty-detail'
}

export const capabilitiesShape = (k: RunnerSchemaKit) =>
  k.z.object({
    holds_asks: k.z.boolean(),
    elicitation: k.z.boolean(),
    partial_rows: k.z.boolean(),
    fs_read_text_file: k.z.boolean().optional(),
    fs_write_text_file: k.z.boolean().optional(),
    terminal: k.z.boolean().optional(),
  })

export const fileCheckpointsFactShape = (k: RunnerSchemaKit) =>
  k.z.object({
    capture: k.z.boolean(),
    source: k.z.enum(['interactive', 'seat', 'initialize', 'setting', 'headless']),
  })

const initializeParamsShape = (k: RunnerSchemaKit) =>
  k.z.object({
    protocol: k.z.literal(RUNNER_PROTOCOL),
    host: k.z.object({ name: k.z.string(), version: k.z.string() }),
    capabilities: capabilitiesShape(k),
    schema: k.z.record(k.z.string(), k.z.unknown()).optional(),
    file_checkpoints: k.z.boolean().optional(),
  })

const initializeResultShape = (k: RunnerSchemaKit) =>
  k.z.object({
    protocol: k.z.literal(RUNNER_PROTOCOL),
    runner: k.z.object({ version: k.z.string(), pid: k.z.number().int() }),
    session_id: k.z.string().nullable(),
    file_checkpoints: fileCheckpointsFactShape(k).optional(),
  })

const permissionRequestParamsShape = (k: RunnerSchemaKit) =>
  k.z.object({
    kind: k.z.literal('tool'),
    tool_use_id: k.z.string(),
    tool_name: k.z.string(),
    input: k.z.record(k.z.string(), k.z.unknown()),
    title: k.z.string().optional(),
    display_name: k.z.string().optional(),
    description: k.z.string().optional(),
    suggestions: k.z.array(k.permissionUpdate()).optional(),
    blocked_path: k.z.string().optional(),
    cwd: k.z.string().optional(),
    reason: k.z.string().optional(),
    reason_detail: k.z.unknown().optional(),
    agent_id: k.z.string().optional(),
    mode: k.permissionMode().optional(),
  })

const permissionAnswerShape = (k: RunnerSchemaKit) =>
  k.z.discriminatedUnion('outcome', [
    k.z.object({
      outcome: k.z.literal('allow'),
      input: k.z.record(k.z.string(), k.z.unknown()).optional(),
      rules: k.z.array(k.permissionUpdate()).optional(),
    }),
    k.z.object({
      outcome: k.z.literal('deny'),
      message: k.z.string().optional(),
      stop: k.z.boolean().optional(),
    }),
  ])

const elicitationRequestParamsShape = (k: RunnerSchemaKit) =>
  k.z.object({
    server: k.z.string(),
    message: k.z.string(),
    mode: k.z.enum(['form', 'url']).optional(),
    url: k.z.string().optional(),
    elicitation_id: k.z.string().optional(),
    schema: k.z.record(k.z.string(), k.z.unknown()).optional(),
    title: k.z.string().optional(),
  })

const elicitationAnswerShape = (k: RunnerSchemaKit) =>
  k.z.object({
    action: k.z.enum(['accept', 'decline', 'cancel']),
    content: k.z.record(k.z.string(), k.z.unknown()).optional(),
  })

const mcpToolsResultShape = (k: RunnerSchemaKit) =>
  k.z.object({
    server: k.z.string(),
    state: k.z.enum(['connected', 'needs-auth', 'failed', 'disabled', 'pending', 'absent']),
    tools: k.z.array(
      k.z.object({
        name: k.z.string(),
        registered_as: k.z.string(),
        description: k.z.string(),
        description_cut: k.z.literal(true).optional(),
        input_schema: k.z.record(k.z.string(), k.z.unknown()),
        schema_withheld_bytes: k.z.number().int().nonnegative().optional(),
        loading: k.z.enum(['deferred', 'listed', 'held']),
      }),
    ),
    omitted: k.z.number().int().nonnegative(),
    detail: k.z.string().optional(),
  })

const projectQueryParamsShape = (k: RunnerSchemaKit) =>
  k.z.strictObject({
    op: k.z.enum(['sessions', 'rows', 'send', 'recall', 'resources', 'resource']),
    session_id: k.z.string().optional(),
    limit: k.z.number().int().min(1).max(200).optional(),
    before: k.z.number().int().min(0).optional(),
    sender: k.z.string().min(1).max(200).optional(),
    message: k.z.string().min(1).optional(),
    message_id: k.z.string().optional(),
    query: k.z.string().min(1).optional(),
    ref: k.z.string().optional(),
  })

const claimParamsShape = (k: RunnerSchemaKit) =>
  k.z.object({
    session_id: k.z.string(),
    model: k.z.string().optional(),
    mode: k.z.string().optional(),
    effort: k.z.string().optional(),
    resume: k.z.boolean().optional(),
    restart_reason: k.z.string().optional(),
    title: k.z.string().optional(),
    openai_catalogue: k.z.unknown().optional(),
  })

const scheduleEditResultShape = (k: RunnerSchemaKit) =>
  k.z.object({
    outcome: k.z.enum(['applied', 'noop', 'refused']),
    detail: k.z.string().optional(),
    schedule_id: k.z.string().optional(),
    next_fire_ms: k.z.number().nullable().optional(),
    time_zone: k.z.string().optional(),
    family: k.z.string().optional(),
    preflight: k.z.object({ state: k.z.string(), expires_at: k.z.number().optional(), before_fire: k.z.boolean().optional(), retry_at: k.z.number().optional() }).optional(),
  })

const terminalOutputResultShape = (k: RunnerSchemaKit) =>
  k.z.object({
    output: k.z.string(),
    truncated: k.z.boolean(),
    exit_status: k.z.object({ exit_code: k.z.number().int().nullable().optional(), signal: k.z.string().nullable().optional() }).nullable().optional(),
  })

export const SESSION_VERBS = {
  initialize: {
    runner: { name: 'initialize', from: 'host', kind: 'request', scope: 'none', deadlineMs: null, params: initializeParamsShape, result: initializeResultShape },
  },
  claim: {
    runner: { name: 'session/claim', from: 'host', kind: 'request', scope: 'session', deadlineMs: 45_000, params: claimParamsShape, result: k => k.z.object({ session_id: k.z.string() }) },
    codec: 'openaiCatalogue',
  },
  projectQuery: {
    runner: { name: 'project/query', from: 'host', kind: 'request', scope: 'none', deadlineMs: 30_000, params: projectQueryParamsShape, result: k => k.record() },
  },
  sessionFacts: {
    daemon: { op: 'sessionControl', action: 'session-facts' },
    runner: { name: 'session/facts', from: 'host', kind: 'request', scope: 'none', deadlineMs: 30_000, params: k => k.empty(), result: k => k.record() },
    codec: 'sessionFacts',
  },
  setModel: {
    connector: 'setModel',
    daemon: { op: 'sessionControl', action: 'set-model' },
    runner: { name: 'session/set_model', from: 'host', kind: 'request', scope: 'session', deadlineMs: 5_000, params: k => k.z.object({ model: k.z.string().optional(), words: k.z.string().optional(), replaced_default: k.z.string().optional() }), result: k => k.z.object({ model: k.z.string(), at: k.applied() }) },
  },
  setEffort: {
    connector: 'setEffort',
    daemon: { op: 'sessionControl', action: 'set-effort', bornAt: 3, bornOrder: 6 },
    runner: { name: 'session/set_effort', from: 'host', kind: 'request', scope: 'session', deadlineMs: 5_000, params: k => k.z.object({ effort: k.z.string() }), result: k => k.z.object({ effort: k.z.string(), at: k.applied() }) },
  },
  setPermissionMode: {
    connector: 'setPermissionMode',
    daemon: { op: 'sessionControl', action: 'set-permission-mode' },
    runner: { name: 'session/set_mode', from: 'host', kind: 'request', scope: 'session', deadlineMs: 5_000, params: k => k.z.object({ mode: k.z.string() }), result: k => k.z.object({ mode: k.permissionMode() }) },
  },
  setSpawnSwitch: {
    connector: 'setSpawnSwitch',
    daemon: { op: 'sessionControl', action: 'set-spawn-switch', bornAt: 6 },
    runner: { name: 'session/set_spawn_switch', from: 'host', kind: 'request', scope: 'session', deadlineMs: 5_000, params: k => k.z.object({ switch: k.z.enum(['subagents', 'workflows']), on: k.z.boolean() }), result: k => k.z.object({ switch: k.z.enum(['subagents', 'workflows']), on: k.z.boolean(), at: k.applied() }) },
  },
  mcpAction: {
    connector: 'mcpAction',
    daemon: { op: 'sessionControl', action: 'mcp-action', bornAt: 15 },
    runner: { name: 'mcp/action', from: 'host', kind: 'request', scope: 'none', deadlineMs: 300_000, params: k => k.z.object({ name: k.z.string().min(1).max(200), action: k.z.enum(['authenticate', 'reconnect', 'cancel-auth']) }), result: k => k.z.object({ outcome: k.z.enum(['applied', 'refused']), detail: k.z.string().optional() }) },
  },
  mcpTools: {
    connector: 'mcpTools',
    daemon: { op: 'sessionControl', action: 'mcp-tools', bornAt: 16 },
    runner: { name: 'mcp/tools', from: 'host', kind: 'request', scope: 'none', deadlineMs: 10_000, params: k => k.z.object({ name: k.z.string().min(1).max(200) }), result: mcpToolsResultShape },
    codec: 'mcpTools',
  },
  setKit: {
    connector: 'setKit',
    daemon: { op: 'sessionControl', action: 'set-kit' },
    runner: { name: 'session/set_kit', from: 'host', kind: 'request', scope: 'mcp', deadlineMs: 30_000, params: k => k.z.object({ kit: k.z.unknown() }), result: k => k.z.object({ applied: k.z.literal(true), connected: k.z.array(k.z.string()), disconnected: k.z.array(k.z.string()), errors: k.z.record(k.z.string(), k.z.string()) }) },
    codec: 'sessionKit',
  },
  rewind: {
    connector: 'rewind',
    daemon: { op: 'sessionRewind', bornAt: 5 },
    runner: { name: 'session/rewind', from: 'host', kind: 'request', scope: 'session', deadlineMs: 30_000, params: k => k.z.object({ user_message_id: k.z.string(), mode: k.z.enum(['code', 'conversation', 'both']), dry_run: k.z.boolean().optional() }), result: k => k.record() },
    codec: 'rewindOutcome',
  },
  fileRestore: {
    connector: 'rewind',
    daemon: { op: 'sessionFileRestore', bornAt: 17 },
    runner: { name: 'session/file_restore', from: 'host', kind: 'request', scope: 'session', deadlineMs: 30_000, params: k => k.z.discriminatedUnion('action', [k.z.object({ action: k.z.literal('restore'), user_message_id: k.z.string(), file_path: k.z.string().min(1), dry_run: k.z.boolean().optional() }), k.z.object({ action: k.z.literal('undo'), user_message_id: k.z.string(), dry_run: k.z.boolean().optional() })]), result: k => k.record() },
    codec: 'rewindOutcome',
  },
  pauseGate: {
    connector: 'pauseGate',
    daemon: { op: 'sessionControl', action: 'pause-gate', bornAt: 12 },
    runner: { name: 'session/pause_gate', from: 'host', kind: 'request', scope: 'session', deadlineMs: 10_000, params: k => k.z.object({ paused: k.z.boolean() }), result: k => k.z.object({ paused: k.z.boolean(), parked: k.z.number().int().min(0), changed: k.z.boolean() }) },
    detailJson: true,
  },
  postBoard: {
    connector: 'postBoard',
    daemon: { op: 'sessionControl', action: 'board-post', bornAt: 19 },
    runner: { name: 'session/board_post', from: 'host', kind: 'request', scope: 'session', deadlineMs: 10_000, params: k => k.z.object({ client_op_id: k.z.string().min(1).max(160), channel: k.z.enum(['general', 'team', 'whisper']), target: k.z.string().optional(), text: k.z.string().min(1) }), result: k => k.z.union([k.z.object({ ok: k.z.literal(true), event_id: k.z.string(), seq: k.z.number().int(), replay: k.z.boolean(), address: k.z.string(), recipients: k.z.array(k.z.string()) }), k.z.object({ ok: k.z.literal(false), reason: k.z.string(), candidates: k.z.array(k.z.string()).optional() })]) },
    detailJson: true,
  },
  quiesce: {
    runner: { name: 'session/quiesce', from: 'host', kind: 'request', scope: 'session', deadlineMs: 10_000, params: k => k.z.object({ action: k.z.enum(['prepare', 'commit', 'cancel']), token: k.z.string() }), result: k => k.z.object({ token: k.z.string(), phase: k.z.string() }) },
  },
  leave: {
    connector: 'leave',
    daemon: { op: 'sessionControl', action: 'leave', bornAt: 14 },
    runner: { name: 'session/leave', from: 'host', kind: 'request', scope: 'none', deadlineMs: null, params: k => k.empty(), result: k => k.z.object({ note: k.z.enum(['stored', 'skipped', 'none']), ledger: k.z.enum(['closed', 'absent']), noteChars: k.z.number().int().min(0).optional() }) },
    detailJson: true,
  },
  sendWords: {
    connector: 'sendWords',
    daemon: { op: 'sessionDispatch', legacyOp: 'concourseDispatch', bornAt: 3, bornOrder: 2 },
    runner: { name: 'queue/add', from: 'host', kind: 'request', scope: 'queue', deadlineMs: 5_000, params: k => k.inputRow(), result: k => k.z.discriminatedUnion('accepted', [k.z.object({ accepted: k.z.literal(true) }), k.z.object({ accepted: k.z.literal(false), reason: k.z.literal('duplicate') })]) },
  },
  withdrawSend: {
    connector: 'withdrawSend',
    daemon: { op: 'sessionControl', action: 'withdraw-send', bornAt: 9 },
    runner: { name: 'queue/withdraw', from: 'host', kind: 'request', scope: 'queue', deadlineMs: 5_000, params: k => k.z.object({ id: k.z.string() }), result: k => k.z.discriminatedUnion('withdrawn', [k.z.object({ withdrawn: k.z.literal(true), text: k.z.string() }), k.z.object({ withdrawn: k.z.literal(false), reason: k.z.enum(['taken', 'unknown']) })]) },
  },
  interrupt: {
    connector: 'interrupt',
    daemon: { op: 'sessionControl', action: 'interrupt' },
    runner: { name: 'turn/interrupt', from: 'host', kind: 'request', scope: 'none', deadlineMs: 5_000, params: k => k.z.object({ hard: k.z.boolean().optional(), op_id: k.z.string().optional(), turn_id: k.z.string().optional() }), result: k => k.z.object({ interrupted: k.z.boolean() }) },
  },
  stopAgent: {
    connector: 'stopAgent',
    daemon: { op: 'sessionControl', action: 'stop-agent', bornAt: 8 },
    runner: { name: 'agent/stop', from: 'host', kind: 'request', scope: 'none', deadlineMs: 10_000, params: k => k.z.object({ agent_id: k.z.string(), note: k.z.string().optional() }), result: k => k.record() },
    detailJson: true,
  },
  resumeAgent: {
    connector: 'resumeAgent',
    daemon: { op: 'sessionControl', action: 'resume-agent', bornAt: 8 },
    runner: { name: 'agent/resume', from: 'host', kind: 'request', scope: 'none', deadlineMs: 10_000, params: k => k.z.object({ agent_id: k.z.string(), note: k.z.string().optional() }), result: k => k.record() },
    detailJson: true,
  },
  backgroundShell: {
    connector: 'backgroundShell',
    daemon: { op: 'sessionControl', action: 'background-shell', bornAt: 11 },
    runner: { name: 'shell/background', from: 'host', kind: 'request', scope: 'none', deadlineMs: 10_000, params: k => k.empty(), result: k => k.z.object({ taken: k.z.number().int().positive() }) },
    detailJson: true,
    carrier: 'empty-detail',
  },
  sendNow: {
    connector: 'sendNow',
    daemon: { op: 'sessionControl', action: 'send-now', bornAt: 18 },
    runner: { name: 'session/send_now', from: 'host', kind: 'request', scope: 'none', deadlineMs: 10_000, params: k => k.empty(), result: k => k.z.object({ queued: k.z.number().int().min(0), released: k.z.number().int().min(0), crewmates: k.z.number().int().min(0), shells: k.z.number().int().min(0) }) },
    detailJson: true,
    carrier: 'empty-detail',
  },
  scheduleEdit: {
    runner: { name: 'schedule/edit', from: 'runner', kind: 'request', scope: 'none', deadlineMs: 10_000, params: k => k.z.object({ edit: k.z.unknown() }), result: scheduleEditResultShape },
    codec: 'scheduleEdit',
  },
  scheduleRoster: {
    runner: { name: 'schedule/roster', from: 'host', kind: 'request', scope: 'session', deadlineMs: null, params: k => k.z.object({ schedules: k.z.unknown() }), result: k => k.empty() },
    codec: 'scheduleRoster',
  },
  credentialsChanged: {
    runner: { name: 'credentials/changed', from: 'host', kind: 'notification', scope: 'none', deadlineMs: null, params: k => k.empty(), result: k => k.empty() },
  },
  cancelRequest: {
    runner: { name: '$/cancel_request', from: 'both', kind: 'notification', scope: 'none', deadlineMs: null, params: k => k.z.object({ request_id: k.z.number().int().positive(), reason: k.z.string().optional() }), result: k => k.empty() },
  },
  answerAsk: {
    connector: 'answerAsk',
    daemon: { op: 'sessionControl', action: 'answer-permission' },
    runner: { name: 'permission/request', from: 'runner', kind: 'request', scope: 'none', deadlineMs: null, params: permissionRequestParamsShape, result: permissionAnswerShape },
  },
  elicitationRequest: {
    runner: { name: 'elicitation/request', from: 'runner', kind: 'request', scope: 'none', deadlineMs: null, capability: 'elicitation', params: elicitationRequestParamsShape, result: elicitationAnswerShape },
  },
  fsReadTextFile: {
    runner: { name: 'fs/read_text_file', from: 'runner', kind: 'request', scope: 'none', deadlineMs: 30_000, capability: 'fs_read_text_file', params: k => k.z.object({ path: k.z.string(), line: k.z.number().int().positive().nullable().optional(), limit: k.z.number().int().positive().nullable().optional() }), result: k => k.z.object({ content: k.z.string() }) },
  },
  fsWriteTextFile: {
    runner: { name: 'fs/write_text_file', from: 'runner', kind: 'request', scope: 'none', deadlineMs: 30_000, capability: 'fs_write_text_file', params: k => k.z.object({ path: k.z.string(), content: k.z.string() }), result: k => k.empty() },
  },
  terminalCreate: {
    runner: { name: 'terminal/create', from: 'runner', kind: 'request', scope: 'none', deadlineMs: 30_000, capability: 'terminal', params: k => k.z.object({ command: k.z.string(), args: k.z.array(k.z.string()).optional(), env: k.z.array(k.z.object({ name: k.z.string(), value: k.z.string() })).optional(), cwd: k.z.string().nullable().optional(), output_byte_limit: k.z.number().int().positive().nullable().optional() }), result: k => k.z.object({ terminal_id: k.z.string() }) },
  },
  terminalOutput: {
    runner: { name: 'terminal/output', from: 'runner', kind: 'request', scope: 'none', deadlineMs: 30_000, capability: 'terminal', params: k => k.z.object({ terminal_id: k.z.string() }), result: terminalOutputResultShape },
  },
  terminalWaitForExit: {
    runner: { name: 'terminal/wait_for_exit', from: 'runner', kind: 'request', scope: 'none', deadlineMs: null, capability: 'terminal', params: k => k.z.object({ terminal_id: k.z.string() }), result: k => k.z.object({ exit_code: k.z.number().int().nullable().optional(), signal: k.z.string().nullable().optional() }) },
  },
  terminalKill: {
    runner: { name: 'terminal/kill', from: 'runner', kind: 'request', scope: 'none', deadlineMs: 15_000, capability: 'terminal', params: k => k.z.object({ terminal_id: k.z.string() }), result: k => k.empty() },
  },
  terminalRelease: {
    runner: { name: 'terminal/release', from: 'runner', kind: 'request', scope: 'none', deadlineMs: 15_000, capability: 'terminal', params: k => k.z.object({ terminal_id: k.z.string() }), result: k => k.empty() },
  },
  row: {
    runner: { name: 'row', from: 'runner', kind: 'notification', scope: 'none', deadlineMs: null, params: k => k.row(), result: k => k.empty() },
  },
  sessionApplied: {
    runner: { name: 'session/applied', from: 'runner', kind: 'notification', scope: 'none', deadlineMs: null, params: k => k.z.object({ request_id: k.z.number().int().positive(), verb: k.z.enum(['set_model', 'set_effort', 'set_spawn_switch']), model: k.z.string().optional(), effort: k.z.string().optional(), switch: k.z.enum(['subagents', 'workflows']).optional(), on: k.z.boolean().optional() }), result: k => k.empty() },
  },
  elicitationComplete: {
    runner: { name: 'elicitation/complete', from: 'runner', kind: 'notification', scope: 'none', deadlineMs: null, capability: 'elicitation', params: k => k.z.object({ server: k.z.string(), elicitation_id: k.z.string() }), result: k => k.empty() },
  },
  sessionAdmit: { daemon: { op: 'sessionAdmit', legacyOp: 'concourseAdmit', bornAt: 3, bornOrder: 1 } },
  sessionList: { daemon: { op: 'sessionList', legacyOp: 'concourseList', bornAt: 3, bornOrder: 3 } },
  sessionRelease: { daemon: { op: 'sessionRelease', legacyOp: 'concourseRelease', bornAt: 3, bornOrder: 4 } },
  sessionControl: { daemon: { op: 'sessionControl', legacyOp: 'concourseControl', bornAt: 3, bornOrder: 5 } },
  concourseWithdraw: { daemon: { op: 'concourseWithdraw' } },
  concourseWarm: { daemon: { op: 'concourseWarm' } },
  pause: { daemon: { op: 'sessionControl', action: 'pause' } },
  resume: { daemon: { op: 'sessionControl', action: 'resume' } },
  attach: { daemon: { op: 'sessionControl', action: 'attach' } },
  detach: { daemon: { op: 'sessionControl', action: 'detach' } },
  grantWorkflows: { daemon: { op: 'sessionControl', action: 'grant-workflows' } },
  revokeWorkflows: { daemon: { op: 'sessionControl', action: 'revoke-workflows' } },
  stop: { daemon: { op: 'sessionControl', action: 'stop' } },
  setTitle: { daemon: { op: 'sessionControl', action: 'set-title' } },
  focus: { daemon: { op: 'sessionControl', action: 'focus' } },
  blur: { daemon: { op: 'sessionControl', action: 'blur' } },
  park: { daemon: { op: 'sessionControl', action: 'park' } },
  parkAll: { daemon: { op: 'sessionControl', action: 'park-all' } },
  setSchedule: { daemon: { op: 'sessionControl', action: 'set-schedule' } },
  hello: { daemon: { op: 'hello', bornAt: 2, auth: false } },
  restartWhenIdle: { daemon: { op: 'restart-when-idle', bornAt: 2 } },
  signIns: { daemon: { op: 'signIns', bornAt: 7 } },
  processSweep: { daemon: { op: 'processSweep', bornAt: 10 } },
} as const satisfies Record<string, SessionVerbRow>

type SessionVerbKey = keyof typeof SESSION_VERBS

export type RunnerVerbKey = {
  [K in SessionVerbKey]: (typeof SESSION_VERBS)[K] extends { readonly runner: RunnerFaceSpec } ? K : never
}[SessionVerbKey]

type DaemonVerbKey = {
  [K in SessionVerbKey]: (typeof SESSION_VERBS)[K] extends { readonly daemon: DaemonFaceSpec } ? K : never
}[SessionVerbKey]

export type SessionControlAction = {
  [K in SessionVerbKey]: (typeof SESSION_VERBS)[K] extends { readonly daemon: { readonly op: 'sessionControl'; readonly action: infer A extends string } }
    ? A
    : never
}[SessionVerbKey]

export type DaemonOpFor<K extends DaemonVerbKey> =
  (typeof SESSION_VERBS)[K]['daemon'] extends { readonly op: infer O extends string; readonly legacyOp: infer L extends string }
    ? O | L
    : (typeof SESSION_VERBS)[K]['daemon'] extends { readonly op: infer O extends string }
      ? O
      : never

export const DAEMON_VERB_BORN_AT: Readonly<Record<string, number>> = Object.fromEntries(
  (Object.values(SESSION_VERBS) as readonly SessionVerbRow[])
    .filter((row): row is SessionVerbRow & { daemon: DaemonFaceSpec & { bornAt: number } } => row.daemon?.bornAt !== undefined)
    .sort((a, b) => a.daemon.bornAt - b.daemon.bornAt || (a.daemon.bornOrder ?? 0) - (b.daemon.bornOrder ?? 0))
    .map(row => [row.daemon.action !== undefined ? `${row.daemon.op}/${row.daemon.action}` : row.daemon.op, row.daemon.bornAt]),
)
