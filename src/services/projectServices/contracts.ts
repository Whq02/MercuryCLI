// ============================================================================
//  projectServices/contracts — named long-lived project processes as STATE
//  MACHINES. A service is not a shell command that
//  happened to keep running: it has a stable project-scoped name, a
//  retained launch spec, a lifecycle, readiness conditions with per-
//  condition truth, an ordered log cursor, restart history, and explicit
//  stop semantics. Records are durable (atomic publish) and RECONCILED —
//  a record alone never claims a live process.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type ReadinessCondition =
  | { kind: 'log'; regex: string }
  | { kind: 'tcp'; host?: string; port: number }
  | { kind: 'http'; url: string; method?: string; status?: number; bodyRegex?: string }
  | { kind: 'file'; path: string; contentRegex?: string }
  | { kind: 'stable'; ms: number }

export type ServiceLifecycle = 'session' | 'project'
export type RestartPolicy = 'never' | 'on-failure'

export interface ServiceSpec {
  /** Stable name within the project (slug-safe). */
  name: string
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  readiness: ReadinessCondition[]
  readinessMode: 'all' | 'any'
  restart: RestartPolicy
  lifecycle: ServiceLifecycle
}

export type ServiceState =
  | 'queued'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'

export interface ReadinessStatus {
  condition: ReadinessCondition
  met: boolean
  detail: string
}

export interface ServiceRecord {
  schema: 1
  spec: ServiceSpec
  state: ServiceState
  pid: number | null
  /** Process start token (ps lstart) — pairs with pid to close the
   *  pid-reuse window on reconciliation (the ownerWatch idiom). */
  startToken: string | null
  startedAt: number | null
  stoppedAt: number | null
  lastExitCode: number | null
  /** True when the last stop was EXPLICIT (suppresses restart). */
  explicitStop: boolean
  restartCount: number
  readiness: ReadinessStatus[]
  logFile: string
  /** The session that spawned the live process (stdin ownership). */
  ownerSessionId: string | null
  /** Log-file byte offset at THIS start (the log appends across starts —
   *  log readiness reads only this generation's bytes). Optional: records
   *  written before the field read the whole file, the pre-fix behavior. */
  logStartByte?: number
  /** Why a stop did not force-kill: an unverifiable or reused pid is never
   *  struck, and the operator is told rather than sold a clean stop. */
  stopNote?: string
  updatedAt: number
}

export function servicesEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_SERVICES'))
}

export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function describeCondition(c: ReadinessCondition): string {
  switch (c.kind) {
    case 'log':
      return `log matches /${c.regex}/`
    case 'tcp':
      return `tcp ${c.host ?? '127.0.0.1'}:${c.port} accepts`
    case 'http':
      return `http ${c.method ?? 'GET'} ${c.url} → ${c.status ?? 200}${c.bodyRegex ? ` body /${c.bodyRegex}/` : ''}`
    case 'file':
      return `file ${c.path}${c.contentRegex ? ` matches /${c.contentRegex}/` : ' exists'}`
    case 'stable':
      return `process alive for ${c.ms}ms`
  }
}
