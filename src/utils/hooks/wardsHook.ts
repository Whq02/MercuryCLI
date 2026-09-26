
import { resolveProjectConfigPath } from '../projectConfig.js'
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { enqueueNotification } from '../../context/notifications.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import type { SetAppState } from '../messageQueueManager.js'
import { createSystemMessage } from '../messages/systemMessages.js'
import { expandPath } from '../path.js'
import {
  AUTONOMOUS_WARDS,
  BUILTIN_WARDS,
  REFUSAL_WARDS,
  WARDS_TOOL_MATCHER,
  buildWardDenial,
  evaluateWards,
  parseProjectWardsWithReport,
  type PendingToolCall,
  type ResolvedPath,
  type WardRule,
} from '../wards/wards.js'
import { addFunctionHook } from './sessionHooks.js'

export const WARDS_HOOK_ID = 'wards-content-rules'

const WARD_DENIAL_CAP = 25

const TARGET_HEAD_BYTES = 2048

export function readTargetHead(path: string): string | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  const buffer = Buffer.alloc(TARGET_HEAD_BYTES)
  let read = 0
  try {
    if (!fstatSync(fd).isFile()) return undefined
    read = readSync(fd, buffer, 0, TARGET_HEAD_BYTES, 0)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
  const head = buffer.subarray(0, read)
  return head.includes(0) ? undefined : head.toString('utf8')
}

export const TARGET_PATH_MAX = 4096

function deepestExisting(path: string): { real: string; tail: string[] } {
  const segments = path.split(sep).filter(Boolean)
  const realAt = (depth: number): string | null => {
    try {
      return realpathSync(depth === 0 ? sep : sep + segments.slice(0, depth).join(sep))
    } catch {
      return null
    }
  }
  let missing = segments.length
  const whole = realAt(missing)
  if (whole !== null) return { real: whole, tail: [] }
  let found = 0
  let real: string | null = null
  for (let step = 1; missing - step > 0; step *= 2) {
    const probe = missing - step
    const seen = realAt(probe)
    if (seen !== null) {
      found = probe
      real = seen
      break
    }
    missing = probe
  }
  while (missing - found > 1) {
    const mid = (found + missing) >> 1
    const seen = realAt(mid)
    if (seen === null) missing = mid
    else {
      found = mid
      real = seen
    }
  }
  return { real: real ?? realAt(0) ?? sep, tail: segments.slice(found) }
}

export function realTargetPath(path: string): string {
  if (!isAbsolute(path) || path.length > TARGET_PATH_MAX) return path
  const { real, tail } = deepestExisting(path)
  return tail.length === 0 ? real : join(real, ...tail)
}

export function repositoryRootOf(path: string): string | undefined {
  if (!isAbsolute(path) || path.length > TARGET_PATH_MAX) return undefined
  let dir = deepestExisting(path).real
  if (dir === realTargetPath(path)) dir = dirname(dir)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function makeTargetResolver(fallbackRoot: string): (path: string) => ResolvedPath {
  const fallback = realTargetPath(fallbackRoot)
  return (path: string): ResolvedPath => {
    let expanded: string
    try {
      expanded = expandPath(path)
    } catch {
      return { path, root: undefined }
    }
    if (expanded.length > TARGET_PATH_MAX) return { path: expanded, root: fallback }
    const { real, tail } = deepestExisting(expanded)
    const resolved = tail.length === 0 ? real : join(real, ...tail)
    let dir = tail.length === 0 ? dirname(real) : real
    for (;;) {
      if (existsSync(join(dir, '.git'))) return { path: resolved, root: dir }
      const parent = dirname(dir)
      if (parent === dir) return { path: resolved, root: fallback }
      dir = parent
    }
  }
}

export type WardsLevel = 'off' | 'warn' | 'enforce'

export function wardsLevel(): WardsLevel {
  if (!flagEnabled('MERCURY_WARDS')) return 'off'
  const raw = flagEnv('MERCURY_WARDS')
  const folded = typeof raw === 'string' ? raw.replace(/^["']+|["']+$/g, '').trim().toLowerCase() : ''
  return folded === 'warn' ? 'warn' : 'enforce'
}

export function wardsEnabled(): boolean {
  return wardsLevel() !== 'off'
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
  const resolveTarget = makeTargetResolver(getCwd())
  let denials = 0
  addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    WARDS_TOOL_MATCHER,
    (_messages, _signal, context) => {
      const level = wardsLevel()
      if (level === 'off') return true
      try {
        const hookInput = context?.hookInput as
          | { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown }
          | undefined
        if (!hookInput || typeof hookInput.tool_name !== 'string') return true
        const pending: PendingToolCall = {
          toolName: hookInput.tool_name,
          input:
            hookInput.tool_input && typeof hookInput.tool_input === 'object'
              ? (hookInput.tool_input as Record<string, unknown>)
              : {},
        }
        pending.shellCommand = context?.tool?.shellCommandOf?.(pending.input)
        pending.readHead = readTargetHead
        pending.resolvePath = resolveTarget
        const refusal = evaluateWards(REFUSAL_WARDS, pending)
        if (!refusal.allow && level !== 'warn') return buildWardDenial(refusal, pending.toolName)
        if (denials < WARD_DENIAL_CAP) {
          const verdict = evaluateWards(rules, pending)
          if (!verdict.allow) {
            const denial = buildWardDenial(verdict, pending.toolName)
            denials++
            if (denials === WARD_DENIAL_CAP) {
              logForDebugging(
                `wards: denial cap (${WARD_DENIAL_CAP}) reached for session ${sessionId} — standing down`,
              )
            }
            return denial
          }
        }
        if (refusal.allow) return true
        logForDebugging(`wards: warn — ${buildWardDenial(refusal, pending.toolName)}`)
        return {
          pass: true,
          note: createSystemMessage(
            `Ward '${refusal.rule.name}' would have blocked this ${pending.toolName} call — matched "${refusal.excerpt}" (${refusal.target}:${refusal.line}); MERCURY_WARDS=warn let it run.`,
            'warning',
            typeof hookInput.tool_use_id === 'string' ? hookInput.tool_use_id : undefined,
          ),
        }
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
