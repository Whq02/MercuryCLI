export type ProcessSweepClass = 'running' | 'stale' | 'cannot-end' | 'not-ours'
export type ProcessSweepRead = boolean | null
export type ProcessSweepKind = 'window' | 'daemon' | 'runner' | 'command' | 'unknown'

export interface ProcessSweepRow {
  pid: number
  ppid: number
  exe: string
  args: string[]
  startedAtMs: number
  user: string
  terminal: string | null
}

export interface ProcessSweepObservation {
  process: ProcessSweepRow
  startToken: string | null
  state: string
  terminalAlive: ProcessSweepRead
}

export interface ProcessSweepTable {
  observations: ProcessSweepObservation[]
  complete: boolean
  error?: string
}

export interface ProcessSweepFacts {
  process: ProcessSweepRow
  platform: NodeJS.Platform
  kind: ProcessSweepKind
  startToken: string | null
  registrationId: string | null
  ownership: ProcessSweepRead
  sameUser: ProcessSweepRead
  sameHome: ProcessSweepRead
  self: ProcessSweepRead
  state: string
  liveness: {
    terminal: ProcessSweepRead
    registration: ProcessSweepRead
    owner: ProcessSweepRead
    session: ProcessSweepRead
    work: ProcessSweepRead
    schedules: ProcessSweepRead
    persistence: ProcessSweepRead
  }
  closed: 'terminal-gone' | 'session-ended' | 'owner-gone' | null
  graceElapsed: ProcessSweepRead
}

export interface ProcessSweepEntry {
  process: ProcessSweepRow
  platform: NodeJS.Platform
  kind: ProcessSweepKind
  startToken: string | null
  registrationId: string | null
  classification: ProcessSweepClass
  reason: string
  state: string
}

function hasSweepBirthIdentity(value: Pick<ProcessSweepEntry, 'process' | 'startToken'>): boolean {
  return typeof value.startToken === 'string' && value.startToken.trim() !== '' &&
    Number.isSafeInteger(value.process.pid) && value.process.pid > 1 &&
    Number.isFinite(value.process.startedAtMs) && value.process.startedAtMs > 0 &&
    typeof value.process.exe === 'string' && value.process.exe.trim() !== '' &&
    typeof value.process.user === 'string' && value.process.user.trim() !== ''
}

export function classifyMercuryProcess(facts: ProcessSweepFacts): ProcessSweepEntry {
  const entry = (classification: ProcessSweepClass, reason: string): ProcessSweepEntry => ({
    process: facts.process,
    platform: facts.platform,
    kind: facts.kind,
    startToken: facts.startToken,
    registrationId: facts.registrationId,
    classification,
    reason,
    state: facts.state,
  })
  if (facts.sameUser === false) return entry('not-ours', 'another user owns this process')
  if (facts.ownership === false) return entry('not-ours', 'not a Mercury executable and bundle')
  if (facts.self === true) return entry('running', 'this Mercury is reading the processes')
  const required = ['terminal', 'registration', 'owner', 'session', 'work', 'schedules', 'persistence'] as const
  const readings = required.map(name => {
    try {
      return { name, value: facts.liveness[name] }
    } catch {
      return { name, value: null }
    }
  })
  const live = readings.filter(read => read.value === true).map(read => read.name)
  if (live.length > 0) return entry('running', `in use: ${live.join(', ')}`)
  if (facts.ownership === true && facts.sameHome === false) return entry('running', 'another config home; left alone')
  if (facts.self !== false) return entry('cannot-end', 'cannot establish whether this is the reading process')
  if (facts.sameUser !== true) return entry('cannot-end', 'cannot establish which user owns this process')
  if (facts.ownership !== true) return entry('cannot-end', 'cannot establish Mercury executable and bundle identity')
  if (facts.sameHome !== true) return entry('cannot-end', 'cannot establish this process\'s config home')
  if (!hasSweepBirthIdentity(facts)) {
    return entry('cannot-end', 'cannot establish this process\'s birth identity')
  }
  const unknown = readings.filter(read => read.value !== false).map(read => read.name)
  if (unknown.length > 0) return entry('cannot-end', `liveness could not be read: ${unknown.join(', ')}`)
  if (facts.kind === 'window' && (typeof facts.registrationId !== 'string' || facts.registrationId.trim() === '')) return entry('cannot-end', 'no cockpit registration proves this window is unused')
  const expected = facts.kind === 'window' ? 'terminal-gone' : facts.kind === 'runner' ? 'session-ended' : facts.kind === 'daemon' ? 'owner-gone' : null
  if (expected === null || facts.closed !== expected) return entry('cannot-end', 'no Mercury closure record proves this process is unused')
  if (facts.graceElapsed === false) return entry('running', 'waiting for the recorded closure allowance')
  if (facts.graceElapsed !== true) return entry('cannot-end', 'the closure allowance could not be read')
  const reason = facts.closed === 'terminal-gone'
    ? 'the registered window\'s terminal is gone and its heartbeat expired'
    : facts.closed === 'session-ended'
      ? 'the recorded session ended and no live seat or work holds its runner'
      : 'the recorded owner is gone, the drain allowance elapsed and nobody uses the daemon'
  return entry('stale', reason)
}

export function sameSweepIdentity(left: ProcessSweepEntry, right: ProcessSweepEntry): boolean {
  return hasSweepBirthIdentity(left) && hasSweepBirthIdentity(right) &&
    left.startToken === right.startToken &&
    left.registrationId === right.registrationId &&
    (left.kind !== 'window' || (typeof left.registrationId === 'string' && left.registrationId.trim() !== '')) &&
    left.kind === right.kind && left.platform === right.platform &&
    left.process.pid > 1 && left.process.pid === right.process.pid &&
    left.process.exe !== '' && left.process.exe === right.process.exe &&
    left.process.startedAtMs > 0 && left.process.startedAtMs === right.process.startedAtMs &&
    left.process.user !== '' && left.process.user === right.process.user
}

export function processSweepCounts(entries: readonly ProcessSweepEntry[]): Record<ProcessSweepClass, number> {
  const counts: Record<ProcessSweepClass, number> = { running: 0, stale: 0, 'cannot-end': 0, 'not-ours': 0 }
  for (const entry of entries) counts[entry.classification]++
  return counts
}

export function processSweepLine(entry: ProcessSweepEntry, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - entry.process.startedAtMs) / 1000))
  const age = entry.process.startedAtMs <= 0 ? 'age unknown' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`
  return `pid ${entry.process.pid} · ${entry.process.terminal ?? 'no terminal'} · ${age} · ${entry.reason}`
}
