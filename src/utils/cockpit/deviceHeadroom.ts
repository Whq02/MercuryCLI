import { execFile } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'
import { readFileSync } from 'node:fs'
import { freemem } from 'node:os'

export type Headroom = {
  availableB: number
  source: 'vm_stat' | 'meminfo' | 'node:os'
}

export function parseVmStat(text: string): number | null {
  const page = /page size of (\d+) bytes/.exec(text)
  const pageSize = page ? Number(page[1]) : NaN
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  const count = (label: string): number => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(text)
    return m ? Number(m[1]) : 0
  }
  const free = count('Pages free')
  const inactive = count('Pages inactive')
  const speculative = count('Pages speculative')
  const purgeable = count('Pages purgeable')
  if (free === 0 && inactive === 0 && speculative === 0) return null
  return (free + inactive + speculative + purgeable) * pageSize
}

export function parseMemAvailable(text: string): number | null {
  const m = /MemAvailable:\s+(\d+)\s*kB/.exec(text)
  return m ? Number(m[1]) * 1024 : null
}

let cached: { at: number; value: Headroom } | null = null
const CACHE_MS = 15_000

export async function deviceHeadroom(): Promise<Headroom> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  let value: Headroom = { availableB: freemem(), source: 'node:os' }
  try {
    if (process.platform === 'darwin') {
      const text = await new Promise<string>((resolve, reject) => {
        execFile('vm_stat', [], { windowsHide: true, timeout: 2000, env: { ...subprocessEnv() } }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        )
      })
      const available = parseVmStat(text)
      if (available !== null) value = { availableB: available, source: 'vm_stat' }
    } else if (process.platform === 'linux') {
      const available = parseMemAvailable(readFileSync('/proc/meminfo', 'utf8'))
      if (available !== null) value = { availableB: available, source: 'meminfo' }
    }
  } catch {
  }
  cached = { at: Date.now(), value }
  return value
}
