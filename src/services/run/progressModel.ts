
import { createHash } from 'node:crypto'
import * as path from 'node:path'

export type EvidenceClass =
  | 'artifact-delta'
  | 'execution'
  | 'observation'
  | 'delegation'
  | 'verification'
  | 'interaction'

export interface AttemptFingerprint {
  toolFamily: string
  normalizedTarget: string
  purpose: string
  expectedEvidenceClass: EvidenceClass
  inputDigest: string
}

const MUTATING_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ChangeSet'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const OBSERVE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'ProviderSearch'])
const DELEGATE_TOOLS = new Set(['Task', 'Agent', 'Workflow', 'LaunchFleet'])
const VERIFY_HEADS = new Set(['test', 'pytest', 'jest', 'vitest', 'typecheck', 'tsc', 'verify'])

export function toolFamilyOf(toolName: string): { family: string; evidence: EvidenceClass } {
  if (MUTATING_FILE_TOOLS.has(toolName)) return { family: 'mutate:file', evidence: 'artifact-delta' }
  if (SHELL_TOOLS.has(toolName)) return { family: 'execute:shell', evidence: 'execution' }
  if (OBSERVE_TOOLS.has(toolName)) return { family: 'observe', evidence: 'observation' }
  if (DELEGATE_TOOLS.has(toolName)) return { family: 'delegate', evidence: 'delegation' }
  if (toolName === 'AskUserQuestion') return { family: 'interact', evidence: 'interaction' }
  return { family: `tool:${toolName.toLowerCase()}`, evidence: 'observation' }
}

function normalizeTargetPath(p: string, cwd: string): string {
  const posix = p.replaceAll('\\', '/')
  const posixCwd = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  const abs = posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)
  if (abs && posixCwd && posix.toLowerCase().startsWith(posixCwd.toLowerCase() + '/')) {
    return posix.slice(posixCwd.length + 1)
  }
  return path.posix.normalize(posix)
}

