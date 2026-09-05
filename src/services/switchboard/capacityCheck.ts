import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { availableCores } from '../../utils/availableCores.js'
import { getGlobalConfig, saveGlobalConfig, isConfigReadingAllowed } from '../../utils/config.js'
import { displayConfigHome } from '../../utils/envUtils.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

export type SeatKind = 'agent' | 'runner'
export const SEAT_COST_BYTES: Readonly<Record<SeatKind, number>> = {
  agent: 32 * 2 ** 20,
  runner: 384 * 2 ** 20,
}
export const SEAT_COST_KIND: SeatKind = 'runner'
export const SEATS_PER_CORE = 2
export const SEAT_FLOOR = 2

const MB = 2 ** 20
const GB = 2 ** 30


export type MemoryRead = 'vm_stat' | 'meminfo' | 'counter' | 'free'

export interface MemorySample {
  availableBytes: number
  totalBytes: number
  read: MemoryRead
}

export function availableFromVmStat(text: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  if (!Number.isFinite(page) || page <= 0) return null
  const pages = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const free = pages('Pages free')
  const inactive = pages('Pages inactive')
  if (free === null || inactive === null) return null
  const speculative = pages('Pages speculative') ?? 0
  const purgeable = pages('Pages purgeable') ?? 0
  return (free + inactive + speculative + purgeable) * page
}

export function availableFromMeminfo(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(text)
  return m ? Number(m[1]) * 1024 : null
}

export function availableFromCounter(bytes: number): number | null {
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
}

export function sampleAvailableMemory(): MemorySample {
  const totalBytes = totalmem()
  const fallback: MemorySample = { availableBytes: freemem(), totalBytes, read: 'free' }
  try {
    if (process.platform === 'darwin') {
      const text = execFileSync('vm_stat', [], { encoding: 'utf8', timeout: 2000, env: { ...subprocessEnv() }, windowsHide: true })
      const available = availableFromVmStat(text)
      return available === null ? fallback : { availableBytes: available, totalBytes, read: 'vm_stat' }
    }
    if (process.platform === 'linux') {
      const available = availableFromMeminfo(readFileSync('/proc/meminfo', 'utf8'))
      return available === null ? fallback : { availableBytes: available, totalBytes, read: 'meminfo' }
    }
    if (process.platform === 'win32') {
      const available = availableFromCounter(freemem())
      return available === null ? fallback : { availableBytes: available, totalBytes, read: 'counter' }
    }
  } catch {
  }
  return fallback
}


export function machineSeatReading(
  cores: number = availableCores(),
  availableBytes: number = sampleAvailableMemory().availableBytes,
  kind: SeatKind = SEAT_COST_KIND,
): number {
  const byCores = Math.floor(cores) * SEATS_PER_CORE
  const byMemory = Math.floor(availableBytes / SEAT_COST_BYTES[kind])
  return Math.max(SEAT_FLOOR, Math.min(byCores, byMemory))
}

export interface SeatReadingSample {
  cores: number
  availableBytes: number
  read: MemoryRead
  sampledAt: number
}

const SAMPLE_TTL_MS = 5_000

let held: { seats: number; sample: SeatReadingSample | null } | null = null
let lastSampledAt = 0
let fixture: { seats: number; sample: SeatReadingSample | null } | null = null
let sampler: (() => { cores: number; availableBytes: number; read: MemoryRead }) | null = null

function freshSample(): SeatReadingSample {
  if (sampler !== null) return { ...sampler(), sampledAt: Date.now() }
  const memory = sampleAvailableMemory()
  return { cores: availableCores(), availableBytes: memory.availableBytes, read: memory.read, sampledAt: Date.now() }
}

export function heldMachineSeatReading(): number {
  return heldMachineSeatFacts().seats
}

export function heldMachineSeatFacts(): { seats: number; sample: SeatReadingSample | null } {
  if (fixture !== null) return fixture
  const now = Date.now()
  if (held === null || now - lastSampledAt >= SAMPLE_TTL_MS) {
    const sample = freshSample()
    lastSampledAt = now
    const seats = machineSeatReading(sample.cores, sample.availableBytes)
    if (held === null || seats >= held.seats) held = { seats, sample }
  }
  return held
}

export function _setHeldMachineSeatReadingForTesting(reading: number | null, sample?: SeatReadingSample): void {
  fixture = reading === null ? null : { seats: reading, sample: sample ?? null }
  if (reading === null) {
    held = null
    lastSampledAt = 0
  }
}

export function _setMemorySamplerForTesting(next: (() => { cores: number; availableBytes: number; read: MemoryRead }) | null): void {
  sampler = next
  held = null
  lastSampledAt = 0
}

export function seatReadingInputsWords(sample: SeatReadingSample): string {
  const gb = sample.availableBytes / GB
  const available = gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)
  return `${sample.cores} core${sample.cores === 1 ? '' : 's'}, ${available} GB available, ${Math.round(SEAT_COST_BYTES[SEAT_COST_KIND] / MB)} MB a seat`
}

