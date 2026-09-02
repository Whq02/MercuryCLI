
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
  startToken: string | null
  startedAt: number | null
  stoppedAt: number | null
  lastExitCode: number | null
  explicitStop: boolean
  restartCount: number
  readiness: ReadinessStatus[]
  logFile: string
  ownerSessionId: string | null
  logStartByte?: number
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
