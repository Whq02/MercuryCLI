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
  const kernelWait = typeof facts.state === 'string' && /^[UD]/.test(facts.state)
  const entry = (classification: ProcessSweepClass, reason: string): ProcessSweepEntry => ({
    process: facts.process,
    platform: facts.platform,
    kind: facts.kind,
    startToken: facts.startToken,
    registrationId: facts.registrationId,
    classification,
    reason: classification === 'cannot-end' && kernelWait ? `${reason} · in an uninterruptible kernel wait now (state ${facts.state[0]})` : reason,
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
    ? 'the registered window\'s heartbeat expired past the allowance and its terminal is gone'
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

export const PROCESS_SWEEP_WORDS = {
  row: 'Mercury processes',
  counts: (counts: Record<ProcessSweepClass, number>): string =>
    `${counts.running} running · ${counts.stale} stale · ${counts['cannot-end']} cannot end · ${counts['not-ours']} not ours`,
  action: 'Review stale processes',
  confirm: (stale: number): string => `End these ${stale} stale processes?`,
  result: (ended: number, survived: number, running: number): string =>
    `Ended ${ended} stale processes; ${survived} could not be ended; ${running} left running`,
  unkillable: 'cannot end — needs a reboot',
} as const

export interface ProcessSweepDaemonRecord {
  pid: number
  startToken: string | null | undefined
  ownerPid: number | null | undefined
  persist: boolean | undefined
  startedAt: number
}

export interface ProcessSweepRunnerRecord {
  pid: number | undefined
  procStart: string | undefined
  endedAt: number | undefined
  stoppedAt: number | undefined
  parkedAt: number | undefined
  attachedBy: string | undefined
  focusedBy: string | undefined
  schedules: number
  activity: 'working' | 'waiting' | 'idle' | undefined
  warm: boolean
}

export interface ProcessSweepDaemonAnswer {
  pid: number
  ownerPid: number | null
  live: number
  liveSessions: number
  persist: boolean | undefined
  runners: ProcessSweepRunnerRecord[] | undefined
}

export interface ProcessSweepRegistration {
  id: string
  pid: number
  startToken: string | null
  configHome: string
  daemonDir: string
  terminal: string | null
  bornAt: number
  heartbeatAt: number
}

export interface ProcessSweepPlane {
  daemonDir: string
  supervisor: ProcessSweepDaemonRecord | null
  supervisorReadable: boolean
  answer: ProcessSweepDaemonAnswer | null
  runners: ProcessSweepRunnerRecord[] | null
}

export interface ProcessSweepRecords {
  nowMs: number
  platform: NodeJS.Platform
  selfPid: number
  user: string
  configHome: string
  drainMs: number
  heartbeatAllowanceMs: number
  planes: ProcessSweepPlane[]
  registrations: ProcessSweepRegistration[] | null
  memory: Record<string, number> | null
}

export interface ProcessSweepEnding {
  entry: ProcessSweepEntry
  outcome: 'ended' | 'survived' | 'refused'
  road: 'daemon' | 'signal' | 'none'
  reason: string
  at: number
}

export interface ProcessSweepCensus {
  readAt: number
  platform: NodeJS.Platform
  complete: boolean
  error?: string
  entries: ProcessSweepEntry[]
  memory: Record<string, number>
  endings: ProcessSweepEnding[]
}

const MERCURY_EXECUTABLES = new Set(['node', 'bun', 'mercury', 'node.exe', 'bun.exe', 'mercury.exe'])

function executableName(exe: string): string {
  const trimmed = exe.trim()
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).toLowerCase()
}

export function processNamesMercury(args: readonly string[]): boolean {
  return args.some(arg => /(^|[\\/])mercury(\.mjs|\.cmd|\.exe)?$/i.test(arg.trim()))
}

export function processSweepIdentityKey(entry: Pick<ProcessSweepEntry, 'kind' | 'process' | 'startToken'>): string {
  return `${entry.kind}:${entry.process.pid}:${entry.startToken ?? ''}`
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export function parseProcessStartToken(token: string): number {
  const parts = token.trim().split(/\s+/)
  const year = parts.find(part => /^\d{4}$/.test(part))
  const time = parts.find(part => /^\d{1,2}:\d{2}:\d{2}$/.test(part))
  const month = parts.findIndex(part => MONTHS.includes(part.toLowerCase()))
  const day = parts.find((part, index) => /^\d{1,2}$/.test(part) && index !== month && part !== year)
  if (year === undefined || time === undefined || month < 0 || day === undefined) return Number.NaN
  const [hours, minutes, seconds] = time.split(':').map(Number)
  const at = new Date(Number(year), MONTHS.indexOf(parts[month]!.toLowerCase()), Number(day), hours, minutes, seconds, 0).getTime()
  return Number.isFinite(at) ? at : Number.NaN
}

export function tokenBinding(recorded: string | null | undefined, observed: string | null | undefined): 'bound' | 'stranger' | 'uncertain' {
  if (typeof recorded !== 'string' || recorded.trim() === '') return 'uncertain'
  if (typeof observed !== 'string' || observed.trim() === '') return 'uncertain'
  if (recorded === observed) return 'bound'
  const left = parseProcessStartToken(recorded)
  const right = parseProcessStartToken(observed)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 'uncertain'
  return left === right ? 'bound' : 'stranger'
}

function pidAlive(pid: number | null | undefined, table: readonly ProcessSweepObservation[]): ProcessSweepRead {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
  const row = table.find(observation => observation.process.pid === pid)
  if (row === undefined) return false
  return !row.state.startsWith('Z')
}

function seatHolderAlive(record: ProcessSweepRunnerRecord, table: readonly ProcessSweepObservation[]): ProcessSweepRead {
  const holders = [record.attachedBy, record.focusedBy].filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  if (holders.length === 0) return false
  let verdict: ProcessSweepRead = false
  for (const holder of holders) {
    const match = /^operator:(\d+)$/.exec(holder.trim())
    if (match === null) return true
    const alive = pidAlive(Number(match[1]), table)
    if (alive === true) return true
    if (alive === null) verdict = null
  }
  return verdict
}

function kindFromArgs(args: readonly string[]): ProcessSweepKind {
  const bundleAt = args.findIndex(arg => /(^|[\\/])mercury\.mjs$/i.test(arg.trim()))
  if (bundleAt < 0) return 'unknown'
  const rest = args.slice(bundleAt + 1)
  if (rest.some(arg => arg === '--print' || arg === '-p' || arg === '--output-format' || arg.startsWith('--output-format='))) return 'runner'
  const word = rest.find(arg => !arg.startsWith('-'))
  if (word === 'daemon') return 'daemon'
  if (word !== undefined) return 'command'
  return 'window'
}

export function composeProcessSweepFacts(table: ProcessSweepTable, records: ProcessSweepRecords): ProcessSweepFacts[] {
  const observations = table.observations
  const facts: ProcessSweepFacts[] = []
  const recordedPids = new Set<number>()
  for (const plane of records.planes) {
    if (plane.supervisor !== null) recordedPids.add(plane.supervisor.pid)
    for (const runner of plane.answer?.runners ?? plane.runners ?? []) if (typeof runner.pid === 'number') recordedPids.add(runner.pid)
  }
  for (const registration of records.registrations ?? []) recordedPids.add(registration.pid)
  const drainElapsed = (sinceMs: number | undefined): ProcessSweepRead => {
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return null
    return records.nowMs - sinceMs >= records.drainMs
  }
  for (const observation of observations) {
    const row = observation.process
    const exeName = executableName(row.exe)
    const mercuryNamed = processNamesMercury(row.args)
    if (!recordedPids.has(row.pid) && !(mercuryNamed && (exeName === '' || MERCURY_EXECUTABLES.has(exeName)))) continue
    const base = {
      process: row,
      platform: records.platform,
      startToken: observation.startToken,
      state: observation.state,
      sameUser: (row.user.trim() === '' || records.user.trim() === '' ? null : row.user === records.user) as ProcessSweepRead,
      self: (row.pid === records.selfPid) as ProcessSweepRead,
    }
    const liveness = (reads: Partial<ProcessSweepFacts['liveness']>): ProcessSweepFacts['liveness'] => ({
      terminal: null, registration: null, owner: null, session: null, work: null, schedules: null, persistence: null, ...reads,
    })
    const terminalRead = (): ProcessSweepRead => (row.terminal === null ? false : observation.terminalAlive)
    const strangerExe = exeName !== '' && !MERCURY_EXECUTABLES.has(exeName)
    let bound = false
    for (const plane of records.planes) {
      const daemon = plane.supervisor
      if (daemon !== null && daemon.pid === row.pid) {
        const binding = tokenBinding(daemon.startToken, observation.startToken)
        if (binding === 'stranger') continue
        bound = true
        const answer = plane.answer !== null && plane.answer.pid === row.pid ? plane.answer : null
        const runners = answer?.runners ?? plane.runners
        const ownerPid = answer !== null ? answer.ownerPid : daemon.ownerPid
        const explicit = ownerPid === null
        const owner: ProcessSweepRead = explicit || ownerPid === undefined ? null : pidAlive(ownerPid, observations)
        const open = runners === null ? null : runners.filter(runner => !runner.warm && runner.endedAt === undefined && runner.stoppedAt === undefined && runner.parkedAt === undefined)
        const session: ProcessSweepRead = answer !== null && answer.liveSessions > 0 ? true : open === null ? null : open.length > 0
        const work: ProcessSweepRead = answer === null ? null : answer.live > 0
        const schedules: ProcessSweepRead = open === null ? null : open.some(runner => runner.schedules > 0)
        const persist = answer?.persist ?? daemon.persist
        const persistence: ProcessSweepRead = explicit ? true : persist === undefined ? null : persist
        const registrations = records.registrations === null ? null : records.registrations.filter(registration => registration.daemonDir === plane.daemonDir && registration.pid !== row.pid)
        let registration: ProcessSweepRead = registrations === null ? null : false
        for (const entry of registrations ?? []) {
          const alive = observations.find(candidate => candidate.process.pid === entry.pid && !candidate.state.startsWith('Z'))
          if (alive === undefined || !(records.nowMs - entry.heartbeatAt <= records.heartbeatAllowanceMs)) continue
          const binding = tokenBinding(entry.startToken, alive.startToken)
          if (binding === 'bound') {
            registration = true
            break
          }
          if (binding === 'uncertain') registration = null
        }
        const closed = owner === false ? 'owner-gone' : null
        const key = processSweepIdentityKey({ kind: 'daemon', process: row, startToken: observation.startToken })
        const firstSeen = records.memory === null ? undefined : records.memory[key]
        facts.push({
          ...base,
          kind: 'daemon',
          registrationId: null,
          ownership: binding === 'bound' ? (strangerExe ? false : true) : null,
          sameHome: binding === 'bound' ? true : null,
          liveness: liveness({ terminal: terminalRead(), registration, owner, session, work, schedules, persistence }),
          closed,
          graceElapsed: closed === null ? null : firstSeen === undefined ? false : drainElapsed(firstSeen),
        })
        break
      }
      const runner = (plane.answer?.runners ?? plane.runners ?? []).find(candidate => candidate.pid === row.pid)
      if (runner !== undefined) {
        const binding = tokenBinding(runner.procStart, observation.startToken)
        if (binding === 'stranger') continue
        bound = true
        const ended = runner.endedAt ?? runner.stoppedAt
        const session: ProcessSweepRead = runner.warm ? false : ended === undefined
        const work: ProcessSweepRead = ended !== undefined || runner.warm ? false : runner.activity === undefined ? null : runner.activity === 'working'
        facts.push({
          ...base,
          kind: 'runner',
          registrationId: null,
          ownership: binding === 'bound' ? (strangerExe ? false : true) : null,
          sameHome: binding === 'bound' ? true : null,
          liveness: liveness({
            terminal: terminalRead(),
            registration: runner.warm ? true : ended === undefined,
            owner: runner.warm ? false : seatHolderAlive(runner, observations),
            session,
            work,
            schedules: runner.schedules > 0,
            persistence: runner.warm,
          }),
          closed: ended === undefined ? null : 'session-ended',
          graceElapsed: ended === undefined ? null : drainElapsed(ended),
        })
        break
      }
    }
    if (bound) continue
    const registration = (records.registrations ?? []).find(candidate => candidate.pid === row.pid && tokenBinding(candidate.startToken, observation.startToken) !== 'stranger')
    if (registration !== undefined) {
      const binding = tokenBinding(registration.startToken, observation.startToken)
      const heartbeatAge = records.nowMs - registration.heartbeatAt
      const heartbeat: ProcessSweepRead = Number.isFinite(heartbeatAge) ? heartbeatAge <= records.heartbeatAllowanceMs : null
      const terminal = terminalRead()
      const closed = terminal === false && heartbeat === false ? 'terminal-gone' : null
      facts.push({
        ...base,
        kind: 'window',
        registrationId: registration.id,
        ownership: binding === 'bound' ? (strangerExe ? false : true) : null,
        sameHome: binding === 'bound' ? registration.configHome === records.configHome : null,
        liveness: liveness({ terminal, registration: heartbeat, owner: false, session: false, work: false, schedules: false, persistence: false }),
        closed,
        graceElapsed: closed === null ? null : heartbeatAge >= records.heartbeatAllowanceMs + records.drainMs,
      })
      continue
    }
    const bundleNamed = row.args.some(arg => /(^|[\\/])mercury\.mjs$/i.test(arg.trim()))
    facts.push({
      ...base,
      kind: kindFromArgs(row.args),
      registrationId: null,
      ownership: strangerExe ? false : bundleNamed ? true : null,
      sameHome: null,
      liveness: liveness({ terminal: terminalRead() }),
      closed: null,
      graceElapsed: null,
    })
  }
  return facts
}

export function readProcessSweepCensus(table: ProcessSweepTable, records: ProcessSweepRecords): ProcessSweepCensus {
  const memory: Record<string, number> = {}
  const entries: ProcessSweepEntry[] = []
  let error = table.error
  try {
    for (const facts of composeProcessSweepFacts(table, records)) {
      const entry = classifyMercuryProcess(facts)
      entries.push(entry)
      if (entry.kind === 'daemon' && facts.closed === 'owner-gone') {
        const key = processSweepIdentityKey(entry)
        memory[key] = records.memory?.[key] ?? records.nowMs
      }
    }
  } catch (caught) {
    error = `the process classifier refused: ${caught instanceof Error ? caught.message : String(caught)}`
    return { readAt: records.nowMs, platform: records.platform, complete: false, error, entries: [], memory: records.memory ?? {}, endings: [] }
  }
  return { readAt: records.nowMs, platform: records.platform, complete: table.complete, ...(error === undefined ? {} : { error }), entries, memory, endings: [] }
}
