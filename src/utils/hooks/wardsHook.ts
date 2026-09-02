
import { resolveProjectConfigPath } from '../projectConfig.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enqueueNotification } from '../../context/notifications.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import type { SetAppState } from '../messageQueueManager.js'
import {
  AUTONOMOUS_WARDS,
  BUILTIN_WARDS,
  WARDS_TOOL_MATCHER,
  buildWardDenial,
  evaluateWards,
  parseProjectWardsWithReport,
  type PendingToolCall,
  type WardRule,
} from '../wards/wards.js'
import { addFunctionHook } from './sessionHooks.js'

export const WARDS_HOOK_ID = 'wards-content-rules'

const WARD_DENIAL_CAP = 25

export function wardsEnabled(): boolean {
  return flagEnabled('MERCURY_WARDS')
}

export function deleteWardActive(): boolean {
  return (
    flagEnv('MERCURY_SPAWNED_BY') !== undefined &&
    flagEnv('MERCURY_DELETE_WARD') !== '0'
  )
}

export function loadProjectWardsWithReport(cwd: string): {
  rules: WardRule[]
  problems: string[]
  loss?: string
  path?: string
} {
  let wardsPath: string | undefined
  try {
    wardsPath = resolveProjectConfigPath(cwd, 'wards.json') ?? undefined
    if (!wardsPath) return { rules: [], problems: [] }
    const text = readFileSync(wardsPath, 'utf-8')
    return { ...parseProjectWardsWithReport(text), path: wardsPath }
  } catch (error) {
    const why = error instanceof Error ? error.message.slice(0, 80) : String(error)
    return {
      rules: [],
      problems: [`wards.json exists but cannot be read (${why}) — every project ward is inactive`],
      loss: `unreadable (${why}) — its safety rules are OFF`,
      ...(wardsPath !== undefined ? { path: wardsPath } : {}),
    }
  }
}

export function loadProjectWards(cwd: string): WardRule[] {
  return loadProjectWardsWithReport(cwd).rules
}

const wardsEngagedSessions = new Set<string>()

export function resetWardsEngagedSessionsForTest(): void {
  wardsEngagedSessions.clear()
}

export function registerWardsHook(
  setAppState: SetAppState,
  sessionId: string,
): string | null {
  if (!wardsEnabled()) return null
  if (wardsEngagedSessions.has(sessionId)) return WARDS_HOOK_ID
  const projectReport = loadProjectWardsWithReport(getCwd())
  for (const problem of projectReport.problems) {
    logForDebugging(`wards: ${problem}`)
  }
  if (projectReport.loss !== undefined) {
    enqueueNotification(setAppState, {
      key: 'wards-file',
      text: `project wards file ${projectReport.path ?? 'wards.json'}: ${projectReport.loss} this session`,
      priority: 'high',
      color: 'warning',
      timeoutMs: 30_000,
    })
  }
  const rules: WardRule[] = [
    ...BUILTIN_WARDS,
    ...(deleteWardActive() ? AUTONOMOUS_WARDS : []),
    ...projectReport.rules,
  ]
  let denials = 0
  addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    WARDS_TOOL_MATCHER,
    (_messages, _signal, context) => {
      if (!wardsEnabled()) return true
      if (denials >= WARD_DENIAL_CAP) return true
      try {
        const hookInput = context?.hookInput as
          | { tool_name?: unknown; tool_input?: unknown }
          | undefined
        if (!hookInput || typeof hookInput.tool_name !== 'string') return true
        const pending: PendingToolCall = {
          toolName: hookInput.tool_name,
          input:
            hookInput.tool_input && typeof hookInput.tool_input === 'object'
              ? (hookInput.tool_input as Record<string, unknown>)
              : {},
        }
        const verdict = evaluateWards(rules, pending)
        if (verdict.allow) return true
        denials++
        if (denials === WARD_DENIAL_CAP) {
          logForDebugging(
            `wards: denial cap (${WARD_DENIAL_CAP}) reached for session ${sessionId} — standing down`,
          )
        }
        return buildWardDenial(verdict, pending.toolName)
      } catch {
        return true
      }
    },
    `Ward blocked this tool call: it violates a mechanical content rule ` +
      `(see .mercury/wards.json + the builtin Mercury hard rules). Rewrite the ` +
      `call to comply.`,
    { timeout: 5000, id: WARDS_HOOK_ID },
  )
  wardsEngagedSessions.add(sessionId)
  return WARDS_HOOK_ID
}
