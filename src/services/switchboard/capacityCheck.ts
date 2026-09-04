import { freemem, totalmem } from 'node:os'
import { availableCores } from '../../utils/availableCores.js'
import { getGlobalConfig, saveGlobalConfig, isConfigReadingAllowed } from '../../utils/config.js'
import { displayConfigHome } from '../../utils/envUtils.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'

export function machineSeatReading(
  cores: number = availableCores(),
  freeMemBytes: number = freemem(),
): number {
  const freeGb = freeMemBytes / 2 ** 30
  return Math.max(2, Math.min(Math.floor(cores / 2), Math.floor(freeGb / 2)))
}

let liveReadingHeld: number | null = null

export function heldMachineSeatReading(): number {
  if (liveReadingHeld === null) liveReadingHeld = machineSeatReading()
  return liveReadingHeld
}

export function _setHeldMachineSeatReadingForTesting(reading: number | null): void {
  liveReadingHeld = reading
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
  return `this machine's reading: ${ceiling} seat${ceiling === 1 ? '' : 's'} (cores/memory)`
}

export interface CapacityProbe {
  cores: number
  totalMemBytes: number
  freeMemBytes: number
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
  return {
    cores: availableCores(),
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    otherAgentClis: await countOtherAgentClis(),
  }
}

export function recommendSeats(probe: CapacityProbe): number {
  const reading = machineSeatReading(probe.cores, probe.freeMemBytes)
  return Math.max(2, probe.otherAgentClis >= 2 ? reading - 1 : reading)
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
    return { allowed: false, recommendedSeats: machineSeatReading() }
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
