// ============================================================================
//  journeys/contracts — compositional local application-journey
//  verification. A journey is a DECLARATIVE ordered step
//  list executed against EXISTING owners — project services, bounded
//  child processes, loopback HTTP fixtures, file/log/diagnostic checks —
//  producing an execution-plane record with per-step observed evidence
//  and an honest verdict.
//
//  LAWS:
//    · loopback only — an http step refuses any non-loopback host;
//    · no fake success — the verdict is the conjunction of step outcomes,
//      a failed step can never be overridden by a summary;
//    · cancellation settles honestly (cancelled, never failed-as-success);
//    · cleanup is part of the record — services the journey started are
//      stopped (unless keep) and the outcome is recorded;
//    · steps emit refs + bounded detail, never unbounded dumps.
//
//  Gate: MERCURY_JOURNEYS (default-on, registered).
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { ReadinessCondition } from '../projectServices/contracts.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The journeys gate (MERCURY_JOURNEYS, default-on; re-read live). */
export function journeysEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_JOURNEYS'))
}

export type JourneyStep =
  | {
      kind: 'service.start'
      /** Service name (project-scoped; the journey records it for cleanup). */
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
      /** LOOPBACK ONLY (127.0.0.1 · localhost · ::1) — anything else refuses. */
      url: string
      method?: string
      body?: string
      headers?: Record<string, string>
      expect?: {
        status?: number
        bodyIncludes?: string
        headerIncludes?: Record<string, string>
        /** dotted path into a JSON body, asserted below. */
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
      /** A service started by this journey (or already running here). */
      service: string
      pattern: string
      label?: string
      timeoutMs?: number
    }
  | {
      kind: 'diagnostic.check'
      /** Parse-level diagnostics via the structural facility (semantic
       *  diagnostics stay with the LSP owner — recorded honestly). */
      files: string[]
      label?: string
      timeoutMs?: number
    }
  | {
      kind: 'value.assert'
      /** Assert into the LAST http.request's JSON body. */
      jsonPath: string
      equals: string
      label?: string
      timeoutMs?: number
    }
  | { kind: 'service.stop'; name: string; label?: string; timeoutMs?: number }

export interface JourneySpec {
  objective: string
  steps: JourneyStep[]
  /** 'stop-started' (default): stop services this journey started, always.
   *  'keep': leave them running (the record says so). */
  cleanup?: 'stop-started' | 'keep'
}

export type JourneyStepState = 'passed' | 'failed' | 'skipped' | 'cancelled'

export interface JourneyStepResult {
  index: number
  kind: JourneyStep['kind']
  label: string
  state: JourneyStepState
  /** Bounded, human-readable observation (never a dump). */
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
  /** Services this journey started, with their cleanup outcomes. */
  cleanup: { service: string; action: 'stopped' | 'kept' | 'stop-failed'; detail?: string }[]
  /** The execution-plane record backing this journey. */
  executionRef: string
  evidenceRefs: string[]
  /** The failed step index, when the verdict is failed. */
  failedStep?: number
}