export function describeSeatReading(ceiling: number): string {
  const decision = isConfigReadingAllowed() ? getGlobalConfig().switchboardCapacity : undefined
  const stored = decision?.allowed === true ? decision.recommendedSeats : undefined
  if (
    typeof stored === 'number' &&
    Number.isFinite(stored) &&
    Math.max(1, Math.floor(stored)) === ceiling
  ) {
    const askedAt = decision?.askedAt
    const when =
      typeof askedAt === 'number' && Number.isFinite(askedAt) && askedAt > 0
        ? ` from ${new Date(askedAt).toISOString().slice(0, 10)}`
        : ''
    return `the consented capacity reading${when}: ${ceiling} seat${ceiling === 1 ? '' : 's'} (stored at the first-boot ask)`
  }
  const sample = heldMachineSeatFacts().sample
  const inputs = sample !== null ? ` (${seatReadingInputsWords(sample)})` : ''
  return `this machine's reading: ${ceiling} seat${ceiling === 1 ? '' : 's'}${inputs}`
}

export interface CapacityProbe {
  cores: number
  totalMemBytes: number
  availableMemBytes: number
  otherAgentClis: number
}

const AGENT_CLI_NAMES = new Set(['claude', 'mercury', 'codex', 'gemini'])
const SCRIPT_HOSTS = new Set(['node', 'bun', 'deno'])

function basenameOf(token: string): string {
  const clean = token.replace(/"/g, '')
  const cut = clean.lastIndexOf('/')
  return (cut >= 0 ? clean.slice(cut + 1) : clean).toLowerCase()
}

export function looksLikeAgentCli(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0] === undefined) return false
  const exe = basenameOf(tokens[0])
  if (AGENT_CLI_NAMES.has(exe)) return true
  if (!SCRIPT_HOSTS.has(exe)) return false
  return tokens
    .slice(1)
    .filter(t => !t.startsWith('-'))
    .some(t => {
      const base = basenameOf(t)
      const stem = base.replace(/\.(mjs|cjs|js|ts)$/, '')
      return AGENT_CLI_NAMES.has(stem)
    })
}

async function countOtherAgentClis(): Promise<number> {
  try {
    const r =
      process.platform === 'win32'
        ? await execFileNoThrow(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }",
            ],
            { useCwd: false, timeout: 8000 },
          )
        : await execFileNoThrow('ps', ['-axo', 'pid=,command='], {
            useCwd: false,
            timeout: 3000,
          })
    if (r.code !== 0) return 0
    let n = 0
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = Number(m[1])
      if (pid === process.pid || pid === process.ppid) continue
      if (looksLikeAgentCli(m[2]!)) n++
    }
    return n
  } catch {
    return 0
  }
}

export async function probeCapacity(): Promise<CapacityProbe> {
  const memory = sampleAvailableMemory()
  return {
    cores: availableCores(),
    totalMemBytes: memory.totalBytes,
    availableMemBytes: memory.availableBytes,
    otherAgentClis: await countOtherAgentClis(),
  }
}

export function recommendSeats(probe: CapacityProbe): number {
  const reading = machineSeatReading(probe.cores, probe.availableMemBytes)
  return Math.max(SEAT_FLOOR, probe.otherAgentClis >= 2 ? reading - 1 : reading)
}

export function capacityDecisionReceipt(allowed: boolean, recommendedSeats: number): string {
  return allowed
    ? `capacity check done — this machine fits ${recommendedSeats} seats`
    : `no probe — the machine's own reading decides — right now ${recommendedSeats} seats`
}

export function needsCapacityAsk(): boolean {
  return getGlobalConfig().switchboardCapacity === undefined
}

export async function recordCapacityDecision(
  allowed: boolean,
): Promise<{ allowed: boolean; recommendedSeats: number }> {
  if (!allowed) {
    saveGlobalConfig(c => ({
      ...c,
      switchboardCapacity: { askedAt: Date.now(), allowed: false },
    }))
    return { allowed: false, recommendedSeats: heldMachineSeatReading() }
  }
  const recommendedSeats = recommendSeats(await probeCapacity())
  saveGlobalConfig(c => ({
    ...c,
    switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats },
  }))
  return { allowed: true, recommendedSeats }
}

export function resolveSeatCeiling(): number {
  return seatCeilingFacts().seats
}

export type SeatCeilingSource = 'consented' | 'machine'

export interface SeatCeilingFacts {
  seats: number
  source: SeatCeilingSource
  sentence: string
  lever: string
}

export function seatCeilingFacts(): SeatCeilingFacts {
  const decision = isConfigReadingAllowed() ? getGlobalConfig().switchboardCapacity : undefined
  const stored = decision?.allowed === true ? decision.recommendedSeats : undefined
  const consented = typeof stored === 'number' && Number.isFinite(stored)
  const seats = consented ? Math.max(1, Math.floor(stored)) : heldMachineSeatReading()
  return {
    seats,
    source: consented ? 'consented' : 'machine',
    sentence: describeSeatReading(seats),
    lever: seatCeilingLever(),
  }
}

export function seatCeilingLever(): string {
  return `set switchboardCapacity.recommendedSeats in ${displayConfigHome()}/.mercury.json with Mercury closed`
}
