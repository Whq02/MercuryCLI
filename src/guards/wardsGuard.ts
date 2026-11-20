
import { resolveProjectConfigPath } from '../utils/projectConfig.js'
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { enqueueNotification } from '../context/notifications.js'
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'
import { untrustedWorkspaceHeadless } from '../utils/config/trust.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage, getErrnoCode } from '../utils/errors.js'
import type { SetAppState } from '../utils/messageQueueManager.js'
import { createSystemMessage } from '../utils/messages/systemMessages.js'
import { expandPath } from '../utils/path.js'
import {
  AUTONOMOUS_WARDS,
  BUILTIN_WARDS,
  REFUSAL_WARDS,
  buildUntrustedFolderDenial,
  buildWardDenial,
  countWardWork,
  evaluateWards,
  parseProjectWardsWithReport,
  setHomeSpellings,
  type PendingToolCall,
  type ResolvedPath,
  type WardRule,
  type WardWork,
} from '../utils/wards/wards.js'
import { refusalOfShellCommand } from '../utils/wards/wardsRefusals.js'
import { engageToolGuard } from './guards.js'

export const WARDS_HOOK_ID = 'wards-content-rules'

const TARGET_HEAD_BYTES = 2048

const NO_FILE_THERE_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EISDIR'])

class TargetHeadUnread extends Error {
  constructor(readonly path: string, readonly why: string) {
    super(`${path} could not be read (${why})`)
  }
}

export function readTargetHead(path: string, work?: WardWork, bytes = TARGET_HEAD_BYTES): string | undefined {
  let fd: number
  try {
    if (work) countWardWork(work, 'nonblockingOpens')
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== undefined && NO_FILE_THERE_CODES.has(code)) return undefined
    throw new TargetHeadUnread(path, errorMessage(error))
  }
  const buffer = Buffer.alloc(bytes)
  let read = 0
  try {
    if (!fstatSync(fd).isFile()) return undefined
    if (work) countWardWork(work, 'headReads')
    read = readSync(fd, buffer, 0, bytes, 0)
  } catch (error) {
    throw new TargetHeadUnread(path, errorMessage(error))
  } finally {
    closeSync(fd)
  }
  const head = buffer.subarray(0, read)
  return head.includes(0) ? undefined : head.toString('utf8')
}

export const TARGET_PATH_MAX = 4096

