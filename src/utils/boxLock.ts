import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { flagEnv } from '../substrate/flagRegistry.js'
import { lastMemorySample, refreshMemorySample, runtimeMemorySample, type MemoryRead } from '../services/switchboard/capacityCheck.js'
import { commandWords } from './hooks/generatedAssets.js'

export const BOX_LOCK_SCRIPT = 'with-box-lock.sh'

export interface BoxLockHolder {
  slot: number
  pid: number
  label: string
  since: string
  alive: boolean
}

export interface BoxLockWaiter {
  label: string
  waitedS: number
}

export interface BoxLockState {
  dir: string
  holders: BoxLockHolder[]
  waiters: BoxLockWaiter[]
}

export interface BoxLoadReading {
  cores: number
  loadPerCore: number | null
  memory: { availableMb: number; totalMb: number; read: MemoryRead; sampledAtMs: number }
}

export interface BoxReadingV1 extends BoxLoadReading {
  atMs: number
  lock: BoxLockState | null
  lockNote?: string
}

export interface BoxLockWait {
  label: string
  waitedS: number
  slot: string
}

let rememberedDir: string | null = null

export function rememberBoxLockDir(dir: string): void {
  rememberedDir = dir
}

export function boxLockDir(): string | null {
  const pinned = (flagEnv('MERCURY_BOX_LOCK_DIR') ?? '').trim()
  if (pinned !== '') return pinned
  return rememberedDir
}

export function boxLockDirOfScript(scriptPath: string): string | null {
  try {
    return /^BASE=(\/[^\s'"$`\\]+)$/m.exec(readFileSync(scriptPath, 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

export function boxLockScriptOf(words: readonly string[]): string | null {
  for (const word of words) {
    if (basename(word) === BOX_LOCK_SCRIPT) return word
  }
  return null
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function slotNumber(name: string): number | null {
  if (name === 'box.lock') return 1
  const match = /^box\.lock\.(\d+)$/.exec(name)
  return match ? Number(match[1]) : null
}

export function readBoxLockState(dir: string, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): BoxLockState | null {
  if (!existsSync(dir)) return null
  const holders: BoxLockHolder[] = []
  const waiters: BoxLockWaiter[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    const slot = slotNumber(name)
    if (slot === null) continue
    let line = ''
    try {
      line = readFileSync(join(dir, name, 'holder'), 'utf8').trim()
    } catch {
      continue
    }
    const [pidWord, label = '', since = ''] = line.split(/\s+/)
    const pid = Number(pidWord)
    if (!Number.isInteger(pid) || pid <= 0) continue
    holders.push({ slot, pid, label, since, alive: alive(pid) })
  }
  try {
    for (const ticket of readdirSync(join(dir, 'box.queue'))) {
      if (!ticket.endsWith('.ticket')) continue
      const path = join(dir, 'box.queue', ticket)
      let label = ''
      let ageS = 0
      try {
        label = readFileSync(path, 'utf8').trim() || ticket.replace(/^\d+-/, '').replace(/\.ticket$/, '')
        const stamp = /^(\d{16,20})-/.exec(ticket)?.[1]
        const arrivedAtMs = stamp === undefined ? statSync(path).mtimeMs : Number(BigInt(stamp) / 1_000_000n)
        ageS = Math.max(0, Math.round((now - arrivedAtMs) / 1000))
      } catch {
        continue
      }
      waiters.push({ label, waitedS: ageS })
    }
  } catch {
    waiters.length = 0
  }
  holders.sort((a, b) => a.slot - b.slot)
  waiters.sort((a, b) => b.waitedS - a.waitedS)
  return { dir, holders, waiters }
}

export function boxLoadReading(now: number = Date.now()): BoxLoadReading {
  const cores = Math.max(1, cpus().length)
  const load1 = process.platform === 'win32' ? null : (loadavg()[0] ?? null)
  const last = lastMemorySample(now)
  const sample = last?.sample ?? runtimeMemorySample()
  return {
    cores,
    loadPerCore: load1 === null ? null : Math.round((load1 / cores) * 100) / 100,
    memory: {
      availableMb: Math.round(sample.availableBytes / 2 ** 20),
      totalMb: Math.round(sample.totalBytes / 2 ** 20),
      read: sample.read,
      sampledAtMs: last?.sampledAt ?? now,
    },
  }
}

export function refreshBoxReading(): Promise<void> {
  return refreshMemorySample().then(
    () => undefined,
    () => undefined,
  )
}

export function commandNamesBoxLock(command: string): boolean {
  const words = commandWords(command)
  return words !== null && boxLockScriptOf(words) !== null
}

export function boxReading(now: number = Date.now()): BoxReadingV1 {
  const dir = boxLockDir()
  const lock = dir === null ? null : readBoxLockState(dir, now)
  return {
    atMs: now,
    ...boxLoadReading(now),
    lock,
    ...(dir === null
      ? { lockNote: 'no box lock directory is named (MERCURY_BOX_LOCK_DIR) and no with-box-lock.sh command has run in this session' }
      : lock === null
        ? { lockNote: `the box lock directory ${dir} is not there` }
        : {}),
  }
}

const WAIT_RECEIPT = /\[box-lock\] (\S+) holds the box from \S+ \(waited (\d+)s; slot ([^)]+)\)/

export function boxLockWaitOf(text: string): BoxLockWait | null {
  const match = WAIT_RECEIPT.exec(text)
  if (!match) return null
  return { label: match[1]!, waitedS: Number(match[2]), slot: match[3]! }
}

export function boxLockStateWords(state: BoxLockState): string {
  const holders = state.holders.length === 0 ? 'no slot held' : `held by ${state.holders.map(h => `${h.label} (slot ${h.slot}, pid ${h.pid}${h.alive ? '' : ', gone'})`).join(', ')}`
  const waiters = state.waiters.length === 0 ? 'nobody waiting' : `${state.waiters.length} waiting: ${state.waiters.map(w => `${w.label} ${w.waitedS}s`).join(', ')}`
  return `${holders}; ${waiters}`
}

export function boxLoadWords(reading: BoxLoadReading): string {
  const load = reading.loadPerCore === null ? 'load n/a' : `load ${reading.loadPerCore.toFixed(2)}/core`
  return `${load} (${reading.cores} cores), ${reading.memory.availableMb} MB available of ${reading.memory.totalMb}`
}

export function boxLockWaitLine(wait: BoxLockWait, reading: BoxReadingV1, memoryGuard?: string): string {
  const state = reading.lock === null ? (reading.lockNote ?? 'the box lock state is not readable') : boxLockStateWords(reading.lock)
  const guard = memoryGuard === undefined ? '' : `; memory guard: ${memoryGuard}`
  return `Waited ${wait.waitedS} s for the box lock (${wait.label} took ${wait.slot}): ${state}; ${boxLoadWords(reading)}${guard}`
}

export function boxLockLineForCommand(command: string, output: string, options: { cwd: string; memoryGuard?: string; now?: number }): string | null {
  const words = commandWords(command)
  const script = words === null ? null : boxLockScriptOf(words)
  if (script === null) return null
  const dir = boxLockDirOfScript(resolve(options.cwd, script))
  if (dir !== null) rememberBoxLockDir(dir)
  const wait = boxLockWaitOf(output)
  if (wait === null || wait.waitedS === 0) return null
  return boxLockWaitLine(wait, boxReading(options.now), options.memoryGuard)
}
