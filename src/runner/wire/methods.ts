import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { permissionModeSchema } from '../../utils/permissions/PermissionMode.js'
import { permissionUpdateSchema } from '../../utils/permissions/PermissionUpdateSchema.js'
import { InputRowSchema, RowSchema } from '../../rows/vocabulary.js'
import {
  CAPABILITIES,
  METHOD_SCOPES,
  RUNNER_PROTOCOL,
  SESSION_VERBS,
  capabilitiesShape,
  fileCheckpointsFactShape,
  type Capability,
  type MethodKind,
  type MethodScope,
  type RunnerSchemaKit,
  type RunnerVerbKey,
  type Sender,
  type SessionVerbRow,
} from './sessionVerbs.js'
import { keysOf } from '../../utils/entriesOf.js'

export { CAPABILITIES, METHOD_SCOPES, RUNNER_PROTOCOL, type MethodScope }

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

const empty = lazySchema(() => z.object({}))
const record = lazySchema(() => z.record(z.string(), z.unknown()))
const applied = lazySchema(() => z.enum(['now', 'turn_end']))

const SCHEMA_KIT: RunnerSchemaKit = {
  z: {
    array: z.array,
    boolean: z.boolean,
    discriminatedUnion: z.discriminatedUnion,
    enum: z.enum,
    literal: z.literal,
    number: z.number,
    object: z.object,
    record: z.record,
    strictObject: z.strictObject,
    string: z.string,
    union: z.union,
    unknown: z.unknown,
  },
  empty,
  record,
  applied,
  permissionMode: permissionModeSchema,
  permissionUpdate: permissionUpdateSchema,
  inputRow: InputRowSchema,
  row: RowSchema,
}

type HydratedSpec<K extends RunnerVerbKey> = MethodSpec<
  ReturnType<(typeof SESSION_VERBS)[K]['runner']['params']>,
  ReturnType<(typeof SESSION_VERBS)[K]['runner']['result']>
> & {
  readonly name: (typeof SESSION_VERBS)[K]['runner']['name']
  readonly from: (typeof SESSION_VERBS)[K]['runner']['from']
  readonly kind: (typeof SESSION_VERBS)[K]['runner']['kind']
  readonly scope: (typeof SESSION_VERBS)[K]['runner']['scope']
  readonly deadlineMs: (typeof SESSION_VERBS)[K]['runner']['deadlineMs']
}

type MethodsMap = {
  readonly [K in RunnerVerbKey as (typeof SESSION_VERBS)[K]['runner']['name']]: HydratedSpec<K>
}

function hydrateMethods(): MethodsMap {
  const out: Record<string, MethodSpec> = {}
  for (const row of Object.values(SESSION_VERBS) as readonly SessionVerbRow[]) {
    const r = row.runner
    if (r === undefined) continue
    out[r.name] = {
      name: r.name,
      from: r.from,
      kind: r.kind,
      params: lazySchema(() => r.params(SCHEMA_KIT)),
      result: lazySchema(() => r.result(SCHEMA_KIT)),
      scope: r.scope,
      deadlineMs: r.deadlineMs,
      ...(r.capability !== undefined ? { capability: r.capability } : {}),
    }
  }
  return out as MethodsMap
}

export const METHODS: MethodsMap = hydrateMethods()

export const CapabilitiesSchema = lazySchema(() => capabilitiesShape(SCHEMA_KIT))
export type Capabilities = z.infer<ReturnType<typeof CapabilitiesSchema>>

export const InitializeParamsSchema = METHODS.initialize.params
export type InitializeParams = z.infer<ReturnType<typeof InitializeParamsSchema>>

export const FileCheckpointsFactSchema = lazySchema(() => fileCheckpointsFactShape(SCHEMA_KIT))
export type FileCheckpointsFact = z.infer<ReturnType<typeof FileCheckpointsFactSchema>>

export const InitializeResultSchema = METHODS.initialize.result
export type InitializeResult = z.infer<ReturnType<typeof InitializeResultSchema>>

export const PermissionRequestParamsSchema = METHODS[SESSION_VERBS.answerAsk.runner.name].params
export type PermissionRequestParams = z.infer<ReturnType<typeof PermissionRequestParamsSchema>>

export type PermissionAnswer = z.infer<ReturnType<(typeof METHODS)[typeof SESSION_VERBS.answerAsk.runner.name]['result']>>
export type ElicitationRequestParams = z.infer<ReturnType<(typeof METHODS)[typeof SESSION_VERBS.elicitationRequest.runner.name]['params']>>
export type ElicitationAnswer = z.infer<ReturnType<(typeof METHODS)[typeof SESSION_VERBS.elicitationRequest.runner.name]['result']>>
export type SessionAppliedParams = z.infer<ReturnType<(typeof METHODS)[typeof SESSION_VERBS.sessionApplied.runner.name]['params']>>

export type MethodName = keyof typeof METHODS
export type ParamsOf<M extends MethodName> = z.infer<ReturnType<(typeof METHODS)[M]['params']>>
export type ResultOf<M extends MethodName> = z.infer<ReturnType<(typeof METHODS)[M]['result']>>

type NamesWhere<F extends Sender, K extends MethodKind> = {
  [M in MethodName]: (typeof METHODS)[M]['from'] extends F | 'both' ? ((typeof METHODS)[M]['kind'] extends K ? M : never) : never
}[MethodName]

export type HostRequestName = NamesWhere<'host', 'request'>
export type HostNotificationName = NamesWhere<'host', 'notification'>

export const METHOD_NAMES: MethodName[] = keysOf(METHODS)

export function isMethodName(name: string): name is MethodName {
  return Object.prototype.hasOwnProperty.call(METHODS, name)
}

function methodOf(name: string): MethodSpec | undefined {
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

type ParamsCheck<T = unknown> = { ok: true; value: T } | { ok: false; issues: Array<{ path: string; message: string }> }

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
