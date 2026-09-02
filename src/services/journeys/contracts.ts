
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { ReadinessCondition } from '../projectServices/contracts.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function journeysEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_JOURNEYS'))
}

export type JourneyStep =
  | {
      kind: 'service.start'
      name: string
      command: string
      args?: string[]
      readiness?: ReadinessCondition[]
      readinessMode?: 'all' | 'any'
      label?: string
      timeoutMs?: number
    }
  | { kind: 'service.wait'; name: string; label?: string; timeoutMs?: number }
  | {
      kind: 'http.request'
      url: string
      method?: string
      body?: string
      headers?: Record<string, string>
      expect?: {
        status?: number
        bodyIncludes?: string
        headerIncludes?: Record<string, string>
        jsonPath?: string
        equals?: string
      }
      label?: string
      timeoutMs?: number
    }
  | {
      kind: 'command.run'
      command: string
      args?: string[]
      cwd?: string
      expect?: { exitCode?: number; stdoutIncludes?: string }
      label?: string
      timeoutMs?: number
    }
  | {
      kind: 'file.inspect'
      path: string
      expect?: { exists?: boolean; contains?: string }
      label?: string
      timeoutMs?: number
    }
  | {
      kind: 'log.match'
      service: string
      pattern: string
      label?: string
      timeoutMs?: number
    }
  | {
      kind: 'diagnostic.check'
      files: string[]
      label?: string
      timeoutMs?: number
    }
  | {
      kind: 'value.assert'
      jsonPath: string
      equals: string
      label?: string
      timeoutMs?: number
    }
  | { kind: 'service.stop'; name: string; label?: string; timeoutMs?: number }

export interface JourneySpec {
  objective: string
  steps: JourneyStep[]
  cleanup?: 'stop-started' | 'keep'
}

export type JourneyStepState = 'passed' | 'failed' | 'skipped' | 'cancelled'

export interface JourneyStepResult {
  index: number
  kind: JourneyStep['kind']
  label: string
  state: JourneyStepState
  detail: string
  evidenceRef?: string
  elapsedMs: number
}

export type JourneyState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JourneyRecord {
  id: string
  objective: string
  state: JourneyState
  createdAt: number
  settledAt?: number
  root: string
  steps: JourneyStepResult[]
  cleanup: { service: string; action: 'stopped' | 'kept' | 'stop-failed'; detail?: string }[]
  executionRef: string
  evidenceRefs: string[]
  failedStep?: number
}