export function commandHead(command: string): string {
  const stripped = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '')
  const first = stripped.split(/\s+/)[0] ?? ''
  const unquoted = first.replace(/^["']|["']$/g, '')
  const base = unquoted.split(/[\\/]/).pop() ?? unquoted
  return base.toLowerCase()
}

function canonicalShellText(command: string): string {
  return command
    .replace(/(^|\s)#[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

export function makeAttemptFingerprint(args: {
  toolName: string
  input: unknown
  cwd: string
  purpose?: string
}): AttemptFingerprint {
  const { family, evidence } = toolFamilyOf(args.toolName)
  const input = (args.input ?? {}) as Record<string, unknown>
  const rawPath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : typeof input.path === 'string'
          ? input.path
          : undefined

  let normalizedTarget = ''
  let inputDigest = ''
  let evidenceClass = evidence

  if (family === 'execute:shell') {
    const command = typeof input.command === 'string' ? input.command : ''
    normalizedTarget = commandHead(command)
    inputDigest = digest(['shell', canonicalShellText(command)])
    if (VERIFY_HEADS.has(normalizedTarget)) evidenceClass = 'verification'
  } else if (family === 'mutate:file') {
    normalizedTarget = rawPath ? normalizeTargetPath(rawPath, args.cwd) : ''
    const bytes =
      typeof input.content === 'string'
        ? input.content
        : typeof input.new_string === 'string'
          ? `${String(input.old_string ?? '')}\u0001${input.new_string}`
          : stableSalientJson(input)
    inputDigest = digest(['mutate', normalizedTarget, bytes])
  } else if (family === 'observe') {
    const query =
      typeof input.pattern === 'string'
        ? input.pattern
        : typeof input.url === 'string'
          ? input.url
          : typeof input.query === 'string'
            ? input.query
            : ''
    normalizedTarget = rawPath ? normalizeTargetPath(rawPath, args.cwd) : query
    inputDigest = digest(['observe', normalizedTarget, query, String(input.offset ?? ''), String(input.limit ?? '')])
  } else {
    normalizedTarget = rawPath ? normalizeTargetPath(rawPath, args.cwd) : ''
    inputDigest = digest([family, normalizedTarget, stableSalientJson(input)])
  }

  return {
    toolFamily: family,
    normalizedTarget,
    purpose: args.purpose ?? '',
    expectedEvidenceClass: evidenceClass,
    inputDigest,
  }
}

const VOLATILE_KEYS = new Set(['description', 'label', 'title', 'activeForm'])

function stableSalientJson(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
    .filter(k => !VOLATILE_KEYS.has(k))
    .sort()
  return JSON.stringify(keys.map(k => [k, input[k]]))
}

export function fingerprintKey(fp: AttemptFingerprint): string {
  return `${fp.toolFamily}\u0000${fp.normalizedTarget}\u0000${fp.inputDigest}`
}

export function actionFingerprint(nextAction: string): string {
  return digest(['action', nextAction.toLowerCase().replace(/\s+/g, ' ').trim()])
}


export type ProgressPhase =
  | 'productive'
  | 'stagnant'
  | 'replan-required'
  | 'handoff-required'
  | 'terminal'

export interface AttemptLedgerRow {
  key: string
  family: string
  target: string
  count: number
  barrenRepeats: number
  lastAt: number
}

export interface RunProgressState {
  phase: ProgressPhase
  progressSinceDecision: number
  totalProgress: number
  attemptsSinceProgress: number
  repeatAttemptsSinceProgress: number
  replansUsed: number
  attempts: AttemptLedgerRow[]
  totalAttempts: number
  lastEligibleProgress: { kind: string; detail: string; at: number } | null
}

export const MAX_ATTEMPT_LEDGER = 64

export const STAGNANT_AFTER_BARREN_ATTEMPTS = 4
export const REPLAN_AFTER_BARREN_REPEATS = 1
export const HANDOFF_AFTER_REPLANS = 1

export function emptyProgressState(): RunProgressState {
  return {
    phase: 'productive',
    progressSinceDecision: 0,
    totalProgress: 0,
    attemptsSinceProgress: 0,
    repeatAttemptsSinceProgress: 0,
    replansUsed: 0,
    attempts: [],
    totalAttempts: 0,
    lastEligibleProgress: null,
  }
}

export function deriveProgressPhase(
  s: Omit<RunProgressState, 'phase'>,
  terminalLifecycle: boolean,
): ProgressPhase {
  if (terminalLifecycle) return 'terminal'
  if (s.repeatAttemptsSinceProgress >= REPLAN_AFTER_BARREN_REPEATS) {
    return s.replansUsed >= HANDOFF_AFTER_REPLANS ? 'handoff-required' : 'replan-required'
  }
  if (s.attemptsSinceProgress >= STAGNANT_AFTER_BARREN_ATTEMPTS) return 'stagnant'
  return 'productive'
}


function rephase(s: Omit<RunProgressState, 'phase'>, terminal: boolean): RunProgressState {
  return { ...s, phase: deriveProgressPhase(s, terminal) }
}

export function foldAttempt(
  prev: RunProgressState,
  fp: AttemptFingerprint,
  at: number,
  terminalLifecycle: boolean,
): RunProgressState {
  const key = fingerprintKey(fp)
  const existing = prev.attempts.find(r => r.key === key)
  const isBarrenRepeat = existing !== undefined && existingSeenSinceProgress(existing, prev)
  const row: AttemptLedgerRow = existing
    ? {
        ...existing,
        count: existing.count + 1,
        barrenRepeats: isBarrenRepeat ? existing.barrenRepeats + 1 : existing.barrenRepeats,
        lastAt: at,
      }
    : {
        key,
        family: fp.toolFamily,
        target: fp.normalizedTarget,
        count: 1,
        barrenRepeats: 0,
        lastAt: at,
      }
  const others = prev.attempts.filter(r => r.key !== key)
  const attempts = [...others, row]
    .sort((a, b) => a.lastAt - b.lastAt)
    .slice(-MAX_ATTEMPT_LEDGER)
  return rephase(
    {
      ...prev,
      attempts,
      totalAttempts: prev.totalAttempts + 1,
      attemptsSinceProgress: prev.attemptsSinceProgress + 1,
      repeatAttemptsSinceProgress: isBarrenRepeat
        ? prev.repeatAttemptsSinceProgress + 1
        : prev.repeatAttemptsSinceProgress,
    },
    terminalLifecycle,
  )
}

function existingSeenSinceProgress(row: AttemptLedgerRow, s: RunProgressState): boolean {
  return s.lastEligibleProgress === null || row.lastAt >= s.lastEligibleProgress.at
}

export function foldEligibleProgress(
  prev: RunProgressState,
  kind: 'artifact-delta' | 'verification' | 'task-state' | 'prerequisite-change',
  detail: string,
  at: number,
  terminalLifecycle: boolean,
): RunProgressState {
  return rephase(
    {
      ...prev,
      progressSinceDecision: prev.progressSinceDecision + 1,
      totalProgress: prev.totalProgress + 1,
      attemptsSinceProgress: 0,
      repeatAttemptsSinceProgress: 0,
      lastEligibleProgress: { kind, detail, at },
    },
    terminalLifecycle,
  )
}

export function foldStopDecision(
  prev: RunProgressState,
  decision: string,
  terminalLifecycle: boolean,
): RunProgressState {
  return rephase(
    {
      ...prev,
      progressSinceDecision: 0,
      replansUsed: /replan/i.test(decision) ? prev.replansUsed + 1 : prev.replansUsed,
    },
    terminalLifecycle,
  )
}

export function foldTerminalProgress(prev: RunProgressState): RunProgressState {
  return { ...prev, phase: 'terminal' }
}
