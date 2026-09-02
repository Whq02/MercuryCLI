// ============================================================================
//  utils/cockpit/deviceHeadroom — HONEST available-memory for the /doctor
//  Device-headroom probe (operator repro: "300MB free · load
//  0.87/core — near the spawn failsafe" WARNING on a healthy Mac while the
//  green gate ran).
//
//  The dishonest gauge: node's os.freemem() reports FREE PAGES ONLY. macOS
//  keeps free pages near zero by design — reclaimable cache (inactive +
//  speculative + purgeable pages) is excluded, so a healthy 16GB Mac
//  chronically reads a few hundred MB "free"; Linux MemFree has the same
//  shape (MemAvailable is the honest kernel answer). Any threshold on
//  freemem() is a standing false alarm — worst exactly when the operator
//  looks (a gate run pushes load past the "busy" modifier).
//
//  The honest metric:
//    darwin — vm_stat: (free + inactive + speculative + purgeable) × pagesize
//    linux  — /proc/meminfo MemAvailable (kernel-computed reclaimable)
//    else   — os.freemem() (the least-wrong fallback), provenance-tagged
//
//  Pure parsers exported for table-tests; the reader caches ~15s (headroom is
//  a slow signal; the doctor board re-probes on demand).
// ============================================================================
import { execFile } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'
import { readFileSync } from 'node:fs'
import { freemem } from 'node:os'

export type Headroom = {
  /** Bytes the system can actually hand to new work without swapping. */
  availableB: number
  /** Where the number came from — shown in the probe's provenance tag. */
  source: 'vm_stat' | 'meminfo' | 'node:os'
}

/** Pure: parse `vm_stat` output → available bytes (free + inactive +
 *  speculative + purgeable, × the page size the header names). Returns null
 *  when the shape is unrecognizable (caller falls back). */
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

/** Pure: parse /proc/meminfo → MemAvailable bytes (null when absent). */
export function parseMemAvailable(text: string): number | null {
  const m = /MemAvailable:\s+(\d+)\s*kB/.exec(text)
  return m ? Number(m[1]) * 1024 : null
}

let cached: { at: number; value: Headroom } | null = null
const CACHE_MS = 15_000

/** The honest available-memory read (cached ~15s). Never throws. */
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
    /* fall back to the freemem() floor — provenance says so */
  }
  cached = { at: Date.now(), value }
  return value
}