function deepestExisting(path: string, work?: WardWork): { real: string; tail: string[] } {
  if (work) countWardWork(work, 'characters', path.length)
  const segments = path.split(sep).filter(Boolean)
  const realAt = (depth: number): string | null => {
    const candidate = depth === 0 ? sep : sep + segments.slice(0, depth).join(sep)
    try {
      if (work) {
        countWardWork(work, 'characters', candidate.length)
        countWardWork(work, 'realpathCalls')
      }
      return realpathSync(candidate)
    } catch (error) {
      const code = getErrnoCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') logForDebugging(`wards: ${candidate} could not be resolved (${code ?? errorMessage(error)}), so it is judged as a path not made yet`)
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

let homeSpellingsCache: { home: string; spellings: string[] } | undefined
let homeUnknownLogged = false

export function homeSpellings(): string[] {
  let home: string
  try {
    home = expandPath('~')
  } catch (error) {
    if (!homeUnknownLogged) {
      homeUnknownLogged = true
      logForDebugging(`wards: the home folder could not be told (${errorMessage(error)}), so no ward matches a path by its home spelling`)
    }
    return []
  }
  if (homeSpellingsCache?.home === home) return homeSpellingsCache.spellings
  const real = realTargetPath(home)
  const spellings = real === home ? [home] : [home, real]
  homeSpellingsCache = { home, spellings }
  return spellings
}

setHomeSpellings(homeSpellings)

export function makeTargetResolver(fallbackRoot: string, work?: WardWork): (path: string) => ResolvedPath {
  const fallback = realTargetPath(fallbackRoot)
  return (path: string): ResolvedPath => {
    let expanded: string
    try {
      if (work) countWardWork(work, 'characters', path.length)
      expanded = expandPath(path)
    } catch {
      return { path, root: undefined }
    }
    if (expanded.length > TARGET_PATH_MAX) return { path: expanded, root: fallback }
    const { real, tail } = deepestExisting(expanded, work)
    const resolved = tail.length === 0 ? real : join(real, ...tail)
    if (work && tail.length > 0) countWardWork(work, 'characters', resolved.length)
    let dir = tail.length === 0 ? dirname(real) : real
    for (;;) {
      if (work) countWardWork(work, 'existsCalls')
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
    flagEnabled('MERCURY_DELETE_WARD')
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

const ROAD_THAT_OUTLIVES_THE_RUN = '; a process that must stay up after that (a server something checks once the run has ended) is a Service with lifecycle project.'

function withTheRoadOffered<Refusal extends { rule: WardRule }>(refusal: Refusal, offeredTools: readonly string[] | undefined): Refusal {
  if (refusal.rule.name !== 'self-daemonize' || !refusal.rule.teach.endsWith('.') || offeredTools?.includes('Service') !== true) return refusal
  return { ...refusal, rule: { ...refusal.rule, teach: `${refusal.rule.teach.slice(0, -1)}${ROAD_THAT_OUTLIVES_THE_RUN}` } }
}

type WardFiring = { ward: string; tool: string; call_id: string; effect: 'refused' | 'warned' }

const WARD_FIRINGS_KEPT = 256
const wardFirings = new Map<string, WardFiring[]>()

function noteWardFiring(sessionId: string, firing: WardFiring): void {
  const kept = wardFirings.get(sessionId) ?? []
  if (kept.length >= WARD_FIRINGS_KEPT) kept.shift()
  kept.push(firing)
  wardFirings.set(sessionId, kept)
}

export function wardFiringsOf(sessionId: string): WardFiring[] {
  return [...(wardFirings.get(sessionId) ?? [])]
}

export function forgetWardFirings(sessionId: string): void {
  wardFirings.delete(sessionId)
}

const wardsEngagedSessions = new Set<string>()

export function resetWardsEngagedSessionsForTest(): void {
  wardsEngagedSessions.clear()
}

export function registerWardsGuard(
  setAppState: SetAppState,
  sessionId: string,
  work?: WardWork,
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
  const spawned = deleteWardActive()
  const rulesFor = (unattended: boolean): WardRule[] => [
    ...BUILTIN_WARDS,
    ...(spawned ? AUTONOMOUS_WARDS.filter(rule => unattended || rule.unattendedOnly !== true) : []),
    ...projectReport.rules,
  ]
  const attendedRules = rulesFor(false)
  const unattendedRules = rulesFor(true)
  const resolveTarget = makeTargetResolver(getCwd(), work)
  const startingFolder = realTargetPath(getCwd())
  let unjudgedSaid = false
  engageToolGuard(sessionId, {
    id: WARDS_HOOK_ID,
    timeoutMs: 5000,
    judge: async call => {
      const level = wardsLevel()
      if (level === 'off') return { allow: true }
      try {
        const pending: PendingToolCall = { toolName: call.tool, input: call.input }
        pending.shellCommand = call.toolRef?.shellCommandOf?.(pending.input)
        pending.readHead = work === undefined ? readTargetHead : path => readTargetHead(path, work)
        pending.resolvePath = resolveTarget
        pending.startingFolder = startingFolder
        pending.isMercurySource = path => {
          const { path: resolved, root } = resolveTarget(path)
          if (root === undefined || !resolved.startsWith(`${join(root, 'src')}${sep}`) || !existsSync(join(root, 'src', 'components', 'mercuryPalette.ts'))) return false
          try {
            return JSON.parse(readTargetHead(join(root, 'package.json'), work, 65_536) ?? 'null')?.name === 'mercury'
          } catch (error) {
            logForDebugging(`wards: ${join(root, 'package.json')} could not be read as a manifest (${error instanceof SyntaxError ? 'its first 64 KB are not valid JSON' : errorMessage(error)}), so ${resolved} is not judged as Mercury source`)
            return false
          }
        }
        const refusal = pending.shellCommand === undefined ? evaluateWards(REFUSAL_WARDS, pending, work) : await refusalOfShellCommand(pending, getCwd(), work)
        if (!refusal.allow && level !== 'warn') {
          noteWardFiring(sessionId, { ward: refusal.rule.name, tool: pending.toolName, call_id: call.callId, effect: 'refused' })
          return { allow: false, reason: buildWardDenial(withTheRoadOffered(refusal, call.offeredTools), pending.toolName) }
        }
        const verdict = evaluateWards(call.asksAnswerable === true ? attendedRules : unattendedRules, pending, work)
        if (!verdict.allow) {
          const nameWithheld = projectReport.rules.includes(verdict.rule) && untrustedWorkspaceHeadless()
          noteWardFiring(sessionId, { ward: nameWithheld ? 'project-rule' : verdict.rule.name, tool: pending.toolName, call_id: call.callId, effect: 'refused' })
          return { allow: false, reason: nameWithheld ? buildUntrustedFolderDenial(pending.toolName) : buildWardDenial(verdict, pending.toolName) }
        }
        if (refusal.allow) return { allow: true }
        logForDebugging(`wards: warn — ${buildWardDenial(refusal, pending.toolName)}`)
        noteWardFiring(sessionId, { ward: refusal.rule.name, tool: pending.toolName, call_id: call.callId, effect: 'warned' })
        return {
          allow: true,
          note: createSystemMessage(
            `Ward '${refusal.rule.name}' would have blocked this ${pending.toolName} call — matched "${refusal.excerpt}" (${refusal.target}:${refusal.line}); MERCURY_WARDS=warn let it run.`,
            'warning',
            call.callId,
          ),
        }
      } catch (error) {
        if (error instanceof TargetHeadUnread) return { allow: false, reason: `The ${call.tool} call was not made: the wards could not read ${error.path} to check its content rules (${error.why}) — retry it, and if it fails again, make the file readable to you first.` }
        logForDebugging(`wards: the ${call.tool} call could not be judged (${errorMessage(error)}), so it goes on unchecked`, { level: 'error' })
        if (unjudgedSaid) return { allow: true }
        unjudgedSaid = true
        return { allow: true, note: createSystemMessage(`The wards could not check this ${call.tool} call (${errorMessage(error)}), so this call and any later one they cannot check run without them.`, 'warning', call.callId) }
      }
    },
  })
  wardsEngagedSessions.add(sessionId)
  return WARDS_HOOK_ID
}
